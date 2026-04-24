/**
 * Dead-code classifier tests.
 *
 * Exercise each verdict bucket (`dead`, `unreachable-export`, `live`) plus
 * the ghost-community rollup and the ACCESSES-keeps-alive edge case.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDeadness } from "./dead-code.js";
import { FakeStore } from "./test-utils.js";

test("non-exported function with no referrers is dead", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:a.ts:lonely",
    kind: "Function",
    name: "lonely",
    filePath: "a.ts",
    startLine: 1,
    endLine: 3,
    isExported: false,
  });
  const result = await classifyDeadness(store);
  assert.equal(result.symbols["Function:a.ts:lonely"], "dead");
  assert.equal(result.dead.length, 1);
  const first = result.dead[0];
  assert.ok(first !== undefined);
  assert.equal(first.deadness, "dead");
  assert.equal(first.name, "lonely");
});

test("exported function referenced from another file is live", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:a.ts:helper",
    kind: "Function",
    name: "helper",
    filePath: "a.ts",
    startLine: 1,
    endLine: 3,
    isExported: true,
  });
  store.addNode({
    id: "Function:b.ts:caller",
    kind: "Function",
    name: "caller",
    filePath: "b.ts",
    startLine: 1,
    endLine: 5,
    isExported: true,
  });
  store.addEdge({
    fromId: "Function:b.ts:caller",
    toId: "Function:a.ts:helper",
    type: "CALLS",
    confidence: 1,
  });
  const result = await classifyDeadness(store);
  // `helper` is exported + has a cross-module referrer → live.
  assert.equal(result.symbols["Function:a.ts:helper"], "live");
  // `caller` is exported but nothing imports b.ts → unreachable-export (not
  // dead, because the test marked it exported).
  assert.equal(result.symbols["Function:b.ts:caller"], "unreachable-export");
});

test("exported function with no cross-module referrer is unreachable-export", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:a.ts:exported",
    kind: "Function",
    name: "exported",
    filePath: "a.ts",
    startLine: 1,
    endLine: 3,
    isExported: true,
  });
  // Same-file caller — must NOT rescue the exported symbol.
  store.addNode({
    id: "Function:a.ts:localCaller",
    kind: "Function",
    name: "localCaller",
    filePath: "a.ts",
    startLine: 5,
    endLine: 7,
    isExported: false,
  });
  store.addEdge({
    fromId: "Function:a.ts:localCaller",
    toId: "Function:a.ts:exported",
    type: "CALLS",
    confidence: 1,
  });
  const result = await classifyDeadness(store);
  assert.equal(result.symbols["Function:a.ts:exported"], "unreachable-export");
  assert.equal(result.unreachableExports.length, 1);
  const first = result.unreachableExports[0];
  assert.ok(first !== undefined);
  assert.equal(first.deadness, "unreachable-export");
});

test("community with 100% non-live members is a ghost community", async () => {
  const store = new FakeStore();
  // Two dead non-exported functions, one community containing both.
  store.addNode({
    id: "Function:a.ts:zombie1",
    kind: "Function",
    name: "zombie1",
    filePath: "a.ts",
    startLine: 1,
    endLine: 3,
    isExported: false,
  });
  store.addNode({
    id: "Function:a.ts:zombie2",
    kind: "Function",
    name: "zombie2",
    filePath: "a.ts",
    startLine: 5,
    endLine: 7,
    isExported: false,
  });
  store.addNode({
    id: "Community:<global>:community-0",
    kind: "Community",
    name: "community-0",
    filePath: "<global>",
  });
  store.addEdge({
    fromId: "Function:a.ts:zombie1",
    toId: "Community:<global>:community-0",
    type: "MEMBER_OF",
    confidence: 1,
  });
  store.addEdge({
    fromId: "Function:a.ts:zombie2",
    toId: "Community:<global>:community-0",
    type: "MEMBER_OF",
    confidence: 1,
  });
  const result = await classifyDeadness(store);
  assert.deepEqual(result.ghostCommunities, ["Community:<global>:community-0"]);

  // Sanity check: a community with at least one live member must NOT be flagged.
  const store2 = new FakeStore();
  store2.addNode({
    id: "Function:x.ts:alive",
    kind: "Function",
    name: "alive",
    filePath: "x.ts",
    startLine: 1,
    endLine: 3,
    isExported: true,
  });
  store2.addNode({
    id: "Function:y.ts:caller",
    kind: "Function",
    name: "caller",
    filePath: "y.ts",
    startLine: 1,
    endLine: 3,
    isExported: true,
  });
  store2.addNode({
    id: "Function:x.ts:dead",
    kind: "Function",
    name: "dead",
    filePath: "x.ts",
    startLine: 10,
    endLine: 12,
    isExported: false,
  });
  store2.addNode({
    id: "Community:<global>:community-0",
    kind: "Community",
    name: "community-0",
    filePath: "<global>",
  });
  store2.addEdge({
    fromId: "Function:y.ts:caller",
    toId: "Function:x.ts:alive",
    type: "CALLS",
    confidence: 1,
  });
  store2.addEdge({
    fromId: "Function:x.ts:alive",
    toId: "Community:<global>:community-0",
    type: "MEMBER_OF",
    confidence: 1,
  });
  store2.addEdge({
    fromId: "Function:x.ts:dead",
    toId: "Community:<global>:community-0",
    type: "MEMBER_OF",
    confidence: 1,
  });
  const result2 = await classifyDeadness(store2);
  assert.deepEqual(result2.ghostCommunities, []);
});

test("symbol kept alive via ACCESSES (closure capture) is live", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:a.ts:closedOver",
    kind: "Function",
    name: "closedOver",
    filePath: "a.ts",
    startLine: 1,
    endLine: 3,
    isExported: false,
  });
  store.addNode({
    id: "Function:b.ts:wrapper",
    kind: "Function",
    name: "wrapper",
    filePath: "b.ts",
    startLine: 1,
    endLine: 5,
    isExported: false,
  });
  // ACCESSES edge — wrapper closes over closedOver without invoking it.
  store.addEdge({
    fromId: "Function:b.ts:wrapper",
    toId: "Function:a.ts:closedOver",
    type: "ACCESSES",
    confidence: 1,
  });
  const result = await classifyDeadness(store);
  // The ACCESSES edge rescues closedOver from `dead` even though wrapper
  // itself is unreferenced.
  assert.equal(result.symbols["Function:a.ts:closedOver"], "live");
  // `wrapper` is non-exported with no inbound referrers → dead.
  assert.equal(result.symbols["Function:b.ts:wrapper"], "dead");
});
