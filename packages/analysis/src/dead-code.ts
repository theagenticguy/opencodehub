/**
 * Dead-code classification.
 *
 * Partition every callable / type Symbol in the graph into one of three
 * reachability classes:
 *
 *   - `live`                — at least one inbound referrer exists
 *                             (via CALLS / ACCESSES / EXTENDS / IMPLEMENTS
 *                             / METHOD_OVERRIDES / METHOD_IMPLEMENTS /
 *                             REFERENCES).
 *   - `dead`                — non-exported symbol with no inbound referrers.
 *   - `unreachable-export`  — exported symbol whose only inbound referrers
 *                             (if any) live in the same file; no cross-module
 *                             caller exists.
 *
 * A Community (Leiden cluster) whose every member is classified as
 * `dead` or `unreachable-export` is flagged as a *ghost community*.
 *
 * Performance: we batch the whole classification into three SQL passes
 * (candidates + cross-module referrers + community membership) and do
 * everything else in memory, so the phase scales linearly with node count
 * and does not issue one query per symbol.
 */

import type { IGraphStore } from "@opencodehub/storage";

export type Deadness = "live" | "dead" | "unreachable-export";

export interface DeadSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly deadness: "dead" | "unreachable-export";
}

export interface DeadCodeResult {
  /** Classification per Symbol node id. Only Symbol-like kinds are populated. */
  readonly symbols: Readonly<Record<string, Deadness>>;
  /** Sorted list of dead symbols (non-exported, no inbound referrers). */
  readonly dead: readonly DeadSymbol[];
  /** Sorted list of exported symbols with no cross-module referrers. */
  readonly unreachableExports: readonly DeadSymbol[];
  /** Sorted community ids whose members are all non-live. */
  readonly ghostCommunities: readonly string[];
}

/**
 * Relation types whose inbound edges count as "this symbol is referenced".
 *
 * Mirrors `GRAPH_REFERRER_RELATIONS` in `rename.ts`, plus `REFERENCES` so a
 * generic reference edge (e.g. type-only usage on the Python provider) also
 * keeps a symbol alive.
 */
const REFERRER_RELATIONS: readonly string[] = [
  "CALLS",
  "REFERENCES",
  "ACCESSES",
  "EXTENDS",
  "IMPLEMENTS",
  "METHOD_OVERRIDES",
  "METHOD_IMPLEMENTS",
];

/**
 * Node kinds we classify. Files, Folders, Routes, Communities, Processes,
 * Findings, Dependencies, Operations, Contributors, ProjectProfile etc.
 * are explicitly excluded — they are not user-authored "symbols" in the
 * dead-code sense.
 */
const SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "Function",
  "Method",
  "Constructor",
  "Class",
  "Interface",
  "Struct",
  "Trait",
  "TypeAlias",
  "Enum",
]);

export interface SymbolRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly isExported: boolean;
}

export interface ReferrerRow {
  readonly targetId: string;
  readonly sourceFile: string;
}

export interface MembershipRow {
  readonly symbolId: string;
  readonly communityId: string;
}

export async function classifyDeadness(store: IGraphStore): Promise<DeadCodeResult> {
  const symbolRows = await fetchSymbols(store);
  if (symbolRows.length === 0) {
    return { symbols: {}, dead: [], unreachableExports: [], ghostCommunities: [] };
  }

  const ids = symbolRows.map((s) => s.id);
  const [referrerRows, membershipRows] = await Promise.all([
    fetchReferrers(store, ids),
    fetchCommunityMembership(store, ids),
  ]);

  return classifyInMemory(symbolRows, referrerRows, membershipRows);
}

/**
 * Pure in-memory classification core. Used by the storage-backed entry point
 * above as well as the ingestion phase, which supplies graph data directly
 * from the in-memory `KnowledgeGraph` without going through SQL.
 */
export function classifyInMemory(
  symbols: readonly SymbolRow[],
  referrers: readonly ReferrerRow[],
  memberships: readonly MembershipRow[],
): DeadCodeResult {
  // Build a per-target set of referrer source files — we need to distinguish
  // "inbound referrer exists" (any size > 0) from "inbound cross-module
  // referrer exists" (at least one referrer file != target file).
  const referrerFilesByTarget = new Map<string, Set<string>>();
  for (const row of referrers) {
    const bucket = referrerFilesByTarget.get(row.targetId);
    if (bucket !== undefined) {
      bucket.add(row.sourceFile);
    } else {
      referrerFilesByTarget.set(row.targetId, new Set([row.sourceFile]));
    }
  }

  const classification: Record<string, Deadness> = {};
  const dead: DeadSymbol[] = [];
  const unreachableExports: DeadSymbol[] = [];

  for (const sym of symbols) {
    const referrerFiles = referrerFilesByTarget.get(sym.id);
    const hasAnyReferrer = referrerFiles !== undefined && referrerFiles.size > 0;
    let hasCrossModuleReferrer = false;
    if (referrerFiles !== undefined) {
      for (const f of referrerFiles) {
        if (f !== sym.filePath) {
          hasCrossModuleReferrer = true;
          break;
        }
      }
    }

    let verdict: Deadness;
    if (sym.isExported) {
      // Exported: live only when a referrer outside the defining file exists.
      // Intra-file-only referrers mean the module's public surface is still
      // unreachable from the rest of the codebase — flag as unreachable-export.
      verdict = hasCrossModuleReferrer ? "live" : "unreachable-export";
    } else {
      // Non-exported: any referrer keeps it alive; otherwise dead.
      verdict = hasAnyReferrer ? "live" : "dead";
    }
    classification[sym.id] = verdict;

    if (verdict === "dead") {
      dead.push(toDeadSymbol(sym, "dead"));
    } else if (verdict === "unreachable-export") {
      unreachableExports.push(toDeadSymbol(sym, "unreachable-export"));
    }
  }

  // ---- Ghost communities: every member classified non-live. ---------------
  const membersByCommunity = new Map<string, string[]>();
  for (const row of memberships) {
    const bucket = membersByCommunity.get(row.communityId);
    if (bucket !== undefined) bucket.push(row.symbolId);
    else membersByCommunity.set(row.communityId, [row.symbolId]);
  }
  const ghostCommunities: string[] = [];
  for (const [communityId, members] of membersByCommunity) {
    if (members.length === 0) continue;
    let allDead = true;
    for (const m of members) {
      const c = classification[m];
      // Members without a classification (e.g. filtered-out kinds) conservatively
      // count as "alive" so we don't flag communities we haven't evaluated.
      if (c === undefined || c === "live") {
        allDead = false;
        break;
      }
    }
    if (allDead) ghostCommunities.push(communityId);
  }
  ghostCommunities.sort();

  dead.sort(compareDeadSymbol);
  unreachableExports.sort(compareDeadSymbol);

  return {
    symbols: classification,
    dead,
    unreachableExports,
    ghostCommunities,
  };
}

/** Relation types whose inbound edges keep a symbol alive. */
export function referrerRelations(): readonly string[] {
  return REFERRER_RELATIONS;
}

/** Callable / type node kinds classified by the dead-code pass. */
export function symbolKinds(): ReadonlySet<string> {
  return SYMBOL_KINDS;
}

function toDeadSymbol(sym: SymbolRow, deadness: "dead" | "unreachable-export"): DeadSymbol {
  return {
    id: sym.id,
    name: sym.name,
    kind: sym.kind,
    filePath: sym.filePath,
    startLine: sym.startLine,
    deadness,
  };
}

function compareDeadSymbol(a: DeadSymbol, b: DeadSymbol): number {
  const byFile = a.filePath.localeCompare(b.filePath);
  if (byFile !== 0) return byFile;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  return a.id.localeCompare(b.id);
}

async function fetchSymbols(store: IGraphStore): Promise<readonly SymbolRow[]> {
  const kindPlaceholders = [...SYMBOL_KINDS].map(() => "?").join(",");
  const rows = await store.query(
    `SELECT id, name, kind, file_path, start_line, is_exported
       FROM nodes
      WHERE kind IN (${kindPlaceholders})`,
    [...SYMBOL_KINDS],
  );
  const out: SymbolRow[] = [];
  for (const row of rows) {
    const id = String(row["id"] ?? "");
    if (id.length === 0) continue;
    const startRaw = row["start_line"];
    const start = typeof startRaw === "number" && Number.isFinite(startRaw) ? startRaw : 0;
    out.push({
      id,
      name: String(row["name"] ?? ""),
      kind: String(row["kind"] ?? ""),
      filePath: String(row["file_path"] ?? ""),
      startLine: start,
      isExported: row["is_exported"] === true,
    });
  }
  return out;
}

async function fetchReferrers(
  store: IGraphStore,
  ids: readonly string[],
): Promise<readonly ReferrerRow[]> {
  if (ids.length === 0) return [];
  const idPlaceholders = ids.map(() => "?").join(",");
  const typePlaceholders = REFERRER_RELATIONS.map(() => "?").join(",");
  const rows = await store.query(
    `SELECT r.to_id AS target_id, n.file_path AS source_file
       FROM relations r
       JOIN nodes n ON n.id = r.from_id
      WHERE r.to_id IN (${idPlaceholders})
        AND r.type IN (${typePlaceholders})`,
    [...ids, ...REFERRER_RELATIONS],
  );
  const out: ReferrerRow[] = [];
  for (const row of rows) {
    const targetId = String(row["target_id"] ?? "");
    if (targetId.length === 0) continue;
    out.push({
      targetId,
      sourceFile: String(row["source_file"] ?? ""),
    });
  }
  return out;
}

async function fetchCommunityMembership(
  store: IGraphStore,
  ids: readonly string[],
): Promise<readonly MembershipRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await store.query(
    `SELECT from_id AS symbol_id, to_id AS community_id
       FROM relations
      WHERE type = 'MEMBER_OF' AND from_id IN (${placeholders})`,
    [...ids],
  );
  const out: MembershipRow[] = [];
  for (const row of rows) {
    const symbolId = String(row["symbol_id"] ?? "");
    const communityId = String(row["community_id"] ?? "");
    if (symbolId.length === 0 || communityId.length === 0) continue;
    out.push({ symbolId, communityId });
  }
  return out;
}
