import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveReference } from "./partial-path-engine.js";
import type { NodeId, StackGraph, StackGraphNode } from "./types.js";

/** Minimal graph builder for tests — avoids pulling in the full builder. */
function makeGraph(
  file: string,
  nodes: readonly StackGraphNode[],
  edges: readonly { source: NodeId; target: NodeId; precedence?: number }[],
  rootNodeId: NodeId,
): StackGraph {
  return {
    file,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      precedence: e.precedence ?? 0,
    })),
    rootNodeId,
    referenceIndex: new Map(),
  };
}

test("resolveReference: single-file push-pop pair empties the stack at the definition", () => {
  // Simulate: reference `bar` pushes, flows through an edge to a pop node
  // for `bar` whose definitionTarget is `foo.bar`.
  const file = "mod.py";
  const ref: StackGraphNode = { id: "ref", kind: "push", symbol: "bar", file };
  const def: StackGraphNode = {
    id: "def",
    kind: "pop",
    symbol: "bar",
    file,
    definitionTarget: "foo.bar",
    line: 1,
  };
  const root: StackGraphNode = { id: "root", kind: "root", file };
  const graph = makeGraph(file, [ref, def, root], [{ source: "ref", target: "def" }], "root");
  const { results } = resolveReference(new Map([[file, graph]]), file, "ref");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.targetNodeId, "def");
  assert.equal(results[0]?.targetKey, "mod.py:1:foo.bar");
});

test("resolveReference: cross-file hop via ROOT lands on the other file's pop", () => {
  // consumer.py has `ref(bar)` → root. other.py's root has a pop(bar).
  const consumer: StackGraph = makeGraph(
    "consumer.py",
    [
      { id: "ref", kind: "push", symbol: "bar", file: "consumer.py" },
      { id: "root", kind: "root", file: "consumer.py" },
    ],
    [{ source: "ref", target: "root" }],
    "root",
  );
  const other: StackGraph = makeGraph(
    "other.py",
    [
      { id: "root", kind: "root", file: "other.py" },
      {
        id: "def",
        kind: "pop",
        symbol: "bar",
        file: "other.py",
        definitionTarget: "bar",
        line: 2,
      },
    ],
    [{ source: "root", target: "def" }],
    "root",
  );
  const graphs = new Map([
    ["consumer.py", consumer],
    ["other.py", other],
  ]);
  const { results } = resolveReference(graphs, "consumer.py", "ref");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.targetKey, "other.py:2:bar");
});

test("resolveReference: mismatched pop prunes the path", () => {
  const file = "mod.py";
  const ref: StackGraphNode = { id: "ref", kind: "push", symbol: "bar", file };
  const wrongPop: StackGraphNode = {
    id: "wrong",
    kind: "pop",
    symbol: "baz",
    file,
    definitionTarget: "baz",
    line: 1,
  };
  const root: StackGraphNode = { id: "root", kind: "root", file };
  const graph = makeGraph(
    file,
    [ref, wrongPop, root],
    [{ source: "ref", target: "wrong" }],
    "root",
  );
  const { results } = resolveReference(new Map([[file, graph]]), file, "ref");
  assert.equal(results.length, 0);
});

test("resolveReference: multiple paths ranked by shortest first", () => {
  const file = "mod.py";
  const ref: StackGraphNode = { id: "ref", kind: "push", symbol: "bar", file };
  const near: StackGraphNode = {
    id: "near",
    kind: "pop",
    symbol: "bar",
    file,
    definitionTarget: "near",
    line: 1,
  };
  const mid: StackGraphNode = { id: "mid", kind: "scope", file };
  const far: StackGraphNode = {
    id: "far",
    kind: "pop",
    symbol: "bar",
    file,
    definitionTarget: "far",
    line: 2,
  };
  const root: StackGraphNode = { id: "root", kind: "root", file };
  const graph = makeGraph(
    file,
    [ref, near, mid, far, root],
    [
      { source: "ref", target: "near", precedence: 1 },
      { source: "ref", target: "mid", precedence: 0 },
      { source: "mid", target: "far" },
    ],
    "root",
  );
  const { results } = resolveReference(new Map([[file, graph]]), file, "ref");
  assert.equal(results.length, 2);
  assert.equal(results[0]?.targetKey, "mod.py:1:near", "shortest path first");
  assert.equal(results[1]?.targetKey, "mod.py:2:far");
});
