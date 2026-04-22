import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeRelation } from "./edges.js";
import type { EdgeId, NodeId } from "./id.js";
import type { GraphNode } from "./nodes.js";
import { compareNodesById, sortEdges, sortNodes } from "./ordering.js";

function makeFunctionNode(id: string): GraphNode {
  return {
    id: id as NodeId,
    kind: "Function",
    name: id.split(":").pop() ?? "anon",
    filePath: "src/x.ts",
  };
}

function makeEdge(from: string, type: CodeRelation["type"], to: string, step = 0): CodeRelation {
  return {
    id: `${from}->${type}->${to}:${step}` as EdgeId,
    from: from as NodeId,
    to: to as NodeId,
    type,
    confidence: 1,
    step,
  };
}

function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = a[i];
    const other = a[j];
    if (tmp !== undefined && other !== undefined) {
      a[i] = other;
      a[j] = tmp;
    }
  }
  return a;
}

test("compareNodesById: ASCII compare by id", () => {
  const a = makeFunctionNode("Function:a.ts:alpha");
  const b = makeFunctionNode("Function:a.ts:beta");
  assert.ok(compareNodesById(a, b) < 0);
  assert.ok(compareNodesById(b, a) > 0);
  assert.equal(compareNodesById(a, a), 0);
});

test("compareEdges: orders by from, then type, then to, then step", () => {
  const e1 = makeEdge("n:a", "CALLS", "n:b", 0);
  const e2 = makeEdge("n:a", "CALLS", "n:b", 1);
  const e3 = makeEdge("n:a", "CALLS", "n:c", 0);
  const e4 = makeEdge("n:a", "CONTAINS", "n:b", 0);
  const e5 = makeEdge("n:b", "CALLS", "n:a", 0);
  const sorted = sortEdges([e5, e4, e3, e2, e1]);
  assert.deepEqual(
    sorted.map((e) => e.id),
    [e1.id, e2.id, e3.id, e4.id, e5.id],
  );
});

test("sortNodes: deterministic across 100 shuffles", () => {
  const ids = [
    "Function:a.ts:one",
    "Class:a.ts:Two",
    "Function:b.ts:three",
    "Folder:b",
    "File:a.ts",
    "Method:a.ts:Two.go#0",
    "Variable:a.ts:v",
    "Method:a.ts:Two.go#1",
    "Interface:z.ts:Iface",
    "Enum:a.ts:Color",
  ];
  const nodes = ids.map(makeFunctionNode);
  const reference = sortNodes(nodes).map((n) => n.id);
  for (let i = 0; i < 100; i++) {
    const shuffled = shuffle(nodes, 1 + i);
    const result = sortNodes(shuffled).map((n) => n.id);
    assert.deepEqual(result, reference);
  }
});

test("sortEdges: deterministic across 100 shuffles", () => {
  const edges: CodeRelation[] = [
    makeEdge("n:a", "CALLS", "n:b", 0),
    makeEdge("n:a", "CALLS", "n:b", 1),
    makeEdge("n:a", "CONTAINS", "n:b", 0),
    makeEdge("n:b", "CALLS", "n:a", 0),
    makeEdge("n:a", "CALLS", "n:c", 0),
    makeEdge("n:c", "PROCESS_STEP", "n:d", 2),
    makeEdge("n:c", "PROCESS_STEP", "n:d", 1),
    makeEdge("n:x", "IMPORTS", "n:y"),
  ];
  const reference = sortEdges(edges).map((e) => e.id);
  for (let i = 0; i < 100; i++) {
    const shuffled = shuffle(edges, 7 + i);
    const result = sortEdges(shuffled).map((e) => e.id);
    assert.deepEqual(result, reference);
  }
});
