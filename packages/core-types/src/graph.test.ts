import assert from "node:assert/strict";
import { test } from "node:test";
import { KnowledgeGraph } from "./graph.js";
import { graphHash } from "./graph-hash.js";
import type { NodeId } from "./id.js";
import { makeNodeId } from "./id.js";
import type { GraphNode } from "./nodes.js";

function cls(id: NodeId, extras: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: "Class",
    name: "Foo",
    filePath: "src/a.ts",
    ...extras,
  } as GraphNode;
}

test("addNode: inserts a new node", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("Class", "src/a.ts", "Foo");
  g.addNode(cls(id));
  assert.equal(g.nodeCount(), 1);
  assert.ok(g.hasNode(id));
  assert.equal(g.getNode(id)?.name, "Foo");
});

test("addNode: merges duplicates, keeping more-populated record", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("Class", "src/a.ts", "Foo");
  g.addNode(cls(id));
  g.addNode(cls(id, { startLine: 10, endLine: 42, isExported: true }));
  assert.equal(g.nodeCount(), 1);
  const kept = g.getNode(id);
  assert.equal(kept && "startLine" in kept ? kept.startLine : undefined, 10);
});

test("addNode: keeps the more-populated record when richer arrives first", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("Class", "src/a.ts", "Foo");
  g.addNode(cls(id, { startLine: 10, endLine: 42, isExported: true }));
  g.addNode(cls(id));
  const kept = g.getNode(id);
  assert.equal(kept && "startLine" in kept ? kept.startLine : undefined, 10);
});

test("addEdge: computes id deterministically", () => {
  const g = new KnowledgeGraph();
  const from = makeNodeId("Function", "a.ts", "f");
  const to = makeNodeId("Function", "b.ts", "g");
  g.addEdge({ from, to, type: "CALLS", confidence: 0.9 });
  const out = [...g.edges()];
  assert.equal(out.length, 1);
  const first = out[0];
  assert.ok(first);
  assert.equal(first.id, "Function:a.ts:f->CALLS->Function:b.ts:g:0");
});

test("addEdge: de-dupes by (from, type, to, step), higher confidence wins", () => {
  const g = new KnowledgeGraph();
  const from = makeNodeId("Function", "a.ts", "f");
  const to = makeNodeId("Function", "b.ts", "g");
  g.addEdge({ from, to, type: "CALLS", confidence: 0.5, reason: "tier3" });
  g.addEdge({ from, to, type: "CALLS", confidence: 0.9, reason: "tier2" });
  g.addEdge({ from, to, type: "CALLS", confidence: 0.7, reason: "tier2b" });
  assert.equal(g.edgeCount(), 1);
  const [only] = [...g.edges()];
  assert.ok(only);
  assert.equal(only.confidence, 0.9);
  assert.equal(only.reason, "tier2");
});

test("addEdge: different step values treated as distinct", () => {
  const g = new KnowledgeGraph();
  const from = makeNodeId("Function", "a.ts", "f");
  const to = makeNodeId("Process", "proc", "p");
  g.addEdge({ from, to, type: "PROCESS_STEP", confidence: 1, step: 1 });
  g.addEdge({ from, to, type: "PROCESS_STEP", confidence: 1, step: 2 });
  assert.equal(g.edgeCount(), 2);
});

test("addNode: equal field-count merge is insertion-order independent", () => {
  const id = makeNodeId("Class", "src/a.ts", "Foo");
  // Two records for the same id, each with the same number of defined fields
  // but differing values (startLine 10 vs 99). Before the canonical-JSON
  // tiebreak the first writer won, so A-then-B and B-then-A kept different
  // startLines and produced different graph hashes.
  const a = cls(id, { startLine: 10, endLine: 42 });
  const b = cls(id, { startLine: 99, endLine: 42 });

  const gAB = new KnowledgeGraph();
  gAB.addNode(a);
  gAB.addNode(b);
  const gBA = new KnowledgeGraph();
  gBA.addNode(b);
  gBA.addNode(a);

  assert.equal(graphHash(gAB), graphHash(gBA));
  // The deterministic survivor is the canonically-smaller record (startLine 10).
  const kept = gAB.getNode(id);
  assert.equal(kept && "startLine" in kept ? kept.startLine : undefined, 10);
});

test("addEdge: equal-confidence merge is insertion-order independent", () => {
  const from = makeNodeId("Function", "a.ts", "f");
  const to = makeNodeId("Function", "b.ts", "g");
  // Same (from, type, to, step) and same confidence, but different `reason`.
  // `reason` is serialized into the graph hash, so the survivor must not depend
  // on which writer arrived first.
  const eAlpha = { from, to, type: "CALLS", confidence: 0.7, reason: "alpha" } as const;
  const eBeta = { from, to, type: "CALLS", confidence: 0.7, reason: "beta" } as const;

  const gAB = new KnowledgeGraph();
  gAB.addEdge(eAlpha);
  gAB.addEdge(eBeta);
  const gBA = new KnowledgeGraph();
  gBA.addEdge(eBeta);
  gBA.addEdge(eAlpha);

  assert.equal(graphHash(gAB), graphHash(gBA));
  const [only] = [...gAB.edges()];
  assert.ok(only);
  // Canonically-smaller record wins: "alpha" < "beta".
  assert.equal(only.reason, "alpha");
});

test("orderedNodes / orderedEdges: produce canonical sort", () => {
  const g = new KnowledgeGraph();
  const a = makeNodeId("Function", "a.ts", "a");
  const b = makeNodeId("Function", "a.ts", "b");
  const c = makeNodeId("Function", "a.ts", "c");
  g.addNode({ id: c, kind: "Function", name: "c", filePath: "a.ts" });
  g.addNode({ id: a, kind: "Function", name: "a", filePath: "a.ts" });
  g.addNode({ id: b, kind: "Function", name: "b", filePath: "a.ts" });
  g.addEdge({ from: b, to: c, type: "CALLS", confidence: 1 });
  g.addEdge({ from: a, to: b, type: "CALLS", confidence: 1 });
  const nIds = g.orderedNodes().map((n) => n.id);
  assert.deepEqual(nIds, [a, b, c]);
  const eFrom = g.orderedEdges().map((e) => e.from);
  assert.deepEqual(eFrom, [a, b]);
});
