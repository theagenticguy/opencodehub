/**
 * Per-community SKILL.md generator.
 *
 * Walks `Community` nodes with `symbolCount >= 5` and emits one SKILL.md per
 * cluster under `<repo>/.codehub/skills/<slug>/SKILL.md`. Each file carries a
 * tiny YAML frontmatter (Claude Code skill format) plus a Markdown body listing
 * the cluster label, size, entry points, and a member table (capped at 50).
 *
 * Entry-point rule: members that are also an `entryPointId` on any Process
 * node win — these are the real heads of execution flows. If no such members
 * exist for a community, fall back to the top-5 members by outgoing CALLS
 * degree (most-callers-outbound acts as a proxy for "orchestrator").
 *
 * Slug collisions (two communities with the same keyword label) are resolved
 * by appending `-2`, `-3`, … to the second and later occurrences.
 *
 * This function never aborts analyze. Any per-skill write failure (read-only
 * filesystem, permission denied, disk full) is logged and skipped — we return
 * the count of SKILL.md files successfully emitted.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Minimal store surface used by the generator — satisfied by `DuckDbStore`. */
export interface SkillsGenStore {
  query(
    sql: string,
    params?: readonly (string | number | bigint | boolean | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
}

export interface SkillsGenOptions {
  /** Minimum `symbolCount` for a community to be written out. Default 5. */
  readonly minSymbolCount?: number;
  /** Cap the member table to this many rows. Default 50. */
  readonly maxMembers?: number;
  /** Logger for per-skill failures. Defaults to `console.warn`. */
  readonly log?: (message: string) => void;
}

interface CommunityRow {
  readonly id: string;
  readonly name: string;
  readonly symbolCount: number;
  readonly inferredLabel: string | undefined;
  readonly keywords: readonly string[];
}

interface MemberRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number | undefined;
}

const DEFAULT_MIN_SYMBOLS = 5;
const DEFAULT_MAX_MEMBERS = 50;
const DEFAULT_ENTRY_POINT_LIMIT = 5;

/**
 * Generate SKILL.md files for every significant community in the store.
 *
 * @returns number of SKILL.md files successfully written
 */
export async function generateSkills(
  store: SkillsGenStore,
  repoPath: string,
  opts: SkillsGenOptions = {},
): Promise<number> {
  const minSymbols = opts.minSymbolCount ?? DEFAULT_MIN_SYMBOLS;
  const maxMembers = opts.maxMembers ?? DEFAULT_MAX_MEMBERS;
  const log = opts.log ?? ((m: string) => console.warn(m));

  const communities = await fetchCommunities(store, minSymbols);
  if (communities.length === 0) return 0;

  // Pre-compute the set of Process `entryPointId`s so we can flag Community
  // members that are heads of a detected execution flow. A single round-trip
  // keeps the cost flat regardless of how many communities we walk.
  const entryPointIds = await fetchProcessEntryPointIds(store);

  const skillsDir = join(repoPath, ".codehub", "skills");
  const usedSlugs = new Set<string>();
  let emitted = 0;

  for (const community of communities) {
    try {
      const members = await fetchMembers(store, community.id);
      if (members.length === 0) continue;

      const entryPoints = await selectEntryPoints(store, members, entryPointIds);
      const slug = uniqueSlug(labelForCommunity(community), usedSlugs);
      usedSlugs.add(slug);

      const body = renderSkillMarkdown({
        slug,
        community,
        members: members.slice(0, maxMembers),
        totalMembers: members.length,
        entryPoints,
      });

      const skillDir = join(skillsDir, slug);
      const skillFile = join(skillDir, "SKILL.md");
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillFile, body, "utf8");
      emitted += 1;
    } catch (err) {
      log(`codehub analyze: failed to write SKILL.md for ${community.id}: ${errorMessage(err)}`);
    }
  }

  return emitted;
}

// ----------------------------------------------------------------------------
// Store-facing queries
// ----------------------------------------------------------------------------

async function fetchCommunities(
  store: SkillsGenStore,
  minSymbols: number,
): Promise<readonly CommunityRow[]> {
  const rows = await store.query(
    `SELECT id, name, symbol_count, inferred_label, keywords
       FROM nodes
      WHERE kind = 'Community' AND symbol_count >= ?
      ORDER BY symbol_count DESC, id ASC`,
    [minSymbols],
  );
  const out: CommunityRow[] = [];
  for (const r of rows) {
    const id = String(r["id"] ?? "");
    const name = String(r["name"] ?? "");
    const count = Number(r["symbol_count"] ?? 0);
    if (id.length === 0 || !Number.isFinite(count)) continue;
    const labelRaw = r["inferred_label"];
    const label = typeof labelRaw === "string" && labelRaw.length > 0 ? labelRaw : undefined;
    const keywordsRaw = r["keywords"];
    const keywords = Array.isArray(keywordsRaw)
      ? keywordsRaw.filter((v): v is string => typeof v === "string")
      : [];
    out.push({ id, name, symbolCount: count, inferredLabel: label, keywords });
  }
  return out;
}

async function fetchMembers(store: SkillsGenStore, communityId: string): Promise<MemberRow[]> {
  const rows = await store.query(
    `SELECT n.id, n.name, n.kind, n.file_path, n.start_line
       FROM relations r
       JOIN nodes n ON n.id = r.from_id
      WHERE r.type = 'MEMBER_OF' AND r.to_id = ?
      ORDER BY n.name ASC, n.id ASC`,
    [communityId],
  );
  const out: MemberRow[] = [];
  for (const r of rows) {
    const id = String(r["id"] ?? "");
    if (id.length === 0) continue;
    const startLineRaw = r["start_line"];
    const startLine =
      typeof startLineRaw === "number" && Number.isFinite(startLineRaw)
        ? startLineRaw
        : typeof startLineRaw === "bigint"
          ? Number(startLineRaw)
          : undefined;
    out.push({
      id,
      name: String(r["name"] ?? ""),
      kind: String(r["kind"] ?? ""),
      filePath: String(r["file_path"] ?? ""),
      startLine,
    });
  }
  return out;
}

async function fetchProcessEntryPointIds(store: SkillsGenStore): Promise<ReadonlySet<string>> {
  const rows = await store.query(
    "SELECT entry_point_id FROM nodes WHERE kind = 'Process' AND entry_point_id IS NOT NULL",
  );
  const out = new Set<string>();
  for (const r of rows) {
    const id = r["entry_point_id"];
    if (typeof id === "string" && id.length > 0) out.add(id);
  }
  return out;
}

/**
 * Fetch the top-K members of a community by outgoing CALLS degree. Used as a
 * fallback when no community members are process heads.
 */
async function fetchTopCallersByOutDegree(
  store: SkillsGenStore,
  memberIds: readonly string[],
  limit: number,
): Promise<ReadonlyMap<string, number>> {
  if (memberIds.length === 0) return new Map();
  const placeholders = memberIds.map(() => "?").join(", ");
  const rows = await store.query(
    `SELECT from_id AS id, COUNT(*) AS out_degree
       FROM relations
      WHERE type = 'CALLS' AND from_id IN (${placeholders})
      GROUP BY from_id
      ORDER BY out_degree DESC, from_id ASC
      LIMIT ?`,
    [...memberIds, limit],
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const id = String(r["id"] ?? "");
    if (id.length === 0) continue;
    const degreeRaw = r["out_degree"];
    const degree =
      typeof degreeRaw === "number"
        ? degreeRaw
        : typeof degreeRaw === "bigint"
          ? Number(degreeRaw)
          : 0;
    out.set(id, degree);
  }
  return out;
}

async function selectEntryPoints(
  store: SkillsGenStore,
  members: readonly MemberRow[],
  processEntryPointIds: ReadonlySet<string>,
): Promise<readonly MemberRow[]> {
  // Preferred: members that are the head of a Process. Preserves the name
  // ordering from `fetchMembers` so the output is deterministic.
  const processHeads = members.filter((m) => processEntryPointIds.has(m.id));
  if (processHeads.length > 0) return processHeads.slice(0, DEFAULT_ENTRY_POINT_LIMIT);

  // Fallback: top-K by outgoing CALLS degree.
  const degrees = await fetchTopCallersByOutDegree(
    store,
    members.map((m) => m.id),
    DEFAULT_ENTRY_POINT_LIMIT,
  );
  if (degrees.size === 0) return members.slice(0, DEFAULT_ENTRY_POINT_LIMIT);
  const byId = new Map(members.map((m) => [m.id, m]));
  const ranked: MemberRow[] = [];
  // Iterate degrees in insertion order (already DESC by out_degree, ASC by id
  // from the SQL) so the resulting list is deterministic.
  for (const id of degrees.keys()) {
    const m = byId.get(id);
    if (m !== undefined) ranked.push(m);
  }
  return ranked.slice(0, DEFAULT_ENTRY_POINT_LIMIT);
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

interface RenderInput {
  readonly slug: string;
  readonly community: CommunityRow;
  readonly members: readonly MemberRow[];
  readonly totalMembers: number;
  readonly entryPoints: readonly MemberRow[];
}

function renderSkillMarkdown(input: RenderInput): string {
  const { slug, community, members, totalMembers, entryPoints } = input;
  const label = labelForCommunity(community);
  const description = buildDescription(label, community.keywords);
  const fileCount = new Set(members.map((m) => m.filePath).filter((f) => f.length > 0)).size;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${slug}`);
  lines.push(`description: ${description}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${label}`);
  lines.push("");
  lines.push(
    `This cluster contains ${community.symbolCount} ${pluralize(community.symbolCount, "symbol", "symbols")} ` +
      `in ${fileCount} ${pluralize(fileCount, "file", "files")}.`,
  );
  lines.push("");

  lines.push("## Entry points");
  lines.push("");
  if (entryPoints.length === 0) {
    lines.push("- (no entry points detected)");
  } else {
    for (const ep of entryPoints) {
      const location = formatLocation(ep.filePath, ep.startLine);
      lines.push(`- \`${ep.name}\` — ${location}`);
    }
  }
  lines.push("");

  lines.push("## Members");
  lines.push("");
  lines.push("| Name | Kind | File:Line |");
  lines.push("|---|---|---|");
  for (const m of members) {
    lines.push(`| \`${m.name}\` | ${m.kind} | ${formatLocation(m.filePath, m.startLine)} |`);
  }
  if (totalMembers > members.length) {
    lines.push("");
    lines.push(`_(+${totalMembers - members.length} more members omitted)_`);
  }
  lines.push("");

  return lines.join("\n");
}

function buildDescription(label: string, keywords: readonly string[]): string {
  const base = `${label}.`;
  if (keywords.length === 0) return base;
  return `${base} ${keywords.slice(0, 5).join(", ")}.`;
}

function formatLocation(filePath: string, startLine: number | undefined): string {
  const path = filePath.length > 0 ? filePath : "<unknown>";
  return startLine !== undefined ? `${path}:${startLine}` : path;
}

// ----------------------------------------------------------------------------
// Slug + label helpers
// ----------------------------------------------------------------------------

function labelForCommunity(community: CommunityRow): string {
  if (community.inferredLabel !== undefined && community.inferredLabel.length > 0) {
    return community.inferredLabel;
  }
  if (community.keywords.length > 0) {
    return community.keywords.slice(0, 3).join("-");
  }
  return community.name.length > 0 ? community.name : community.id;
}

/** Lowercase, hyphen-separated, ASCII-only slug — capped at 60 chars. */
export function sanitizeSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "community";
}

function uniqueSlug(label: string, used: ReadonlySet<string>): string {
  const base = sanitizeSlug(label);
  if (!used.has(base)) return base;
  let counter = 2;
  while (used.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

// ----------------------------------------------------------------------------
// Misc
// ----------------------------------------------------------------------------

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export for callers that only want the directory root (matches the path
// analyze.ts constructs so both sides stay in sync).
export function skillsOutputDir(repoPath: string): string {
  return join(repoPath, ".codehub", "skills");
}

// Convenience helper — returns the absolute path of a single SKILL.md for a
// given slug so downstream callers don't re-do the join.
export function skillFilePath(repoPath: string, slug: string): string {
  return join(skillsOutputDir(repoPath), slug, "SKILL.md");
}
