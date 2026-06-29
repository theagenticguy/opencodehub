/**
 * Tests for `collectOwnersByPath` — the per-path owner map the verdict CLI
 * feeds the policy engine's `ownership_required` rule.
 *
 * Regression context: the CLI used to hardcode `ownersByPath: new Map()`, so a
 * rule with an empty `require_approval_from` (relying on graph owners) could
 * never be satisfied — it always hit the "no owners" branch. These tests pin
 * that the map is actually built from OWNED_BY edges.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collectOwnersByPath } from "./owners.js";
import { FakeStore } from "./test-utils.js";

function contributorNode(id: string, name: string, emailPlain?: string, emailHash?: string) {
  return {
    id,
    kind: "Contributor",
    name,
    filePath: "<contributors>",
    ...(emailPlain !== undefined ? { emailPlain } : {}),
    ...(emailHash !== undefined ? { emailHash } : {}),
  };
}

test("collectOwnersByPath maps each path to its OWNED_BY owner emails", async () => {
  const store = new FakeStore();
  store.addNode(contributorNode("Contributor:alice", "Alice", "alice@example.com"));
  store.addNode(contributorNode("Contributor:bob", "Bob", "bob@example.com"));
  store.addEdge({
    fromId: "File:src/a.ts:src/a.ts",
    toId: "Contributor:alice",
    type: "OWNED_BY",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: "File:src/a.ts:src/a.ts",
    toId: "Contributor:bob",
    type: "OWNED_BY",
    confidence: 0.4,
  });

  const map = await collectOwnersByPath(store, ["src/a.ts"]);
  assert.deepEqual(map.get("src/a.ts"), ["alice@example.com", "bob@example.com"]);
});

test("collectOwnersByPath omits paths with no owner edges", async () => {
  const store = new FakeStore();
  store.addNode(contributorNode("Contributor:alice", "Alice", "alice@example.com"));
  store.addEdge({
    fromId: "File:src/a.ts:src/a.ts",
    toId: "Contributor:alice",
    type: "OWNED_BY",
    confidence: 1,
  });

  const map = await collectOwnersByPath(store, ["src/a.ts", "src/unowned.ts"]);
  assert.deepEqual(map.get("src/a.ts"), ["alice@example.com"]);
  assert.equal(map.has("src/unowned.ts"), false);
});

test("collectOwnersByPath falls back to emailHash when plain email is absent", async () => {
  const store = new FakeStore();
  store.addNode(contributorNode("Contributor:priv", "Private", undefined, "deadbeefhash"));
  store.addEdge({
    fromId: "File:src/p.ts:src/p.ts",
    toId: "Contributor:priv",
    type: "OWNED_BY",
    confidence: 1,
  });

  const map = await collectOwnersByPath(store, ["src/p.ts"]);
  assert.deepEqual(map.get("src/p.ts"), ["deadbeefhash"]);
});

test("collectOwnersByPath returns an empty map for no files", async () => {
  const store = new FakeStore();
  const map = await collectOwnersByPath(store, []);
  assert.equal(map.size, 0);
});

test("collectOwnersByPath keeps per-path owners distinct (no cross-file bleed)", async () => {
  const store = new FakeStore();
  store.addNode(contributorNode("Contributor:alice", "Alice", "alice@example.com"));
  store.addNode(contributorNode("Contributor:bob", "Bob", "bob@example.com"));
  store.addEdge({
    fromId: "File:src/a.ts:src/a.ts",
    toId: "Contributor:alice",
    type: "OWNED_BY",
    confidence: 1,
  });
  store.addEdge({
    fromId: "File:src/b.ts:src/b.ts",
    toId: "Contributor:bob",
    type: "OWNED_BY",
    confidence: 1,
  });

  const map = await collectOwnersByPath(store, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(map.get("src/a.ts"), ["alice@example.com"]);
  assert.deepEqual(map.get("src/b.ts"), ["bob@example.com"]);
});
