/**
 * `listApiImpact` tests.
 *
 * Focus: the accessed-keys index is built once per call, not once per
 * (route × consumer file). A counting wrapper around the store proves the
 * ACCESSES table is fetched a single time even when several routes each
 * fan out to several consumer files.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RelationType } from "@opencodehub/core-types";
import type { ListEdgesByTypeOptions } from "@opencodehub/storage";
import { buildAccessedKeysByFileForTest, listApiImpact } from "./api-impact.js";
import { FakeStore } from "./test-utils.js";

/**
 * Wraps {@link FakeStore} and tallies how often a given relation type is
 * fetched via `listEdgesByType`, so a test can assert the hoist removed the
 * per-(route × consumer) re-scan.
 */
class CountingStore extends FakeStore {
  readonly edgeTypeCalls = new Map<string, number>();

  override listEdgesByType(type: RelationType, opts: ListEdgesByTypeOptions = {}) {
    this.edgeTypeCalls.set(type, (this.edgeTypeCalls.get(type) ?? 0) + 1);
    return super.listEdgesByType(type, opts);
  }
}

/** Two routes, each consumed by two files that read response properties. */
function seedTwoRoutesTwoConsumers(store: CountingStore): void {
  // Routes.
  store.addNode({
    id: "Route:GET /users",
    kind: "Route",
    name: "GET /users",
    filePath: "src/routes/users.ts",
    url: "/users",
    method: "GET",
    responseKeys: ["id", "name"],
  });
  store.addNode({
    id: "Route:GET /orders",
    kind: "Route",
    name: "GET /orders",
    filePath: "src/routes/orders.ts",
    url: "/orders",
    method: "GET",
    responseKeys: ["total"],
  });

  // Consumer symbols (one per file) + their host files, wired FETCHES → route.
  const consumers: Array<{ sym: string; file: string; route: string }> = [
    { sym: "Function:a", file: "src/a.ts", route: "Route:GET /users" },
    { sym: "Function:b", file: "src/b.ts", route: "Route:GET /users" },
    { sym: "Function:c", file: "src/c.ts", route: "Route:GET /orders" },
    { sym: "Function:d", file: "src/d.ts", route: "Route:GET /orders" },
  ];
  for (const { sym, file, route } of consumers) {
    store.addNode({ id: sym, kind: "Function", name: sym, filePath: file });
    store.addEdge({ fromId: sym, toId: route, type: "FETCHES", confidence: 1 });
  }

  // ACCESSES edges: each consumer file reads a property off the response.
  // `src/d.ts` reads a key (`bogus`) absent from /orders.responseKeys → MISMATCH.
  const accesses: Array<{ from: string; file: string; prop: string }> = [
    { from: "Function:a", file: "src/a.ts", prop: "id" },
    { from: "Function:b", file: "src/b.ts", prop: "name" },
    { from: "Function:c", file: "src/c.ts", prop: "total" },
    { from: "Function:d", file: "src/d.ts", prop: "bogus" },
  ];
  for (const { from, prop } of accesses) {
    const propId = `Property:${prop}`;
    store.addNode({ id: propId, kind: "Property", name: prop, filePath: "" });
    store.addEdge({ fromId: from, toId: propId, type: "ACCESSES", confidence: 1 });
  }
}

test("listApiImpact: ACCESSES table is fetched exactly once across all routes", async () => {
  const store = new CountingStore();
  seedTwoRoutesTwoConsumers(store);

  const rows = await listApiImpact(store);

  // Before the hoist this was 4 (2 routes × 2 consumer files each); the index
  // is now built a single time per call regardless of route/consumer fan-out.
  assert.equal(store.edgeTypeCalls.get("ACCESSES"), 1);

  // Sanity: the mismatch on /orders (key `bogus` not in responseKeys) is still
  // detected, proving the hoisted index produces identical classification.
  const orders = rows.find((r) => r.route.url === "/orders");
  assert.ok(orders, "expected an /orders row");
  assert.deepEqual(orders.mismatches, ["src/d.ts"]);

  const users = rows.find((r) => r.route.url === "/users");
  assert.ok(users, "expected a /users row");
  assert.deepEqual(users.mismatches, []);
});

test("buildAccessedKeysByFile: buckets property names per source file, sorted", async () => {
  const store = new FakeStore();
  store.addNode({ id: "Function:a", kind: "Function", name: "a", filePath: "src/a.ts" });
  store.addNode({ id: "Property:z", kind: "Property", name: "z", filePath: "" });
  store.addNode({ id: "Property:a", kind: "Property", name: "a", filePath: "" });
  store.addEdge({ fromId: "Function:a", toId: "Property:z", type: "ACCESSES", confidence: 1 });
  store.addEdge({ fromId: "Function:a", toId: "Property:a", type: "ACCESSES", confidence: 1 });

  const index = await buildAccessedKeysByFileForTest(store);
  assert.deepEqual(index.get("src/a.ts"), ["a", "z"]);
});
