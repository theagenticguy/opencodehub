/**
 * Graph analytics over the derived SCIP edge set — blast radius,
 * reachability closures, strongly-connected components.
 *
 * Port of the POC `scip_graph_poc/materialize.py` algorithms to
 * dependency-free TypeScript. We keep the adjacency in typed arrays so
 * the BFS closures run on the same scale as the Python+NetworkX
 * implementation for ~10k-node repos (OCH's analyze target).
 *
 * PageRank was lifted to `@opencodehub/analysis/page-rank.ts`
 * (AC-M5-2). It's now a request-time kernel; this file no longer
 * computes per-symbol PageRank during ingest.
 */

import { type Adjacency, buildAdjacency } from "@opencodehub/analysis";
import type { DerivedEdge } from "./derive.js";

export interface BlastMetrics {
  readonly symbol: string;
  readonly inDegree: number;
  readonly outDegree: number;
  readonly fwdReach: number;
  readonly bwdReach: number;
  readonly sccId: number;
  readonly sccSize: number;
  readonly blastScore: number;
}

export interface ReachPair {
  readonly source: string;
  readonly target: string;
  readonly distance: number;
}

export interface MaterializeResult {
  readonly nodes: readonly string[];
  readonly metrics: ReadonlyMap<string, BlastMetrics>;
  readonly reachForward: readonly ReachPair[];
  readonly reachBackward: readonly ReachPair[];
  readonly sccMembership: ReadonlyMap<string, { sccId: number; size: number }>;
}

export interface MaterializeOptions {
  readonly alpha?: number;
  readonly beta?: number;
  readonly delta?: number;
}

/**
 * scip-ingest needs `inAdj` + `indexOf` for SCC + reach-backward,
 * which the public `@opencodehub/analysis` Adjacency contract does
 * not surface. Compute them locally from the public adjacency.
 */
interface LocalAdjacency {
  readonly base: Adjacency;
  readonly indexOf: ReadonlyMap<string, number>;
  readonly inAdj: readonly (readonly number[])[];
}

function enrichAdjacency(adj: Adjacency): LocalAdjacency {
  const indexOf = new Map<string, number>();
  for (let i = 0; i < adj.nodes.length; i++) {
    const n = adj.nodes[i];
    if (n !== undefined) indexOf.set(n, i);
  }
  const inAdj: number[][] = adj.nodes.map(() => []);
  for (let u = 0; u < adj.nodes.length; u++) {
    const outs = adj.outAdj[u] ?? [];
    for (const v of outs) inAdj[v]?.push(u);
  }
  return { base: adj, indexOf, inAdj };
}

function bfsDistances(adj: readonly (readonly number[])[], start: number): Map<number, number> {
  const dist = new Map<number, number>();
  dist.set(start, 0);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    if (u === undefined) break;
    const d = dist.get(u) ?? 0;
    const neigh = adj[u] ?? [];
    for (const v of neigh) {
      if (dist.has(v)) continue;
      dist.set(v, d + 1);
      queue.push(v);
    }
  }
  return dist;
}

/**
 * Tarjan's SCC algorithm — iterative to avoid recursion limits on very
 * long call chains. Returns per-index `{sccId, size}`.
 */
function stronglyConnectedComponents(adj: Adjacency): Array<{ sccId: number; size: number }> {
  const n = adj.nodes.length;
  const index = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n).fill(0);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const assignment: Array<{ sccId: number; size: number }> = new Array(n).fill(null);
  let counter = 0;
  let sccId = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const callStack: Array<{ v: number; iter: number }> = [{ v: root, iter: 0 }];
    while (callStack.length > 0) {
      const top = callStack[callStack.length - 1];
      if (!top) break;
      const { v } = top;
      if (index[v] === -1) {
        index[v] = counter;
        lowlink[v] = counter;
        counter++;
        stack.push(v);
        onStack[v] = 1;
      }
      const outs = adj.outAdj[v] ?? [];
      if (top.iter < outs.length) {
        const w = outs[top.iter++] ?? 0;
        if (index[w] === -1) {
          callStack.push({ v: w, iter: 0 });
        } else if (onStack[w]) {
          lowlink[v] = Math.min(lowlink[v] ?? 0, index[w] ?? 0);
        }
      } else {
        if ((lowlink[v] ?? 0) === (index[v] ?? 0)) {
          const members: number[] = [];
          let w = -1;
          do {
            w = stack.pop() ?? -1;
            if (w < 0) break;
            onStack[w] = 0;
            members.push(w);
          } while (w !== v);
          for (const m of members) assignment[m] = { sccId, size: members.length };
          sccId++;
        }
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          if (parent) lowlink[parent.v] = Math.min(lowlink[parent.v] ?? 0, lowlink[v] ?? 0);
        }
      }
    }
  }
  return assignment;
}

export function materialize(
  edges: readonly DerivedEdge[],
  opts: MaterializeOptions = {},
): MaterializeResult {
  const alpha = opts.alpha ?? 1;
  const beta = opts.beta ?? 1;
  const delta = opts.delta ?? 2;

  // `@opencodehub/analysis` `buildAdjacency` takes EdgeLike
  // (`fromId`/`toId`); DerivedEdge uses `caller`/`callee`. Translate
  // at the boundary — do not mutate DerivedEdge.
  const edgeLikes = edges.map((e) => ({ fromId: e.caller, toId: e.callee }));
  const base = buildAdjacency(edgeLikes);
  const adj = enrichAdjacency(base);
  const n = adj.base.nodes.length;
  const metrics = new Map<string, BlastMetrics>();
  const reachForward: ReachPair[] = [];
  const reachBackward: ReachPair[] = [];
  const sccMembership = new Map<string, { sccId: number; size: number }>();

  if (n === 0) {
    return { nodes: [], metrics, reachForward, reachBackward, sccMembership };
  }

  const scc = stronglyConnectedComponents(adj.base);

  const fwdReach = new Int32Array(n);
  const bwdReach = new Int32Array(n);

  for (let u = 0; u < n; u++) {
    const fwd = bfsDistances(adj.base.outAdj, u);
    const bwd = bfsDistances(adj.inAdj, u);
    fwdReach[u] = fwd.size - 1;
    bwdReach[u] = bwd.size - 1;
    const src = adj.base.nodes[u] ?? "";
    for (const [v, d] of fwd) {
      if (d > 0) reachForward.push({ source: src, target: adj.base.nodes[v] ?? "", distance: d });
    }
    for (const [v, d] of bwd) {
      if (d > 0) reachBackward.push({ source: src, target: adj.base.nodes[v] ?? "", distance: d });
    }
  }

  for (let u = 0; u < n; u++) {
    const sym = adj.base.nodes[u] ?? "";
    const sccEntry = scc[u] ?? { sccId: -1, size: 0 };
    const sccContribution = sccEntry.size > 1 ? sccEntry.size : 0;
    // PageRank term (`gamma * pr * n`) was removed with the lift to
    // @opencodehub/analysis (AC-M5-2). The field was never consumed
    // outside this file; ranking now leans on reach closures + SCC
    // membership until AC-M5-4 reintroduces PageRank at request time.
    const raw = alpha * (fwdReach[u] ?? 0) + beta * (bwdReach[u] ?? 0) + delta * sccContribution;
    const blast = Math.log1p(raw);
    metrics.set(sym, {
      symbol: sym,
      inDegree: (adj.inAdj[u] ?? []).length,
      outDegree: (adj.base.outAdj[u] ?? []).length,
      fwdReach: fwdReach[u] ?? 0,
      bwdReach: bwdReach[u] ?? 0,
      sccId: sccEntry.sccId,
      sccSize: sccEntry.size,
      blastScore: blast,
    });
    sccMembership.set(sym, sccEntry);
  }

  return { nodes: [...adj.base.nodes], metrics, reachForward, reachBackward, sccMembership };
}
