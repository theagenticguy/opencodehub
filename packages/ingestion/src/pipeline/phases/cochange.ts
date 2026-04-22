/**
 * Cochange phase — emit `COCHANGES` edges between files that are modified
 * together in the same commit, plus a 2-hop transitive closure.
 *
 * Inputs: the per-commit file manifests already materialised by the
 * temporal phase from its shared `git log --name-status` dump. We do NOT
 * spawn another git subprocess — the budget we care about is measured at
 * the temporal phase level, and re-running the log would double it.
 *
 * Design constraints:
 *   - Symmetric relation: store canonically with `from < to` lexically.
 *     The KnowledgeGraph dedup key is `(from, type, to, step)`, so a
 *     canonical direction gives us one edge per unordered file pair.
 *   - Skip mass-rename / refactor commits: if a single commit touches
 *     more than `maxFilesPerCommit` files it is almost certainly a wide
 *     mechanical edit (rename, format, licence header) rather than
 *     semantic coupling. Emitting O(n²) pairs for such commits both
 *     explodes the graph and pollutes co-change with noise.
 *   - Determinism: pairs iterated in sorted order; confidence rounded to
 *     4 decimals to avoid float-precision drift across platforms.
 *   - `reason` encodes `{hops, coCommitCount}` as JSON so downstream
 *     consumers (MCP context tool, eval harness) can discriminate 1-hop
 *     from 2-hop partners without re-querying.
 */

import { makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { PipelinePhase } from "../types.js";
import { TEMPORAL_PHASE_NAME, type TemporalOutput } from "./temporal.js";

export const COCHANGE_PHASE_NAME = "cochange" as const;

/**
 * Commits that touch more than this many files are treated as
 * mass-rename / mechanical refactors and skipped for co-change emission.
 * The cap is a heuristic — 50 balances catching real cross-file features
 * against dropping sweeping rename commits. Exposed so tests can drive
 * the boundary precisely.
 */
export const DEFAULT_MAX_FILES_PER_COMMIT = 50;

export interface CochangeOptions {
  /** Override the mass-rename threshold. Defaults to {@link DEFAULT_MAX_FILES_PER_COMMIT}. */
  readonly cochangeMaxFilesPerCommit?: number;
}

export interface CochangeOutput {
  readonly edges1hopEmitted: number;
  readonly edges2hopEmitted: number;
  readonly commitsSkipped: number;
  readonly totalCommits: number;
}

export const cochangePhase: PipelinePhase<CochangeOutput> = {
  name: COCHANGE_PHASE_NAME,
  deps: [TEMPORAL_PHASE_NAME],
  async run(ctx, deps) {
    const temporal = deps.get(TEMPORAL_PHASE_NAME) as TemporalOutput | undefined;
    if (temporal === undefined) {
      // Temporal is a hard dep; a missing output means the DAG validator
      // let something through. Fail loudly so ingestion surfaces the bug.
      throw new Error("cochange: temporal output missing from dependency map");
    }

    const opts = ctx.options as CochangeOptions & Record<string, unknown>;
    const maxFilesPerCommit = opts.cochangeMaxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT;

    // When temporal was short-circuited (skipGit, empty history) it emits
    // an empty `commitFileLists`; nothing to do.
    if (temporal.commitFileLists.length === 0) {
      return {
        edges1hopEmitted: 0,
        edges2hopEmitted: 0,
        commitsSkipped: 0,
        totalCommits: 0,
      };
    }

    // ---- 1-hop: pair counts via co-commit ----------------------------
    // Keys canonicalise to `${lower}\u0000${higher}` so a pair only ever
    // lives in one bucket regardless of traversal order.
    const pairCount = new Map<string, number>();
    let commitsSkipped = 0;
    for (const commit of temporal.commitFileLists) {
      const files = commit.files;
      if (files.length < 2) continue;
      if (files.length > maxFilesPerCommit) {
        commitsSkipped += 1;
        continue;
      }
      // `files` is already sorted from temporal.buildCommitFileLists —
      // iterate upper-triangle only so each unordered pair is counted
      // exactly once per commit.
      for (let i = 0; i < files.length; i += 1) {
        const a = files[i] as string;
        for (let j = i + 1; j < files.length; j += 1) {
          const b = files[j] as string;
          // `a < b` is guaranteed because `files` is sorted ascending,
          // but we assert canonical order defensively in case the caller
          // ever passes an unsorted manifest.
          const lo = a < b ? a : b;
          const hi = a < b ? b : a;
          const key = `${lo}\u0000${hi}`;
          pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
      }
    }

    // ---- 1-hop emission ---------------------------------------------
    // Normalize by the max count so confidence lands in [0, 1]. We use
    // `log(count + 1) / log(max + 1)` so a single co-commit still scores
    // positively (important — co-change-of-one is real signal, just weak).
    let maxCount = 0;
    for (const c of pairCount.values()) if (c > maxCount) maxCount = c;
    const logMax = maxCount > 0 ? Math.log(maxCount + 1) : 1;

    // Build a 1-hop adjacency index for the 2-hop pass. `neighbors(a)` is
    // a sorted set of b such that (a, b) co-changed at least once.
    const neighbors = new Map<string, string[]>();
    const add = (a: string, b: string): void => {
      const list = neighbors.get(a);
      if (list === undefined) {
        neighbors.set(a, [b]);
      } else if (!list.includes(b)) {
        list.push(b);
      }
    };

    // Iterate pairs in sorted key order so edge emission is deterministic.
    const sortedPairKeys = [...pairCount.keys()].sort();
    let edges1hopEmitted = 0;
    for (const key of sortedPairKeys) {
      const sep = key.indexOf("\u0000");
      const a = key.slice(0, sep);
      const b = key.slice(sep + 1);
      const count = pairCount.get(key) ?? 0;
      add(a, b);
      add(b, a);
      const confidence = roundConfidence(Math.log(count + 1) / logMax);
      emitCochangeEdge(ctx.graph, a, b, 1, count, confidence);
      edges1hopEmitted += 1;
    }

    // Sort neighbor lists so 2-hop iteration is deterministic.
    for (const [k, v] of neighbors) {
      v.sort();
      neighbors.set(k, v);
    }

    // ---- 2-hop closure (adjacency-list set-union) -------------------
    // For each file a, neighbors_2(a) = ⋃ neighbors_1(b) for b ∈
    // neighbors_1(a), minus {a} and neighbors_1(a) themselves. Emit a
    // COCHANGES edge for each (a, c) pair, canonicalised and de-duped.
    const emitted2hop = new Set<string>();
    let edges2hopEmitted = 0;
    const sortedAnchors = [...neighbors.keys()].sort();
    for (const a of sortedAnchors) {
      const direct = new Set(neighbors.get(a) ?? []);
      // Walk intermediates in sorted order for reproducibility. For each
      // candidate c we compute its confidence from the product of the
      // two hop confidences in `pairCount` — specifically we take the
      // maximum across viable intermediates, since at least one strong
      // bridge is more informative than averaging in weak ones.
      const perCandidate = new Map<string, number>();
      const perCandidateBridges = new Map<string, number>();
      for (const b of [...direct].sort()) {
        const secondHop = neighbors.get(b) ?? [];
        for (const c of secondHop) {
          if (c === a) continue;
          if (direct.has(c)) continue;
          // Score this path via the lower of the two pairCounts — a path
          // is only as strong as its weakest link. We then take the max
          // across candidate paths below.
          const ab = pairCount.get(canonicalKey(a, b)) ?? 0;
          const bc = pairCount.get(canonicalKey(b, c)) ?? 0;
          const pathCount = Math.min(ab, bc);
          const prior = perCandidate.get(c);
          if (prior === undefined || pathCount > prior) {
            perCandidate.set(c, pathCount);
            perCandidateBridges.set(c, (perCandidateBridges.get(c) ?? 0) + 1);
          } else {
            perCandidateBridges.set(c, (perCandidateBridges.get(c) ?? 0) + 1);
          }
        }
      }
      // Emit canonicalised edges (dedupe across a-symmetric iterations).
      const candidateOrder = [...perCandidate.keys()].sort();
      for (const c of candidateOrder) {
        const lo = a < c ? a : c;
        const hi = a < c ? c : a;
        const dedupKey = `${lo}\u0000${hi}`;
        if (emitted2hop.has(dedupKey)) continue;
        emitted2hop.add(dedupKey);
        const pathCount = perCandidate.get(c) ?? 0;
        // Dampen 2-hop confidence vs 1-hop by 0.5 — the edge exists but
        // transitive evidence is weaker than a direct co-commit.
        const base = logMax > 0 ? Math.log(pathCount + 1) / logMax : 0;
        const confidence = roundConfidence(base * 0.5);
        emitCochangeEdge(ctx.graph, lo, hi, 2, pathCount, confidence);
        edges2hopEmitted += 1;
      }
    }

    return {
      edges1hopEmitted,
      edges2hopEmitted,
      commitsSkipped,
      totalCommits: temporal.commitFileLists.length,
    };
  },
};

function canonicalKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function roundConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 10_000) / 10_000;
}

function fileNodeId(relPath: string): NodeId {
  // File-node id scheme matches scan phase: `File:<path>:<path>`.
  return makeNodeId("File", relPath, relPath);
}

function emitCochangeEdge(
  graph: import("@opencodehub/core-types").KnowledgeGraph,
  lowerPath: string,
  higherPath: string,
  hops: 1 | 2,
  coCommitCount: number,
  confidence: number,
): void {
  const from = fileNodeId(lowerPath);
  const to = fileNodeId(higherPath);
  graph.addEdge({
    from,
    to,
    type: "COCHANGES",
    confidence,
    reason: JSON.stringify({ hops, coCommitCount }),
    step: 0,
  });
}
