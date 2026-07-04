/**
 * Regression test for B2 + B2b — the recursive-CTE traversal cycle guard.
 *
 * B2: the cycle guard used a RAW `instr(reach.path, edges.dst) = 0` substring
 * test. Node ids are `${kind}:${filePath}:${qualifiedName}` with no
 * disambiguating suffix, so one id can be a SUBSTRING of another
 * (`Function:src/app.ts:Foo` ⊂ `Function:src/app.ts:FooBar`). When the longer
 * id was already on the path, the edge to the shorter id was falsely pruned as
 * a "cycle", dropping that node AND its whole subtree — silently
 * under-reporting blast radius in impact / api_impact / verdict. The fix
 * anchors the membership test on comma delimiters so only a WHOLE id counts as
 * a revisit.
 *
 * B2b: on a diamond graph two equally-short paths can reach the same node; the
 * old `GROUP BY node_id` with a bare `path` column let SQLite pick an arbitrary
 * tied row, so the reported predecessor/path varied across runs. The fix ranks
 * by (depth, path) and keeps the lexicographically-smallest — deterministic.
 *
 * These tests would both FAIL against the pre-fix query.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type GraphNode,
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
  type RelationType,
} from "@opencodehub/core-types";
import { SqliteStore } from "./sqlite-adapter.js";

function fn(g: KnowledgeGraph, name: string): NodeId {
  const id = makeNodeId("Function", "src/app.ts", name);
  g.addNode({
    id,
    kind: "Function",
    name,
    filePath: "src/app.ts",
    startLine: 1,
    signature: `function ${name}()`,
  } as GraphNode);
  return id;
}

function calls(g: KnowledgeGraph, from: NodeId, to: NodeId): void {
  g.addEdge({ from, to, type: "CALLS" as RelationType, confidence: 1.0 });
}

async function withStore(
  graph: KnowledgeGraph,
  body: (store: SqliteStore) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "och-traverse-b2-"));
  const dbPath = join(dir, "store.sqlite");
  const store = new SqliteStore(dbPath);
  try {
    await store.open();
    await store.createSchema();
    await store.bulkLoad(graph);
    await body(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("B2: prefix-substring node ids do not falsely prune the traversal subtree", async () => {
  const g = new KnowledgeGraph();
  g.addNode({
    id: makeNodeId("File", "src/app.ts", "src/app.ts"),
    kind: "File",
    name: "app.ts",
    filePath: "src/app.ts",
  } as GraphNode);
  // `Foo`'s id is a strict substring of `FooBar`'s id — the exact B2 trigger.
  const start = fn(g, "start");
  const fooBar = fn(g, "FooBar");
  const foo = fn(g, "Foo");
  const end = fn(g, "end");
  // Chain: start → FooBar → Foo → end. Walking down from start, once `FooBar`
  // is on the path the pre-fix guard saw `Foo` (a substring) as a revisit and
  // dropped it plus `end`.
  calls(g, start, fooBar);
  calls(g, fooBar, foo);
  calls(g, foo, end);

  await withStore(g, async (store) => {
    const down = await store.traverse({ startId: start, direction: "down", maxDepth: 10 });
    const reached = new Set(down.map((r) => r.nodeId));
    assert.ok(reached.has(fooBar), "FooBar reached");
    assert.ok(reached.has(foo), "Foo reached — pre-fix this was pruned as a false substring cycle");
    assert.ok(reached.has(end), "end reached — the subtree below Foo survives");
    assert.equal(reached.size, 3, "all three downstream nodes reached, none dropped");
  });
});

test("B2b: diamond graph yields a deterministic path across repeated traversals", async () => {
  const g = new KnowledgeGraph();
  g.addNode({
    id: makeNodeId("File", "src/app.ts", "src/app.ts"),
    kind: "File",
    name: "app.ts",
    filePath: "src/app.ts",
  } as GraphNode);
  // Diamond: root → left → sink, root → right → sink. Two equally-short (depth
  // 2) paths reach `sink`; the reported path must be stable across runs.
  const root = fn(g, "root");
  const left = fn(g, "left");
  const right = fn(g, "right");
  const sink = fn(g, "sink");
  calls(g, root, left);
  calls(g, root, right);
  calls(g, left, sink);
  calls(g, right, sink);

  await withStore(g, async (store) => {
    const paths = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const down = await store.traverse({ startId: root, direction: "down", maxDepth: 10 });
      const sinkRow = down.find((r) => r.nodeId === sink);
      assert.ok(sinkRow, "sink reached");
      paths.add(sinkRow.path.join(","));
    }
    assert.equal(
      paths.size,
      1,
      `sink path must be deterministic across runs, saw: ${[...paths].join(" | ")}`,
    );
  });
});
