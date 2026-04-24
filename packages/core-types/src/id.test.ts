import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEdgeId, makeNodeId, type NodeId, parseNodeId } from "./id.js";
import { NODE_KINDS, type NodeKind } from "./nodes.js";

test("makeNodeId: base shape uses kind, file, qualifiedName", () => {
  const id = makeNodeId("Class", "src/a.ts", "Foo");
  assert.equal(id, "Class:src/a.ts:Foo");
});

test("makeNodeId: callable kinds append #paramCount when provided", () => {
  const fn = makeNodeId("Function", "src/a.ts", "do", { parameterCount: 2 });
  assert.equal(fn, "Function:src/a.ts:do#2");
  const mt = makeNodeId("Method", "src/a.ts", "Foo.bar", { parameterCount: 0 });
  assert.equal(mt, "Method:src/a.ts:Foo.bar#0");
  const ctor = makeNodeId("Constructor", "src/a.ts", "Foo", { parameterCount: 1 });
  assert.equal(ctor, "Constructor:src/a.ts:Foo#1");
});

test("makeNodeId: non-callable kinds ignore parameterCount", () => {
  const id = makeNodeId("Class", "src/a.ts", "Foo", { parameterCount: 3 });
  assert.equal(id, "Class:src/a.ts:Foo");
});

test("makeNodeId: type hash suffix appended when parameterTypes supplied", () => {
  const id = makeNodeId("Method", "src/a.ts", "Foo.bar", {
    parameterCount: 2,
    parameterTypes: ["int", "str"],
  });
  assert.match(id, /^Method:src\/a\.ts:Foo\.bar#2~[0-9a-f]{6}$/);
});

test("makeNodeId: $const suffix applied last", () => {
  const id = makeNodeId("Method", "src/a.cpp", "Foo.bar", {
    parameterCount: 1,
    parameterTypes: ["int"],
    isConst: true,
  });
  assert.match(id, /^Method:src\/a\.cpp:Foo\.bar#1~[0-9a-f]{6}\$const$/);
});

test("makeNodeId: deterministic across 100 runs with same inputs", () => {
  const first = makeNodeId("Function", "src/a.ts", "do", {
    parameterCount: 2,
    parameterTypes: ["int", "str"],
  });
  for (let i = 0; i < 100; i++) {
    const again = makeNodeId("Function", "src/a.ts", "do", {
      parameterCount: 2,
      parameterTypes: ["int", "str"],
    });
    assert.equal(again, first);
  }
});

test("parseNodeId: round-trip for every node kind without extras", () => {
  for (const kind of NODE_KINDS) {
    const id = makeNodeId(kind, "src/a.ts", "Sym");
    const parsed = parseNodeId(id);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.filePath, "src/a.ts");
    assert.equal(parsed.qualifiedName, "Sym");
    assert.equal(parsed.parameterCount, undefined);
    assert.equal(parsed.typeHash, undefined);
    assert.equal(parsed.isConst, false);
  }
});

test("parseNodeId: recovers parameterCount for callable kinds", () => {
  const callables: readonly NodeKind[] = ["Function", "Method", "Constructor"];
  for (const kind of callables) {
    const id = makeNodeId(kind, "src/a.ts", "Sym", { parameterCount: 3 });
    const parsed = parseNodeId(id);
    assert.equal(parsed.parameterCount, 3);
  }
});

test("parseNodeId: recovers type hash and const suffix", () => {
  const id = makeNodeId("Method", "src/a.cpp", "Foo.bar", {
    parameterCount: 2,
    parameterTypes: ["const int&", "float"],
    isConst: true,
  });
  const parsed = parseNodeId(id);
  assert.equal(parsed.kind, "Method");
  assert.equal(parsed.filePath, "src/a.cpp");
  assert.equal(parsed.qualifiedName, "Foo.bar");
  assert.equal(parsed.parameterCount, 2);
  assert.match(parsed.typeHash ?? "", /^[0-9a-f]{6}$/);
  assert.equal(parsed.isConst, true);
});

test("parseNodeId: qualified name may contain colons from file path edges", () => {
  const id = makeNodeId("Class", "a/b.ts", "Outer::Inner") as NodeId;
  const parsed = parseNodeId(id);
  assert.equal(parsed.kind, "Class");
  assert.equal(parsed.filePath, "a/b.ts");
  assert.equal(parsed.qualifiedName, "Outer::Inner");
});

test("makeEdgeId: deterministic concatenation form", () => {
  const from = "Function:a.ts:f" as NodeId;
  const to = "Function:b.ts:g" as NodeId;
  const eid = makeEdgeId(from, "CALLS", to);
  assert.equal(eid, "Function:a.ts:f->CALLS->Function:b.ts:g:0");
});

test("makeEdgeId: step appended when provided", () => {
  const from = "Function:a.ts:f" as NodeId;
  const to = "Process:p1" as NodeId;
  const eid = makeEdgeId(from, "PROCESS_STEP", to, 7);
  assert.equal(eid, "Function:a.ts:f->PROCESS_STEP->Process:p1:7");
});

test("makeEdgeId: identical inputs produce identical id", () => {
  const from = "Function:a.ts:f" as NodeId;
  const to = "Function:b.ts:g" as NodeId;
  const a = makeEdgeId(from, "CALLS", to, 3);
  const b = makeEdgeId(from, "CALLS", to, 3);
  assert.equal(a, b);
});

test("type-hash collision tag varies with parameter types", () => {
  const a = makeNodeId("Function", "f.ts", "do", {
    parameterCount: 1,
    parameterTypes: ["int"],
  });
  const b = makeNodeId("Function", "f.ts", "do", {
    parameterCount: 1,
    parameterTypes: ["str"],
  });
  assert.notEqual(a, b);
});
