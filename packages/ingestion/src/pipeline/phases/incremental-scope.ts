/**
 * Incremental scope phase.
 *
 * Given a prior-run graph projection ({@link PreviousGraph}) and the current
 * scan output, compute the **import closure** of files whose content hash
 * changed since the last run. Downstream phases can consult this output to
 * narrow their working set — today it is purely **passive**: the phase emits
 * the closure and stats without modifying what crossFile / mro / communities
 * / processes actually process. That's a deliberate v1.0 choice: wiring each
 * downstream phase to honour the closure is invasive and risky for the first
 * iteration. We keep the pipeline observably correct (full reindex always
 * runs) while recording the *intended* savings so a followup can flip the
 * active switch behind a feature flag.
 *
 * ## Algorithm
 *
 * 1. Read `options.incrementalFrom`. If absent, or if `options.force` is set,
 *    emit `mode="full"` covering every scanned file. Bail early.
 * 2. Walk the scan output and compute `changedFiles` = files whose
 *    `contentSha` is unknown to the prior graph OR differs from it. For
 *    content-hash comparison we treat a file that is present in both the
 *    prior `files[]` and the current scan as "unchanged" only when the hash
 *    actually matches. Prior-graph consumers (`analyze.ts`) supply the hash
 *    by reading the persisted scan state; phases that need richer metadata
 *    (e.g. `defines` edges) can extend {@link PreviousGraph} later without a
 *    breaking change here.
 * 3. BFS forward from `changedFiles` along IMPORTS edges to depth 2 (who
 *    *uses* the changed files — "downstream" in consumer sense).
 * 4. BFS backward from `changedFiles` along IMPORTS edges to depth 2 (what
 *    the changed files *use* — "upstream" in producer sense).
 * 5. Take one hop of heritage ancestors + descendants (EXTENDS / IMPLEMENTS)
 *    for each changed file so subtype MROs refresh when a base class moves.
 * 6. If the union exceeds 30% of the current total file count, fall back to
 *    a full reindex (`mode="full"`, `fullReindexBecause="closure-too-large"`).
 *    The safety valve prevents pathological "touched a universally-imported
 *    utility" cases from running an incremental pass that ends up bigger
 *    than a cold build.
 *
 * ## Determinism
 *
 * All emitted arrays (`changedFiles`, `closureFiles`) are sorted
 * alphabetically. The BFS keeps its frontier sorted at every step; visited
 * order has no effect on the final set, but sorting at emission time makes
 * the logs reproducible across runs for the same input.
 */

import type { PipelinePhase, PreviousGraph } from "../types.js";
import type { ScannedFile, ScanOutput } from "./scan.js";
import { SCAN_PHASE_NAME } from "./scan.js";

/** Depth of the forward + backward IMPORTS BFS per the research spec. */
const IMPORTS_BFS_DEPTH = 2;
/** Safety valve threshold. Closure size ratios above this fall back to full. */
const FULL_REINDEX_THRESHOLD = 0.3;

export const INCREMENTAL_SCOPE_PHASE_NAME = "incremental-scope" as const;

/**
 * Output of {@link INCREMENTAL_SCOPE_PHASE_NAME}.
 *
 * `closureFiles` is the canonical set downstream phases should consult. In
 * `mode="full"` it mirrors the full scanned set so a consumer that naively
 * intersects with it keeps the existing cold-run behaviour.
 */
export interface IncrementalScopeOutput {
  readonly mode: "full" | "incremental";
  readonly changedFiles: readonly string[];
  readonly closureFiles: readonly string[];
  /** Set only when `mode === "full"` and a prior graph was supplied. */
  readonly fullReindexBecause?: "no-prior-graph" | "closure-too-large" | "force-flag";
  /** Total scanned file count; recorded so `ratio = closure / total` is reproducible in logs. */
  readonly totalFiles: number;
  /** closureFiles.length / totalFiles, 0 when totalFiles is 0. */
  readonly closureRatio: number;
}

export const incrementalScopePhase: PipelinePhase<IncrementalScopeOutput> = {
  name: INCREMENTAL_SCOPE_PHASE_NAME,
  deps: [SCAN_PHASE_NAME],
  async run(ctx, deps) {
    const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("incremental-scope: scan output missing from dependency map");
    }

    const totalFiles = scan.files.length;
    const allPaths = scan.files.map((f) => f.relPath);
    // The scanned set is already deterministically sorted by `runScan`, but
    // we re-sort defensively: incremental-scope must never trust a caller's
    // ordering invariants for a hot-path output.
    const allSorted = [...allPaths].sort();

    const prior = ctx.options.incrementalFrom;
    const force = ctx.options.force === true;

    if (force) {
      return {
        mode: "full" as const,
        changedFiles: [],
        closureFiles: allSorted,
        fullReindexBecause: "force-flag" as const,
        totalFiles,
        closureRatio: totalFiles === 0 ? 0 : 1,
      };
    }

    if (prior === undefined) {
      return {
        mode: "full" as const,
        changedFiles: [],
        closureFiles: allSorted,
        fullReindexBecause: "no-prior-graph" as const,
        totalFiles,
        closureRatio: totalFiles === 0 ? 0 : 1,
      };
    }

    const changedFiles = computeChangedFiles(scan.files, prior);
    if (changedFiles.length === 0) {
      // No content drift: closure is empty. We still emit mode="incremental"
      // so downstream phases can observe "nothing to do" without inferring
      // it from an ambiguous full-mode marker.
      return {
        mode: "incremental" as const,
        changedFiles: [],
        closureFiles: [],
        totalFiles,
        closureRatio: 0,
      };
    }

    // ---- Build adjacency maps from the prior graph. --------------------
    //
    // `importForward` mirrors the on-graph direction (importer -> target);
    // `importBackward` inverts it so we can walk "who imports me" in one
    // step. Heritage is a single symmetric map because the closure wants
    // both ancestors and descendants in one hop.
    const importForward = new Map<string, string[]>();
    const importBackward = new Map<string, string[]>();
    for (const edge of prior.importEdges) {
      pushIntoBucket(importForward, edge.importer, edge.target);
      pushIntoBucket(importBackward, edge.target, edge.importer);
    }
    const heritage = new Map<string, string[]>();
    for (const edge of prior.heritageEdges) {
      pushIntoBucket(heritage, edge.childFile, edge.parentFile);
      pushIntoBucket(heritage, edge.parentFile, edge.childFile);
    }
    // Sort every adjacency list so BFS frontier order is a pure function
    // of the input graph, regardless of edge insertion order.
    for (const map of [importForward, importBackward, heritage]) {
      for (const [k, v] of map) {
        map.set(k, [...v].sort());
      }
    }

    const closure = new Set<string>(changedFiles);
    bfsBounded(closure, importForward, changedFiles, IMPORTS_BFS_DEPTH);
    bfsBounded(closure, importBackward, changedFiles, IMPORTS_BFS_DEPTH);
    // Heritage is a single-hop expansion per the research algorithm.
    for (const f of changedFiles) {
      const neighbours = heritage.get(f);
      if (neighbours === undefined) continue;
      for (const n of neighbours) closure.add(n);
    }

    // Prune closure to files that still exist in the current scan — a file
    // deleted between runs should not propagate into a re-analysis target.
    const currentSet = new Set(allPaths);
    const pruned = [...closure].filter((f) => currentSet.has(f)).sort();

    const ratio = totalFiles === 0 ? 0 : pruned.length / totalFiles;
    if (ratio > FULL_REINDEX_THRESHOLD) {
      ctx.onProgress?.({
        phase: INCREMENTAL_SCOPE_PHASE_NAME,
        kind: "note",
        message:
          `incremental-scope: closure ${pruned.length}/${totalFiles} ` +
          `(${(ratio * 100).toFixed(1)}%) exceeds ${FULL_REINDEX_THRESHOLD * 100}% threshold — ` +
          `falling back to full reindex`,
      });
      return {
        mode: "full" as const,
        changedFiles: [...changedFiles].sort(),
        closureFiles: allSorted,
        fullReindexBecause: "closure-too-large" as const,
        totalFiles,
        closureRatio: ratio,
      };
    }

    return {
      mode: "incremental" as const,
      changedFiles: [...changedFiles].sort(),
      closureFiles: pruned,
      totalFiles,
      closureRatio: ratio,
    };
  },
};

/**
 * Compute the set of files whose content hash differs from the prior graph.
 *
 * Semantics:
 *  - File present in both and hash matches → unchanged.
 *  - File present in both and hash differs → changed.
 *  - File only in current scan (newly added) → changed.
 *  - File only in prior graph (deleted) → ignored (cannot re-process what
 *    no longer exists; downstream phases must detect deletions through the
 *    upsert pipeline instead).
 */
function computeChangedFiles(
  current: readonly ScannedFile[],
  prior: PreviousGraph,
): readonly string[] {
  const priorHashByPath = new Map<string, string>();
  for (const f of prior.files) priorHashByPath.set(f.relPath, f.contentSha);
  const changed: string[] = [];
  for (const f of current) {
    const priorHash = priorHashByPath.get(f.relPath);
    if (priorHash === undefined || priorHash !== f.sha256) {
      changed.push(f.relPath);
    }
  }
  return changed.sort();
}

/**
 * Breadth-first walk capped at `maxDepth` hops. `closure` accumulates the
 * visited set; starting seeds are assumed to already live in `closure`.
 *
 * The frontier is re-sorted at every depth so BFS visitation order is a
 * deterministic function of the graph, not of Map iteration order.
 */
function bfsBounded(
  closure: Set<string>,
  adj: ReadonlyMap<string, readonly string[]>,
  seeds: readonly string[],
  maxDepth: number,
): void {
  let frontier = [...seeds].sort();
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      const neighbours = adj.get(node);
      if (neighbours === undefined) continue;
      for (const n of neighbours) {
        if (!closure.has(n)) {
          closure.add(n);
          nextFrontier.push(n);
        }
      }
    }
    nextFrontier.sort();
    frontier = nextFrontier;
  }
}

function pushIntoBucket(m: Map<string, string[]>, key: string, value: string): void {
  const existing = m.get(key);
  if (existing === undefined) {
    m.set(key, [value]);
    return;
  }
  existing.push(value);
}
