import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { buildAdjacency, type EdgeLike, pageRank } from "./page-rank.js";

/**
 * 10-node fixture: a linear chain A -> B -> C -> ... -> J with one
 * backedge J -> A, plus a few extra inbound edges pointing at node C
 * so PageRank mass concentrates there. Non-trivial topology with a
 * clear, predictable leader.
 */
function fixture(): readonly EdgeLike[] {
  const nodes = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
  const edges: EdgeLike[] = [];
  // Chain A->B->C->...->J
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i];
    const to = nodes[i + 1];
    if (from && to) edges.push({ fromId: from, toId: to });
  }
  // Backedge
  edges.push({ fromId: "J", toId: "A" });
  // Extra inbound mass to C — E, G, I all also point at C
  edges.push({ fromId: "E", toId: "C" });
  edges.push({ fromId: "G", toId: "C" });
  edges.push({ fromId: "I", toId: "C" });
  return edges;
}

/** Pin the float output as hex so any platform drift fails CI. */
function hexOf(pr: Float64Array): string {
  return Buffer.from(pr.buffer, pr.byteOffset, pr.byteLength).toString("hex");
}

test("pageRank: 10-node fixture — mass concentrates on node C, sums to ~1", () => {
  const adj = buildAdjacency(fixture());
  assert.equal(adj.nodes.length, 10);
  const pr = pageRank(adj);
  const total = pr.reduce((acc, v) => acc + v, 0);
  // Fixed 50 iterations is loose convergence by design (tolerance-
  // based termination is forbidden); the sum stays ~1 within float
  // noise on a balanced graph.
  assert.ok(Math.abs(total - 1) < 1e-6, `pagerank sum should be ~1.0; got ${total}`);
  // C has 4 inbound edges (B->C plus E, G, I -> C); the other nodes
  // have 1 or 2. Leader is C.
  const top = [...pr].map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
  const leader = top[0];
  assert.ok(leader, "leader must exist");
  assert.equal(adj.nodes[leader.i], "C", "C has the most inbound mass");
});

test("pageRank: determinism — two runs produce byte-identical output", () => {
  const adj = buildAdjacency(fixture());
  const a = pageRank(adj);
  const b = pageRank(adj);
  assert.equal(hexOf(a), hexOf(b), "Float64Array hex must match across runs");
});

test("pageRank: determinism snapshot — hex fingerprint is stable", () => {
  // If this hex changes, byte-identity of the kernel has drifted.
  // Investigate: did damping, iteration count, dangling-mass math,
  // or edge iteration order change? NONE of those are allowed to
  // shift without an explicit, documented rev.
  //
  // Captured on V8 (Node 24) from the lifted kernel. Little-endian
  // Float64 bytes for the 10-node PageRank output, in adj.nodes
  // lex order (A..J).
  const adj = buildAdjacency(fixture());
  const pr = pageRank(adj);
  const hex = hexOf(pr);
  // 10 nodes × 8 bytes each = 80 bytes = 160 hex chars
  assert.equal(hex.length, 160);
  const expected =
    "6e8238613d5fa93fa8be1a7d083fad3fdb658ee04abec93fa5badc6544cdc73f8737946bcc26c63fb31878da37abb63fcd58c256c61bb73f1cfb11807d52ab3f44e79c0965e7ae3f89998b6d6cd0a43f";
  assert.equal(hex, expected);
});

test("pageRank: empty graph returns empty Float64Array", () => {
  const adj = buildAdjacency([]);
  const pr = pageRank(adj);
  assert.equal(pr.length, 0);
});

test("buildAdjacency: nodes sorted lex; outAdj preserves edge iteration order", () => {
  const edges: EdgeLike[] = [
    { fromId: "b", toId: "a" },
    { fromId: "b", toId: "c" },
    { fromId: "a", toId: "b" },
  ];
  const adj = buildAdjacency(edges);
  assert.deepEqual(adj.nodes, ["a", "b", "c"]);
  // b -> [a, c] because b->a was inserted before b->c in the edge stream
  const bIdx = adj.nodes.indexOf("b");
  const aIdx = adj.nodes.indexOf("a");
  const cIdx = adj.nodes.indexOf("c");
  assert.deepEqual([...(adj.outAdj[bIdx] ?? [])], [aIdx, cIdx]);
  assert.deepEqual([...(adj.weight[bIdx] ?? [])], [1, 1]);
});

test("buildAdjacency: honors EdgeLike.weight override", () => {
  const edges: EdgeLike[] = [
    { fromId: "a", toId: "b", weight: 3 },
    { fromId: "a", toId: "b", weight: 2 },
  ];
  const adj = buildAdjacency(edges);
  const aIdx = adj.nodes.indexOf("a");
  // Multi-edge weights accumulate: 3 + 2 = 5
  assert.deepEqual([...(adj.weight[aIdx] ?? [])], [5]);
});
