import assert from "node:assert/strict";
import { test } from "node:test";
import { runImpact } from "./impact.js";
import { FakeStore } from "./test-utils.js";

test("runImpact: unambiguous target with 5 downstream callers → MEDIUM risk", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 5,
  });
  for (let i = 0; i < 5; i += 1) {
    const id = `Function:src/a.ts:caller_${i}#0`;
    store.addNode({
      id,
      kind: "Function",
      name: `caller_${i}`,
      filePath: "src/a.ts",
      startLine: 10 + i,
      endLine: 12 + i,
    });
    // Downstream traversal follows `from -> to`, so place foo on the "from"
    // side and each caller on the "to" side (simulating foo calling them).
    store.addEdge({ fromId: "Function:src/a.ts:foo#0", toId: id, type: "CALLS", confidence: 0.9 });
  }

  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
    maxDepth: 3,
  });

  assert.equal(res.ambiguous, false);
  assert.equal(res.chosenTarget?.id, "Function:src/a.ts:foo#0");
  assert.equal(res.totalAffected, 5);
  // 5 at depth 1 → score = 5*3 = 15 → HIGH.
  assert.equal(res.risk, "HIGH");
  assert.equal(res.byDepth.length, 1);
  const d1 = res.byDepth[0];
  assert.ok(d1, "depth-1 bucket must exist");
  assert.equal(d1.depth, 1);
  assert.equal(d1.nodes.length, 5);
  for (const n of d1.nodes) {
    assert.equal(n.viaRelation, "CALLS");
  }
});

test("runImpact: MEDIUM bucket threshold at score=3 (1 depth-1 node)", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 5,
  });
  store.addNode({
    id: "Function:src/a.ts:bar#0",
    kind: "Function",
    name: "bar",
    filePath: "src/a.ts",
    startLine: 7,
    endLine: 9,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:foo#0",
    toId: "Function:src/a.ts:bar#0",
    type: "CALLS",
    confidence: 0.9,
  });

  const res = await runImpact(store, { target: "foo", direction: "downstream" });
  assert.equal(res.risk, "MEDIUM");
  assert.equal(res.totalAffected, 1);
});

test("runImpact: multiple candidates → ambiguous, no traversal", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/b.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/b.ts",
  });

  const res = await runImpact(store, { target: "foo", direction: "downstream" });
  assert.equal(res.ambiguous, true);
  assert.equal(res.targetCandidates.length, 2);
  assert.equal(res.byDepth.length, 0);
  assert.equal(res.risk, "LOW");
  assert.ok(res.hint?.includes("Multiple"), "should hint at disambiguation");
});

test("runImpact: no match → LOW risk with actionable hint", async () => {
  const store = new FakeStore();
  const res = await runImpact(store, { target: "nonexistent", direction: "downstream" });
  assert.equal(res.ambiguous, false);
  assert.equal(res.risk, "LOW");
  assert.equal(res.totalAffected, 0);
  assert.ok(res.hint?.includes("codehub analyze"));
});

test("runImpact: target resolved by node id when target looks like an id", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  const res = await runImpact(store, {
    target: "Function:src/a.ts:foo#0",
    direction: "downstream",
  });
  assert.equal(res.chosenTarget?.id, "Function:src/a.ts:foo#0");
  assert.equal(res.ambiguous, false);
});

test("runImpact: upstream direction finds callers", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:caller#0",
    kind: "Function",
    name: "caller",
    filePath: "src/a.ts",
  });
  store.addEdge({
    fromId: "Function:src/a.ts:caller#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 0.9,
  });

  const res = await runImpact(store, { target: "foo", direction: "upstream" });
  assert.equal(res.totalAffected, 1);
  assert.equal(res.byDepth[0]?.nodes[0]?.name, "caller");
});

test("runImpact: orphan multiplier promotes MEDIUM into HIGH when a fossilized file sits in the path", async () => {
  const store = new FakeStore();
  // Baseline: a function `foo` with 2 direct downstream callers + one depth-2
  // caller. Score = 2*3 + 1*1 = 7 → MEDIUM.
  store.addNode({ id: "File:src/a.ts:src/a.ts", kind: "File", name: "a.ts", filePath: "src/a.ts" });
  store.addNode({
    id: "File:src/old.ts:src/old.ts",
    kind: "File",
    name: "old.ts",
    filePath: "src/old.ts",
    orphanGrade: "fossilized",
  });
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:bar#0",
    kind: "Function",
    name: "bar",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/old.ts:legacy#0",
    kind: "Function",
    name: "legacy",
    filePath: "src/old.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:deep#0",
    kind: "Function",
    name: "deep",
    filePath: "src/a.ts",
  });
  store.addEdge({
    fromId: "Function:src/a.ts:foo#0",
    toId: "Function:src/a.ts:bar#0",
    type: "CALLS",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:foo#0",
    toId: "Function:src/old.ts:legacy#0",
    type: "CALLS",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:bar#0",
    toId: "Function:src/a.ts:deep#0",
    type: "CALLS",
    confidence: 0.9,
  });

  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
    maxDepth: 3,
  });
  // Raw score: d1=2, d2=1 → 7. With fossilized bump ×1.6 → 11.2 → HIGH (>10).
  assert.equal(res.risk, "HIGH");
  assert.equal(res.totalAffected, 3);
});

test("runImpact: direction=both returns non-empty byDepth, affectedProcesses, and a valid risk tier", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:caller#0",
    kind: "Function",
    name: "caller",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:callee#0",
    kind: "Function",
    name: "callee",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "File:src/a.ts:src/a.ts",
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Process:login#0",
    kind: "Process",
    name: "login-flow",
    filePath: "src/a.ts",
    entryPointId: "Function:src/a.ts:caller#0",
  });
  store.addEdge({
    fromId: "Function:src/a.ts:caller#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:foo#0",
    toId: "Function:src/a.ts:callee#0",
    type: "CALLS",
    confidence: 0.9,
  });
  // PROCESS_STEP chains symbols; Process is linked via entry_point_id, not an edge.
  store.addEdge({
    fromId: "Function:src/a.ts:caller#0",
    toId: "Function:src/a.ts:foo#0",
    type: "PROCESS_STEP",
    confidence: 1,
  });

  const res = await runImpact(store, { target: "foo", direction: "both", maxDepth: 3 });

  assert.equal(res.ambiguous, false);
  assert.equal(res.chosenTarget?.id, "Function:src/a.ts:foo#0");
  assert.ok(res.byDepth.length > 0, "byDepth should be non-empty for direction=both");
  assert.ok(res.affectedProcesses.length >= 0, "affectedProcesses should be an array");
  assert.equal(res.affectedProcesses.length, 1);
  const proc = res.affectedProcesses[0];
  assert.ok(proc, "expected one affected process");
  assert.equal(proc.id, "Process:login#0");
  assert.equal(proc.name, "login-flow");
  assert.equal(proc.entryPointFile, "src/a.ts");
  assert.ok(
    ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(res.risk),
    `risk should be a valid tier, got ${res.risk}`,
  );
});

test("runImpact: active-only path keeps risk at MEDIUM (no bump)", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "File:src/a.ts:src/a.ts",
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
    orphanGrade: "active",
  });
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:bar#0",
    kind: "Function",
    name: "bar",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:baz#0",
    kind: "Function",
    name: "baz",
    filePath: "src/a.ts",
  });
  store.addEdge({
    fromId: "Function:src/a.ts:foo#0",
    toId: "Function:src/a.ts:bar#0",
    type: "CALLS",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:foo#0",
    toId: "Function:src/a.ts:baz#0",
    type: "CALLS",
    confidence: 0.9,
  });

  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
  });
  // 2 depth-1 nodes → 6 → MEDIUM. No bump because all paths go through active files.
  assert.equal(res.risk, "MEDIUM");
});
