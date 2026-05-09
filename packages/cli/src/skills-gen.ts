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
import type { CommunityNode, NodeId } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";

/**
 * Minimal store surface used by the generator. Aliased to {@link IGraphStore}
 * so cli/skills-gen always operates through the typed-finder surface — no
 * raw SQL escape hatch. Tests can supply a partial mock that implements just
 * the four finders this generator calls.
 */
export type SkillsGenStore = Pick<
  IGraphStore,
  "listNodesByKind" | "listNodes" | "listNodesByEntryPoint" | "listEdgesByType"
>;

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
  // `listNodesByKind('Community')` returns the typed `CommunityNode` shape
  // with `symbolCount`, `inferredLabel`, and `keywords` already rehydrated.
  // Filter + sort in TS — the typed finder only paginates on `(id ASC)`,
  // not on a derived metric like `symbolCount`. `symbolCount` is optional
  // on `CommunityNode` so we coerce missing values to 0 (treating an
  // un-populated community as below the minimum).
  const all = (await store.listNodesByKind("Community")) as readonly CommunityNode[];
  const filtered = all
    .map((c) => ({ c, count: c.symbolCount ?? 0 }))
    .filter(({ count }) => count >= minSymbols)
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
    });
  const out: CommunityRow[] = [];
  for (const { c, count } of filtered) {
    if (c.id.length === 0 || !Number.isFinite(count)) continue;
    const label =
      typeof c.inferredLabel === "string" && c.inferredLabel.length > 0
        ? c.inferredLabel
        : undefined;
    out.push({
      id: c.id,
      name: c.name,
      symbolCount: count,
      inferredLabel: label,
      keywords: c.keywords ?? [],
    });
  }
  return out;
}

async function fetchMembers(store: SkillsGenStore, communityId: string): Promise<MemberRow[]> {
  // MEMBER_OF edges have the symbol on `from` and the Community on `to`.
  const edges = await store.listEdgesByType("MEMBER_OF", { toIds: [communityId] });
  if (edges.length === 0) return [];
  const fromIds = Array.from(new Set(edges.map((e) => e.from)));
  const nodes = await store.listNodes({ ids: fromIds });
  const rows: MemberRow[] = [];
  for (const n of nodes) {
    const startLineRaw = (n as unknown as { startLine?: number }).startLine;
    const startLine =
      typeof startLineRaw === "number" && Number.isFinite(startLineRaw) ? startLineRaw : undefined;
    rows.push({
      id: n.id,
      name: n.name,
      kind: n.kind,
      filePath: n.filePath,
      startLine,
    });
  }
  // Match prior `ORDER BY n.name ASC, n.id ASC`.
  rows.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

async function fetchProcessEntryPointIds(store: SkillsGenStore): Promise<ReadonlySet<string>> {
  const processes = await store.listNodesByKind("Process");
  const out = new Set<string>();
  for (const p of processes) {
    const entryPointId = (p as unknown as { entryPointId?: unknown }).entryPointId;
    if (typeof entryPointId === "string" && entryPointId.length > 0) out.add(entryPointId);
  }
  return out;
}

/**
 * Fetch the top-K members of a community by outgoing CALLS degree. Used as a
 * fallback when no community members are process heads. Computes the
 * `GROUP BY from_id COUNT(*)` aggregate in TS over the typed-finder edges
 * — the legacy SQL pushed it down to DuckDB, but `listEdgesByType` already
 * narrows to one type so the reduction is bounded by community size.
 */
async function fetchTopCallersByOutDegree(
  store: SkillsGenStore,
  memberIds: readonly string[],
  limit: number,
): Promise<ReadonlyMap<string, number>> {
  if (memberIds.length === 0) return new Map();
  const ids = memberIds as readonly NodeId[];
  const edges = await store.listEdgesByType("CALLS", { fromIds: ids });
  const counts = new Map<string, number>();
  for (const e of edges) counts.set(e.from, (counts.get(e.from) ?? 0) + 1);
  // Match prior `ORDER BY out_degree DESC, from_id ASC LIMIT ?`.
  const sorted = Array.from(counts.entries()).sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return new Map(sorted.slice(0, limit));
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
