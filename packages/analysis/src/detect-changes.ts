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

import type { ProcessNode } from "@opencodehub/core-types";
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
  // Typed `listNodes({filePath})` replaces a `WHERE file_path = ?
  // AND kind NOT IN ('File','Folder') AND start_line IS NOT NULL AND
  // end_line IS NOT NULL` raw SELECT. The finder narrows to one file at the
  // adapter layer; the kind exclusion + line-presence guard run in JS.
  const nodes = await store.listNodes({ filePath });
  const out: SymbolRow[] = [];
  for (const node of nodes) {
    if (node.kind === "File" || node.kind === "Folder") continue;
    const located = node as { readonly startLine?: unknown; readonly endLine?: unknown };
    const start = Number(located.startLine ?? Number.NaN);
    const end = Number(located.endLine ?? Number.NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
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
  //
  // Typed `listEdgesByType("PROCESS_STEP", {toIds})` replaces the
  // raw `WHERE r.type = 'PROCESS_STEP' AND r.to_id IN (...)` SELECT. The
  // `kind = 'Process'` predicate from the JOIN is enforced when we hydrate
  // the process metadata below.
  const stepEdges = await store.listEdgesByType("PROCESS_STEP", { toIds: symbolIds });
  const candidateProcessIds = Array.from(new Set(stepEdges.map((e) => e.from))).filter(
    (s) => s.length > 0,
  );
  if (candidateProcessIds.length === 0) return [];

  // Typed `listNodes({ids, kinds:["Process"]})` replaces the
  // `WHERE id IN (...) AND kind = 'Process'` lookup.
  const processNodes = await store.listNodes({
    ids: candidateProcessIds,
    kinds: ["Process"],
  });
  if (processNodes.length === 0) return [];

  // Resolve entry-point ids to their file paths in one bulk lookup.
  const entryIds = processNodes
    .map((node) => (node.kind === "Process" ? ((node as ProcessNode).entryPointId ?? "") : ""))
    .filter((s) => s.length > 0);
  const entryMap = new Map<string, string>();
  if (entryIds.length > 0) {
    // Typed `listNodes({ids})` replaces the bulk `WHERE id IN (...)`
    // entry-point file_path lookup.
    const entryNodes = await store.listNodes({ ids: entryIds });
    for (const node of entryNodes) {
      entryMap.set(node.id, node.filePath);
    }
  }

  const out: AffectedProcess[] = [];
  for (const node of processNodes) {
    if (node.kind !== "Process") continue;
    const proc = node as ProcessNode;
    const entryId = proc.entryPointId ?? "";
    const entryPointFile = entryId.length > 0 ? (entryMap.get(entryId) ?? "") : "";
    out.push({ id: proc.id, name: proc.name, entryPointFile });
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
