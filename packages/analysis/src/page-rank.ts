/**
 * Request-time PageRank kernel for `@opencodehub/analysis`.
 *
 * Lifted verbatim from `packages/scip-ingest/src/materialize.ts`
 * (AC-M5-2). The algorithm uses fixed iterations + fixed damping —
 * tolerance-based convergence is banned by W-M5-3, because any
 * numerical drift breaks the byte-identity guarantee that the
 * AC-M5-4 skeleton BOM item + future graphHash depend on.
 *
 * The kernel operates on an adjacency-list snapshot built from a
 * stream of directed edges. scip-ingest's `DerivedEdge` is a
 * structural match for `EdgeLike`; any caller that can produce
 * `{fromId, toId, weight?}` can drive it.
 */

/** Shape the PageRank kernel operates on. scip-ingest's DerivedEdge
 *  is a structural match; any caller that can produce {fromId, toId,
 *  weight?} can drive the kernel. */
export interface EdgeLike {
  readonly fromId: string;
  readonly toId: string;
  readonly weight?: number;
}

/** Adjacency-list form used by the PageRank kernel. */
export interface Adjacency {
  readonly nodes: readonly string[];
  readonly outAdj: readonly (readonly number[])[];
  readonly weight: readonly (readonly number[])[];
}

/**
 * Deterministic builder: sorts nodes lex, accumulates multi-edges as
 * integer weights (or honors `EdgeLike.weight` when provided), and
 * preserves the edge iteration order within each outgoing row so the
 * PageRank fold across `outAdj[u]` is reproducible.
 *
 * Preserves the byte-identity of the pre-lift implementation (see
 * `packages/scip-ingest/src/materialize.ts@<lift-commit>` before
 * AC-M5-2).
 */
export function buildAdjacency(edges: readonly EdgeLike[]): Adjacency {
  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.fromId);
    nodeSet.add(e.toId);
  }
  const nodes = [...nodeSet].sort();
  const indexOf = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n !== undefined) indexOf.set(n, i);
  }

  const outMap: Map<number, Map<number, number>> = new Map();
  for (const e of edges) {
    const u = indexOf.get(e.fromId);
    const v = indexOf.get(e.toId);
    if (u === undefined || v === undefined) continue;
    let row = outMap.get(u);
    if (!row) {
      row = new Map();
      outMap.set(u, row);
    }
    row.set(v, (row.get(v) ?? 0) + (e.weight ?? 1));
  }

  const outAdj: number[][] = nodes.map(() => []);
  const weight: number[][] = nodes.map(() => []);
  for (const [u, row] of outMap) {
    for (const [v, w] of row) {
      outAdj[u]?.push(v);
      weight[u]?.push(w);
    }
  }

  return { nodes, outAdj, weight };
}

/**
 * Compute PageRank over a directed, weighted adjacency.
 *
 * Fixed iterations (default 50) and fixed damping (default 0.85) —
 * NO tolerance-based convergence (W-M5-3). Returns a Float64Array
 * indexed by `adj.nodes` order.
 *
 * Dangling-mass distribution: at every iteration, mass held on
 * out-degree-zero nodes is pooled and redistributed uniformly across
 * all n nodes (scaled by damping). The scalar `tele = (1-d)/n`
 * teleport baseline is added to every node's next value.
 */
export function pageRank(adj: Adjacency, damping = 0.85, iterations = 50): Float64Array {
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
