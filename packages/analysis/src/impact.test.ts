import assert from "node:assert/strict";
import { test } from "node:test";
import { isTestPath, riskFromImpactedCount, runImpact } from "./impact.js";
import { FakeStore } from "./test-utils.js";

function makeFooWithNDownstream(n: number): FakeStore {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 5,
  });
  for (let i = 0; i < n; i += 1) {
    const id = `Function:src/a.ts:caller_${i}#0`;
    store.addNode({
      id,
      kind: "Function",
      name: `caller_${i}`,
      filePath: "src/a.ts",
      startLine: 10 + i,
      endLine: 12 + i,
    });
    store.addEdge({ fromId: "Function:src/a.ts:foo#0", toId: id, type: "CALLS", confidence: 0.9 });
  }
  return store;
}

test("runImpact: 5 downstream callers → LOW risk (count < 10)", async () => {
  const store = makeFooWithNDownstream(5);
  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
    maxDepth: 3,
  });

  assert.equal(res.ambiguous, false);
  assert.equal(res.chosenTarget?.id, "Function:src/a.ts:foo#0");
  assert.equal(res.totalAffected, 5);
  assert.equal(res.risk, "LOW");
  assert.equal(res.byDepth.length, 1);
  const d1 = res.byDepth[0];
  assert.ok(d1, "depth-1 bucket must exist");
  assert.equal(d1.depth, 1);
  assert.equal(d1.nodes.length, 5);
  for (const n of d1.nodes) {
    assert.equal(n.viaRelation, "CALLS");
  }
});

test("runImpact: 1 downstream caller → LOW risk", async () => {
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
  assert.equal(res.risk, "LOW");
  assert.equal(res.totalAffected, 1);
});

test("runImpact: ambiguous target returns candidates with uid/filePath/kind", async () => {
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
  assert.ok(res.hint?.includes("target_uid"), "hint should mention target_uid disambiguation");
  // Candidates expose id/filePath/kind for downstream disambiguation.
  for (const c of res.targetCandidates) {
    assert.ok(c.id.length > 0);
    assert.ok(c.filePath.length > 0);
    assert.ok(c.kind.length > 0);
  }
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

test("runImpact: target_uid skips name disambiguation", async () => {
  const store = new FakeStore();
  // Two "foo" symbols — ambiguous by name. target_uid bypasses that.
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
  const res = await runImpact(store, {
    target: "foo",
    targetUid: "Function:src/b.ts:foo#0",
    direction: "downstream",
  });
  assert.equal(res.ambiguous, false);
  assert.equal(res.chosenTarget?.id, "Function:src/b.ts:foo#0");
});

test("runImpact: target_uid for missing id returns not-found, not ambiguous", async () => {
  const store = new FakeStore();
  const res = await runImpact(store, {
    target: "foo",
    targetUid: "Function:nowhere.ts:foo#0",
    direction: "downstream",
  });
  assert.equal(res.ambiguous, false);
  assert.equal(res.totalAffected, 0);
  assert.ok(res.hint?.includes("Function:nowhere.ts:foo#0"));
});

test("runImpact: file_path disambiguates ambiguous name", async () => {
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
  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
    filePath: "src/b.ts",
  });
  assert.equal(res.ambiguous, false);
  assert.equal(res.chosenTarget?.id, "Function:src/b.ts:foo#0");
});

test("runImpact: kind disambiguates ambiguous name", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Method:src/a.ts:foo#0",
    kind: "Method",
    name: "foo",
    filePath: "src/a.ts",
  });
  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
    kind: "Method",
  });
  assert.equal(res.ambiguous, false);
  assert.equal(res.chosenTarget?.id, "Method:src/a.ts:foo#0");
  assert.equal(res.chosenTarget?.kind, "Method");
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

test("runImpact: includeTests=false drops test-file dependents", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/b.ts:normalCaller#0",
    kind: "Function",
    name: "normalCaller",
    filePath: "src/b.ts",
  });
  store.addNode({
    id: "Function:tests/foo.test.ts:testCaller#0",
    kind: "Function",
    name: "testCaller",
    filePath: "tests/foo.test.ts",
  });
  store.addNode({
    id: "Function:src/foo.spec.ts:specCaller#0",
    kind: "Function",
    name: "specCaller",
    filePath: "src/foo.spec.ts",
  });
  store.addEdge({
    fromId: "Function:src/b.ts:normalCaller#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "Function:tests/foo.test.ts:testCaller#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "Function:src/foo.spec.ts:specCaller#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 0.9,
  });

  const filtered = await runImpact(store, { target: "foo", direction: "upstream" });
  assert.equal(filtered.totalAffected, 1);
  const onlyNames = filtered.byDepth.flatMap((b) => b.nodes).map((n) => n.name);
  assert.deepEqual(onlyNames, ["normalCaller"]);

  const kept = await runImpact(store, {
    target: "foo",
    direction: "upstream",
    includeTests: true,
  });
  assert.equal(kept.totalAffected, 3);
  const allNames = kept.byDepth.flatMap((b) => b.nodes).map((n) => n.name);
  assert.deepEqual(allNames.sort(), ["normalCaller", "specCaller", "testCaller"]);
});

test("runImpact: minConfidence=1.0 drops every heuristic edge", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:confident#0",
    kind: "Function",
    name: "confident",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:heuristic#0",
    kind: "Function",
    name: "heuristic",
    filePath: "src/a.ts",
  });
  store.addEdge({
    fromId: "Function:src/a.ts:confident#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 1.0,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:heuristic#0",
    toId: "Function:src/a.ts:foo#0",
    type: "CALLS",
    confidence: 0.5,
  });
  const res = await runImpact(store, {
    target: "foo",
    direction: "upstream",
    minConfidence: 1.0,
  });
  assert.equal(res.totalAffected, 1);
  assert.equal(res.byDepth[0]?.nodes[0]?.name, "confident");
});

test("runImpact: relationTypes filter restricts traversal", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Class:src/a.ts:Foo#0",
    kind: "Class",
    name: "Foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Class:src/a.ts:Parent#0",
    kind: "Class",
    name: "Parent",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Method:src/a.ts:method#0",
    kind: "Method",
    name: "method",
    filePath: "src/a.ts",
  });
  store.addEdge({
    fromId: "Class:src/a.ts:Foo#0",
    toId: "Method:src/a.ts:method#0",
    type: "HAS_METHOD",
    confidence: 1.0,
  });
  store.addEdge({
    fromId: "Class:src/a.ts:Foo#0",
    toId: "Class:src/a.ts:Parent#0",
    type: "EXTENDS",
    confidence: 1.0,
  });

  const onlyExtends = await runImpact(store, {
    target: "Foo",
    direction: "downstream",
    relationTypes: ["EXTENDS"],
  });
  const names = onlyExtends.byDepth.flatMap((b) => b.nodes).map((n) => n.name);
  assert.deepEqual(names, ["Parent"]);

  const onlyHasMethod = await runImpact(store, {
    target: "Foo",
    direction: "downstream",
    relationTypes: ["HAS_METHOD"],
  });
  const methodNames = onlyHasMethod.byDepth.flatMap((b) => b.nodes).map((n) => n.name);
  assert.deepEqual(methodNames, ["method"]);
});

test("runImpact: maxDepth caps traversal depth", async () => {
  const store = new FakeStore();
  // foo → bar → baz (depth 2) → qux (depth 3).
  const chain = ["foo", "bar", "baz", "qux"];
  for (const name of chain) {
    store.addNode({
      id: `Function:src/a.ts:${name}#0`,
      kind: "Function",
      name,
      filePath: "src/a.ts",
    });
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    store.addEdge({
      fromId: `Function:src/a.ts:${chain[i]}#0`,
      toId: `Function:src/a.ts:${chain[i + 1]}#0`,
      type: "CALLS",
      confidence: 0.9,
    });
  }
  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
    maxDepth: 2,
  });
  const maxDepth = Math.max(...res.byDepth.map((b) => b.depth));
  assert.equal(maxDepth, 2);
  assert.equal(res.totalAffected, 2);
});

test("runImpact: affectedModules surface MEMBER_OF communities", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:directDep#0",
    kind: "Function",
    name: "directDep",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Function:src/a.ts:indirectDep#0",
    kind: "Function",
    name: "indirectDep",
    filePath: "src/a.ts",
  });
  store.addNode({
    id: "Community:auth#0",
    kind: "Community",
    name: "auth-cluster",
    filePath: "",
    inferredLabel: "auth",
  });
  store.addNode({
    id: "Community:billing#0",
    kind: "Community",
    name: "billing-cluster",
    filePath: "",
    inferredLabel: "billing",
  });
  // foo → directDep → indirectDep
  store.addEdge({
    fromId: "Function:src/a.ts:foo#0",
    toId: "Function:src/a.ts:directDep#0",
    type: "CALLS",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:directDep#0",
    toId: "Function:src/a.ts:indirectDep#0",
    type: "CALLS",
    confidence: 0.9,
  });
  // directDep ∈ auth (direct), indirectDep ∈ billing (indirect).
  store.addEdge({
    fromId: "Function:src/a.ts:directDep#0",
    toId: "Community:auth#0",
    type: "MEMBER_OF",
    confidence: 1.0,
  });
  store.addEdge({
    fromId: "Function:src/a.ts:indirectDep#0",
    toId: "Community:billing#0",
    type: "MEMBER_OF",
    confidence: 1.0,
  });

  const res = await runImpact(store, {
    target: "foo",
    direction: "downstream",
    maxDepth: 3,
  });
  assert.equal(res.affectedModules.length, 2);
  const auth = res.affectedModules.find((m) => m.name === "auth");
  const billing = res.affectedModules.find((m) => m.name === "billing");
  assert.ok(auth);
  assert.ok(billing);
  assert.equal(auth.impact, "direct");
  assert.equal(billing.impact, "indirect");
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
  assert.equal(res.affectedProcesses.length, 1);
  const proc = res.affectedProcesses[0];
  assert.ok(proc);
  assert.equal(proc.id, "Process:login#0");
  assert.equal(proc.name, "login-flow");
  assert.equal(proc.entryPointFile, "src/a.ts");
  assert.ok(
    ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(res.risk),
    `risk should be a valid tier, got ${res.risk}`,
  );
});

test("riskFromImpactedCount: 0 nodes → LOW", () => {
  assert.equal(riskFromImpactedCount(0, 0), "LOW");
});

test("riskFromImpactedCount: 9 nodes → LOW", () => {
  assert.equal(riskFromImpactedCount(9, 0), "LOW");
});

test("riskFromImpactedCount: 50 nodes → MEDIUM", () => {
  assert.equal(riskFromImpactedCount(50, 0), "MEDIUM");
});

test("riskFromImpactedCount: 500 nodes → HIGH", () => {
  assert.equal(riskFromImpactedCount(500, 0), "HIGH");
});

test("riskFromImpactedCount: 1500 nodes → CRITICAL", () => {
  assert.equal(riskFromImpactedCount(1500, 0), "CRITICAL");
});

test("riskFromImpactedCount: 2 processes lifts LOW → HIGH", () => {
  assert.equal(riskFromImpactedCount(5, 2), "HIGH");
});

test("riskFromImpactedCount: 5 processes → CRITICAL regardless of count", () => {
  assert.equal(riskFromImpactedCount(1, 5), "CRITICAL");
});

test("isTestPath: detects common test layouts", () => {
  assert.equal(isTestPath("tests/a.ts"), true);
  assert.equal(isTestPath("test/a.ts"), true);
  assert.equal(isTestPath("src/__tests__/a.ts"), true);
  assert.equal(isTestPath("src/a.test.ts"), true);
  assert.equal(isTestPath("src/a.spec.ts"), true);
  assert.equal(isTestPath("src/a.ts"), false);
  assert.equal(isTestPath(""), false);
});
