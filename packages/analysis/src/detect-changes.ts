/**
 * Map a git diff back onto the graph: find the symbols whose source spans
 * overlap any changed hunk, then fan out over PROCESS_STEP edges to the
 * business-process nodes those symbols anchor.
 *
 * Everything git-related lives in `git.ts` so this module stays pure-ish:
 * it takes a `scope` and asks for the changed file list + per-file hunk
 * ranges, then issues two SQL queries per changed file (symbols + process
 * edges). No string interpolation of user values into SQL — all params
 * flow through the prepared-statement binder on `IGraphStore.query`.
 */

import type { IGraphStore } from "@opencodehub/storage";
import { gitDiffHunks, gitDiffNames } from "./git.js";
import { riskFromCount } from "./risk.js";
import type {
  AffectedProcess,
  AffectedSymbol,
  ChangedHunk,
  DetectChangesQuery,
  DetectChangesResult,
} from "./types.js";

interface SymbolRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Build the argv pair (`--name-only args`, `-U0 args`) for a scope. We keep
 * these paired so the name list and the hunk list always refer to the same
 * git operation. `all` is the union of unstaged + staged — we run both
 * passes and merge.
 */
function gitArgsForScope(q: DetectChangesQuery): readonly (readonly string[])[] {
  switch (q.scope) {
    case "unstaged":
      return [[]];
    case "staged":
      return [["--cached"]];
    case "all":
      return [[], ["--cached"]];
    case "compare":
      if (!q.compareRef || q.compareRef.length === 0) {
        return [];
      }
      return [[q.compareRef]];
  }
}

async function collectChanges(q: DetectChangesQuery): Promise<{
  readonly files: readonly string[];
  readonly hunks: ReadonlyMap<string, readonly ChangedHunk[]>;
}> {
  const argsList = gitArgsForScope(q);
  const fileSet = new Set<string>();
  const hunkMap = new Map<string, ChangedHunk[]>();
  for (const args of argsList) {
    const [names, hunks] = await Promise.all([
      gitDiffNames(q.repoPath, args),
      gitDiffHunks(q.repoPath, args),
    ]);
    for (const f of names) fileSet.add(f);
    for (const [f, list] of hunks) {
      const bucket = hunkMap.get(f) ?? [];
      bucket.push(...list);
      hunkMap.set(f, bucket);
    }
  }
  // Freeze the hunk map into readonly views.
  const out = new Map<string, readonly ChangedHunk[]>();
  for (const [k, v] of hunkMap) out.set(k, v);
  return { files: [...fileSet].sort(), hunks: out };
}

function hunkOverlaps(
  startLine: number,
  endLine: number,
  hunks: readonly ChangedHunk[],
): readonly number[] {
  const touched: number[] = [];
  for (const h of hunks) {
    const hunkStart = h.start;
    // A zero-count hunk represents a pure deletion at `start`; treat it as
    // a single-line marker so deletions still register against the nearest
    // containing symbol.
    const hunkEnd = h.count === 0 ? h.start : h.start + h.count - 1;
    if (hunkEnd < startLine || hunkStart > endLine) continue;
    const overlapStart = Math.max(startLine, hunkStart);
    const overlapEnd = Math.min(endLine, hunkEnd);
    for (let ln = overlapStart; ln <= overlapEnd; ln += 1) {
      touched.push(ln);
    }
  }
  return touched;
}

async function symbolsForFile(store: IGraphStore, filePath: string): Promise<readonly SymbolRow[]> {
  const rows = await store.query(
    `SELECT id, name, kind, file_path, start_line, end_line
       FROM nodes
      WHERE file_path = ? AND kind NOT IN ('File', 'Folder')
        AND start_line IS NOT NULL AND end_line IS NOT NULL`,
    [filePath],
  );
  const out: SymbolRow[] = [];
  for (const row of rows) {
    const start = Number(row["start_line"] ?? Number.NaN);
    const end = Number(row["end_line"] ?? Number.NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      id: String(row["id"] ?? ""),
      name: String(row["name"] ?? ""),
      kind: String(row["kind"] ?? ""),
      filePath: String(row["file_path"] ?? ""),
      startLine: start,
      endLine: end,
    });
  }
  return out;
}

async function processesForSymbols(
  store: IGraphStore,
  symbolIds: readonly string[],
): Promise<readonly AffectedProcess[]> {
  if (symbolIds.length === 0) return [];

  // PROCESS_STEP edges connect a Process node to each symbol that
  // participates in the process. Find the set of distinct Process ids that
  // have an edge into any of the affected symbols.
  const placeholders = symbolIds.map(() => "?").join(",");
  const rows = await store.query(
    `SELECT DISTINCT r.from_id AS process_id
       FROM relations r
       JOIN nodes p ON p.id = r.from_id
      WHERE r.type = 'PROCESS_STEP'
        AND p.kind = 'Process'
        AND r.to_id IN (${placeholders})`,
    symbolIds,
  );
  const processIds = rows.map((row) => String(row["process_id"] ?? "")).filter((s) => s.length > 0);
  if (processIds.length === 0) return [];

  const idPlaceholders = processIds.map(() => "?").join(",");
  const processRows = await store.query(
    `SELECT id, name, entry_point_id FROM nodes
      WHERE id IN (${idPlaceholders}) AND kind = 'Process'`,
    processIds,
  );
  // Resolve entry-point ids to their file paths in one bulk lookup.
  const entryIds = processRows
    .map((row) => String(row["entry_point_id"] ?? ""))
    .filter((s) => s.length > 0);
  const entryMap = new Map<string, string>();
  if (entryIds.length > 0) {
    const uniq = Array.from(new Set(entryIds));
    const ePlaceholders = uniq.map(() => "?").join(",");
    const entryRows = await store.query(
      `SELECT id, file_path FROM nodes WHERE id IN (${ePlaceholders})`,
      uniq,
    );
    for (const e of entryRows) {
      entryMap.set(String(e["id"] ?? ""), String(e["file_path"] ?? ""));
    }
  }

  const out: AffectedProcess[] = [];
  for (const row of processRows) {
    const id = String(row["id"] ?? "");
    const name = String(row["name"] ?? "");
    const entryId = String(row["entry_point_id"] ?? "");
    const entryPointFile = entryMap.get(entryId) ?? "";
    out.push({ id, name, entryPointFile });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function runDetectChanges(
  store: IGraphStore,
  q: DetectChangesQuery,
): Promise<DetectChangesResult> {
  if (q.scope === "compare" && (!q.compareRef || q.compareRef.length === 0)) {
    return {
      changedFiles: [],
      affectedSymbols: [],
      affectedProcesses: [],
      summary: { fileCount: 0, symbolCount: 0, processCount: 0, risk: "LOW" },
    };
  }

  const { files, hunks } = await collectChanges(q);
  const affectedSymbols: AffectedSymbol[] = [];

  for (const file of files) {
    const fileHunks = hunks.get(file) ?? [];
    if (fileHunks.length === 0) continue;
    const symbols = await symbolsForFile(store, file);
    for (const sym of symbols) {
      const touched = hunkOverlaps(sym.startLine, sym.endLine, fileHunks);
      if (touched.length === 0) continue;
      affectedSymbols.push({
        id: sym.id,
        name: sym.name,
        filePath: sym.filePath,
        kind: sym.kind,
        changedLines: touched,
      });
    }
  }

  affectedSymbols.sort((a, b) => {
    const byFile = a.filePath.localeCompare(b.filePath);
    if (byFile !== 0) return byFile;
    return a.id.localeCompare(b.id);
  });

  const processes = await processesForSymbols(
    store,
    affectedSymbols.map((s) => s.id),
  );

  return {
    changedFiles: files,
    affectedSymbols,
    affectedProcesses: processes,
    summary: {
      fileCount: files.length,
      symbolCount: affectedSymbols.length,
      processCount: processes.length,
      risk: riskFromCount(affectedSymbols.length),
    },
  };
}
