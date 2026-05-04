/**
 * Shared helpers for wiki renderers.
 *
 * Everything here is pure: no LLM calls, no network, no clock. The only side
 * effect is reading from the graph store. Each helper returns structured data
 * the render modules turn into Markdown.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { IGraphStore } from "@opencodehub/storage";

/** Minimal Community row. */
export interface CommunityRow {
  readonly id: string;
  readonly name: string;
  readonly inferredLabel: string;
  readonly symbolCount: number;
  readonly cohesion: number;
  readonly truckFactor: number | undefined;
}

/** Member file of a community plus an aggregate symbol count. */
export interface CommunityMemberFile {
  readonly filePath: string;
  readonly memberCount: number;
}

/** Ranked contributor for a community (derived from OWNED_BY edges). */
export interface CommunityContributor {
  readonly contributorId: string;
  readonly name: string;
  readonly emailHash: string;
  readonly emailPlain: string;
  readonly lineShare: number;
}

export interface RouteRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly method: string;
  readonly handlerFilePath: string;
}

export interface OperationRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly method: string;
  readonly summary: string;
  readonly filePath: string;
}

export interface FetchesRow {
  readonly fromFilePath: string;
  readonly fromName: string;
  readonly toUrl: string;
}

export interface DependencyRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly license: string;
  readonly lockfileSource: string;
  readonly usageCount: number;
}

export interface OwnershipEntry {
  readonly contributorId: string;
  readonly name: string;
  readonly emailHash: string;
  readonly emailPlain: string;
  readonly lineShare: number;
}

export interface DeadFunctionRow {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
  readonly deadness: string;
}

export interface OrphanFileRow {
  readonly id: string;
  readonly filePath: string;
  readonly orphanGrade: string;
}

export interface ProjectProfileSummary {
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly apiContracts: readonly string[];
  readonly iacTypes: readonly string[];
}

/** Best-effort string coercion for DuckDB rows. */
export function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return v.toString();
  return "";
}

export function num(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function maybeNum(row: Record<string, unknown>, key: string): number | undefined {
  const v = row[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

function parseJsonArray(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export async function loadCommunities(store: IGraphStore): Promise<readonly CommunityRow[]> {
  try {
    const rows = await store.query(
      `SELECT id, name, inferred_label, symbol_count, cohesion, truck_factor
         FROM nodes
        WHERE kind = 'Community'
        ORDER BY id`,
    );
    return rows.map((row) => ({
      id: str(row, "id"),
      name: str(row, "name"),
      inferredLabel: str(row, "inferred_label"),
      symbolCount: num(row, "symbol_count"),
      cohesion: num(row, "cohesion"),
      truckFactor: maybeNum(row, "truck_factor"),
    }));
  } catch {
    return [];
  }
}

/**
 * Top files in a community, ranked by the number of member symbols whose File
 * resolves to that path. Relies on the MEMBER_OF edge between a symbol and the
 * community node.
 */
export async function loadCommunityTopFiles(
  store: IGraphStore,
  communityId: string,
  limit: number,
): Promise<readonly CommunityMemberFile[]> {
  try {
    const rows = await store.query(
      `SELECT n.file_path AS file_path, COUNT(*) AS member_count
         FROM relations r
         JOIN nodes n ON n.id = r.from_id
        WHERE r.type = 'MEMBER_OF' AND r.to_id = ?
        GROUP BY n.file_path
        ORDER BY member_count DESC, n.file_path ASC
        LIMIT ?`,
      [communityId, limit],
    );
    return rows.map((row) => ({
      filePath: str(row, "file_path"),
      memberCount: num(row, "member_count"),
    }));
  } catch {
    return [];
  }
}

/**
 * Top contributors for a community, ranked by summed OWNED_BY edge weight
 * across the community's File members.
 */
export async function loadCommunityTopContributors(
  store: IGraphStore,
  communityId: string,
  limit: number,
): Promise<readonly CommunityContributor[]> {
  try {
    const rows = await store.query(
      `SELECT c.id AS id,
              c.name AS name,
              c.email_hash AS email_hash,
              c.email_plain AS email_plain,
              SUM(o.confidence) AS line_share
         FROM relations m
         JOIN nodes f ON f.id = m.from_id AND f.kind = 'File'
         JOIN relations o ON o.from_id = f.id AND o.type = 'OWNED_BY'
         JOIN nodes c ON c.id = o.to_id AND c.kind = 'Contributor'
        WHERE m.type = 'MEMBER_OF' AND m.to_id = ?
        GROUP BY c.id, c.name, c.email_hash, c.email_plain
        ORDER BY line_share DESC, c.id ASC
        LIMIT ?`,
      [communityId, limit],
    );
    return rows.map((row) => ({
      contributorId: str(row, "id"),
      name: str(row, "name"),
      emailHash: str(row, "email_hash"),
      emailPlain: str(row, "email_plain"),
      lineShare: num(row, "line_share"),
    }));
  } catch {
    return [];
  }
}

export async function loadProjectProfile(
  store: IGraphStore,
): Promise<ProjectProfileSummary | undefined> {
  try {
    const rows = await store.query(
      `SELECT languages_json, frameworks_json, api_contracts_json, iac_types_json
         FROM nodes
        WHERE kind = 'ProjectProfile'
        LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      languages: parseJsonArray(row["languages_json"]),
      frameworks: parseJsonArray(row["frameworks_json"]),
      apiContracts: parseJsonArray(row["api_contracts_json"]),
      iacTypes: parseJsonArray(row["iac_types_json"]),
    };
  } catch {
    return undefined;
  }
}

export async function loadRoutes(store: IGraphStore): Promise<readonly RouteRow[]> {
  try {
    const rows = await store.query(
      `SELECT r.id AS id,
              r.name AS name,
              r.url AS url,
              r.method AS method,
              MIN(handler.file_path) AS file_path
         FROM nodes r
         LEFT JOIN relations hr ON hr.to_id = r.id AND hr.type = 'HANDLES_ROUTE'
         LEFT JOIN nodes handler ON handler.id = hr.from_id
        WHERE r.kind = 'Route'
        GROUP BY r.id, r.name, r.url, r.method
        ORDER BY r.url ASC, r.method ASC, r.id ASC`,
    );
    return rows.map((row) => ({
      id: str(row, "id"),
      name: str(row, "name"),
      url: str(row, "url"),
      method: str(row, "method"),
      handlerFilePath: str(row, "file_path"),
    }));
  } catch {
    return [];
  }
}

export async function loadOperations(store: IGraphStore): Promise<readonly OperationRow[]> {
  try {
    const rows = await store.query(
      `SELECT id, name, http_path, http_method, summary, file_path
         FROM nodes
        WHERE kind = 'Operation'
        ORDER BY http_path ASC, http_method ASC, id ASC`,
    );
    return rows.map((row) => ({
      id: str(row, "id"),
      name: str(row, "name"),
      path: str(row, "http_path"),
      method: str(row, "http_method"),
      summary: str(row, "summary"),
      filePath: str(row, "file_path"),
    }));
  } catch {
    return [];
  }
}

export async function loadFetches(store: IGraphStore): Promise<readonly FetchesRow[]> {
  try {
    const rows = await store.query(
      `SELECT from_n.file_path AS from_file,
              from_n.name AS from_name,
              to_n.url AS to_url
         FROM relations r
         JOIN nodes from_n ON from_n.id = r.from_id
         JOIN nodes to_n ON to_n.id = r.to_id
        WHERE r.type = 'FETCHES'
        ORDER BY to_n.url ASC, from_n.file_path ASC, from_n.name ASC`,
    );
    return rows.map((row) => ({
      fromFilePath: str(row, "from_file"),
      fromName: str(row, "from_name"),
      toUrl: str(row, "to_url"),
    }));
  } catch {
    return [];
  }
}

export async function loadDependencies(store: IGraphStore): Promise<readonly DependencyRow[]> {
  try {
    const rows = await store.query(
      `SELECT d.id AS id,
              d.name AS name,
              d.version AS version,
              d.ecosystem AS ecosystem,
              d.license AS license,
              d.lockfile_source AS lockfile_source,
              COUNT(r.id) AS usage_count
         FROM nodes d
         LEFT JOIN relations r ON r.to_id = d.id AND r.type = 'DEPENDS_ON'
        WHERE d.kind = 'Dependency'
        GROUP BY d.id, d.name, d.version, d.ecosystem, d.license, d.lockfile_source
        ORDER BY d.name ASC, d.version ASC, d.id ASC`,
    );
    return rows.map((row) => ({
      id: str(row, "id"),
      name: str(row, "name"),
      version: str(row, "version"),
      ecosystem: str(row, "ecosystem"),
      license: str(row, "license"),
      lockfileSource: str(row, "lockfile_source"),
      usageCount: num(row, "usage_count"),
    }));
  } catch {
    return [];
  }
}

export async function loadDeadFunctions(store: IGraphStore): Promise<readonly DeadFunctionRow[]> {
  try {
    const rows = await store.query(
      `SELECT id, name, file_path, start_line, end_line, deadness
         FROM nodes
        WHERE deadness IN ('dead', 'unreachable-export')
        ORDER BY file_path ASC, start_line ASC, id ASC`,
    );
    return rows.map((row) => ({
      id: str(row, "id"),
      name: str(row, "name"),
      filePath: str(row, "file_path"),
      startLine: maybeNum(row, "start_line"),
      endLine: maybeNum(row, "end_line"),
      deadness: str(row, "deadness"),
    }));
  } catch {
    return [];
  }
}

export async function loadOrphanFiles(store: IGraphStore): Promise<readonly OrphanFileRow[]> {
  try {
    const rows = await store.query(
      `SELECT id, file_path, orphan_grade
         FROM nodes
        WHERE kind = 'File' AND orphan_grade IS NOT NULL AND orphan_grade <> 'active'
        ORDER BY file_path ASC, id ASC`,
    );
    return rows.map((row) => ({
      id: str(row, "id"),
      filePath: str(row, "file_path"),
      orphanGrade: str(row, "orphan_grade"),
    }));
  } catch {
    return [];
  }
}

/**
 * Build a URL-safe slug for a filename. Collapses non-alphanumeric runs into
 * single dashes, lower-cases, trims. A colliding slug is disambiguated by the
 * caller using a short hash suffix.
 */
export function slugify(raw: string): string {
  const lower = raw.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9]+/g, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  return trimmed.length > 0 ? trimmed : "untitled";
}

/**
 * Stable short hash for disambiguating slug collisions. Not cryptographic — we
 * just want two different ids to land in two different 6-char buckets.
 */
export function shortHash(input: string): string {
  // djb2
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Unsigned 32-bit hex.
  const unsigned = h >>> 0;
  return unsigned.toString(16).padStart(8, "0").slice(0, 6);
}

export function escapePipe(raw: string): string {
  return raw.replace(/\|/g, "\\|");
}

export function contributorDisplay(c: {
  readonly name: string;
  readonly emailPlain: string;
  readonly emailHash: string;
}): string {
  const name = c.name.length > 0 ? c.name : "unknown";
  const handle = c.emailPlain.length > 0 ? c.emailPlain : `sha256:${c.emailHash.slice(0, 10)}`;
  return `${name} <${handle}>`;
}
