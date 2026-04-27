/**
 * Graph analytics over the derived SCIP edge set — blast radius,
 * reachability closures, strongly-connected components.
 *
 * Port of the POC `scip_graph_poc/materialize.py` algorithms to
 * dependency-free TypeScript. We keep the adjacency in typed arrays so
 * the BFS closures run on the same scale as the Python+NetworkX
 * implementation for ~10k-node repos (OCH's analyze target).
 */

import type { DerivedEdge } from "./derive.js";

export interface BlastMetrics {
  readonly symbol: string;
  readonly inDegree: number;
  readonly outDegree: number;
  readonly pagerank: number;
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
  readonly gamma?: number;
  readonly delta?: number;
  readonly prDamping?: number;
  readonly prIterations?: number;
}

interface Adjacency {
  readonly nodes: string[];
  readonly indexOf: ReadonlyMap<string, number>;
  readonly outAdj: readonly (readonly number[])[];
  readonly inAdj: readonly (readonly number[])[];
  readonly weight: readonly (readonly number[])[];
}

function buildAdjacency(edges: readonly DerivedEdge[]): Adjacency {
  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.caller);
    nodeSet.add(e.callee);
  }
  const nodes = [...nodeSet].sort();
  const indexOf = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n !== undefined) indexOf.set(n, i);
  }

  const outMap: Map<number, Map<number, number>> = new Map();
  for (const e of edges) {
    const u = indexOf.get(e.caller);
    const v = indexOf.get(e.callee);
    if (u === undefined || v === undefined) continue;
    let row = outMap.get(u);
    if (!row) {
      row = new Map();
      outMap.set(u, row);
    }
    row.set(v, (row.get(v) ?? 0) + 1);
  }

  const outAdj: number[][] = nodes.map(() => []);
  const weight: number[][] = nodes.map(() => []);
  const inAdj: number[][] = nodes.map(() => []);
  for (const [u, row] of outMap) {
    for (const [v, w] of row) {
      outAdj[u]?.push(v);
      weight[u]?.push(w);
      inAdj[v]?.push(u);
    }
  }

  return { nodes, indexOf, outAdj, inAdj, weight };
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

function pagerank(adj: Adjacency, damping = 0.85, iterations = 50): Float64Array {
  const n = adj.nodes.length;
  const pr = new Float64Array(n).fill(1 / Math.max(n, 1));
  if (n === 0) return pr;
  const outWeightSum = new Float64Array(n);
  for (let u = 0; u < n; u++) {
    const row = adj.weight[u] ?? [];
    let s = 0;
    for (const w of row) s += w;
    outWeightSum[u] = s;
  }
  const tele = (1 - damping) / n;
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n).fill(tele);
    let dangling = 0;
    for (let u = 0; u < n; u++) {
      if (outWeightSum[u] === 0) dangling += pr[u] ?? 0;
    }
    const danglingShare = (damping * dangling) / n;
    for (let u = 0; u < n; u++) {
      const outs = adj.outAdj[u] ?? [];
      const ws = adj.weight[u] ?? [];
      const s = outWeightSum[u] ?? 0;
      if (s === 0) continue;
      const share = damping * ((pr[u] ?? 0) / s);
      for (let j = 0; j < outs.length; j++) {
        const v = outs[j] ?? 0;
        next[v] = (next[v] ?? 0) + share * (ws[j] ?? 0);
      }
    }
    for (let u = 0; u < n; u++) next[u] = (next[u] ?? 0) + danglingShare;
    for (let u = 0; u < n; u++) pr[u] = next[u] ?? 0;
  }
  return pr;
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
  const gamma = opts.gamma ?? 5;
  const delta = opts.delta ?? 2;

  const adj = buildAdjacency(edges);
  const n = adj.nodes.length;
  const metrics = new Map<string, BlastMetrics>();
  const reachForward: ReachPair[] = [];
  const reachBackward: ReachPair[] = [];
  const sccMembership = new Map<string, { sccId: number; size: number }>();

  if (n === 0) {
    return { nodes: [], metrics, reachForward, reachBackward, sccMembership };
  }

  const pr = pagerank(adj, opts.prDamping, opts.prIterations);
  const scc = stronglyConnectedComponents(adj);

  const fwdReach = new Int32Array(n);
  const bwdReach = new Int32Array(n);

  for (let u = 0; u < n; u++) {
    const fwd = bfsDistances(adj.outAdj, u);
    const bwd = bfsDistances(adj.inAdj, u);
    fwdReach[u] = fwd.size - 1;
    bwdReach[u] = bwd.size - 1;
    const src = adj.nodes[u] ?? "";
    for (const [v, d] of fwd) {
      if (d > 0) reachForward.push({ source: src, target: adj.nodes[v] ?? "", distance: d });
    }
    for (const [v, d] of bwd) {
      if (d > 0) reachBackward.push({ source: src, target: adj.nodes[v] ?? "", distance: d });
    }
  }

  for (let u = 0; u < n; u++) {
    const sym = adj.nodes[u] ?? "";
    const sccEntry = scc[u] ?? { sccId: -1, size: 0 };
    const sccContribution = sccEntry.size > 1 ? sccEntry.size : 0;
    const raw =
      alpha * (fwdReach[u] ?? 0) +
      beta * (bwdReach[u] ?? 0) +
      gamma * (pr[u] ?? 0) * n +
      delta * sccContribution;
    const blast = Math.log1p(raw);
    metrics.set(sym, {
      symbol: sym,
      inDegree: (adj.inAdj[u] ?? []).length,
      outDegree: (adj.outAdj[u] ?? []).length,
      pagerank: pr[u] ?? 0,
      fwdReach: fwdReach[u] ?? 0,
      bwdReach: bwdReach[u] ?? 0,
      sccId: sccEntry.sccId,
      sccSize: sccEntry.size,
      blastScore: blast,
    });
    sccMembership.set(sym, sccEntry);
  }

  return { nodes: [...adj.nodes], metrics, reachForward, reachBackward, sccMembership };
}
