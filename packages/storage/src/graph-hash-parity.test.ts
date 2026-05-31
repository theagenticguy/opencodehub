/**
 * Cross-adapter `graphHash` parity for empty-array node fields.
 *
 * `column-encode.ts:stringArrayOrNull` and `core-types/graph-hash.ts`
 * promise that a node written with an explicit empty `keywords: []` /
 * `responseKeys: []` round-trips byte-identically under {@link graphHash}
 * — and stays DISTINCT from the same node with the field absent. The
 * canonical-JSON projection emits `{"keywords":[]}` for the former and no
 * key at all for the latter, so their SHA-256 graph hashes differ.
 *
 * The graph tier persists empty `STRING[]` columns through lbug, which
 * collapses a 0-length array to SQL NULL on write. The graph-db adapter
 * works around that with an empty-array marker on the write side and the
 * symmetric decode on read (`encodeNodeCol` + `setStringArrayFieldGd` in
 * `graphdb-adapter.ts`). This test pins both halves of the contract:
 *
 *   (a) `graphHash(rebuild(store)) === graphHash(fixture)` for a fixture
 *       whose nodes carry `keywords: []` / `responseKeys: []` — the
 *       round-trip must NOT drop the empty arrays. Runs through the public
 *       {@link assertGraphParity} harness so a community `IGraphStore`
 *       fork inherits the same enforcement.
 *   (b) the empty-array fixture hashes DIFFERENTLY from the otherwise
 *       identical fixture with the array fields absent.
 *
 * The native-binding-dependent half mirrors `graphdb-roundtrip.test.ts`:
 * skipped cleanly when `@ladybugdb/core` cannot load (e.g. an unsupported
 * platform in CI). Half (b) is pure JS and always runs.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type GraphNode,
  graphHash,
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
} from "@opencodehub/core-types";
import { GraphDbStore } from "./graphdb-adapter.js";
import { assertGraphParity } from "./test-utils/parity-harness.js";

async function scratchDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-graphhash-parity-"));
  return join(dir, "graph.db");
}

async function hasNativeBinding(): Promise<boolean> {
  try {
    await import("@ladybugdb/core");
    return true;
  } catch {
    return false;
  }
}

const COMMUNITY_ID = makeNodeId("Community", "", "empty-keywords");
const ROUTE_ID = makeNodeId("Route", "src/api.ts", "GET /things");
const FILE_ID = makeNodeId("File", "src/api.ts", "api.ts");

/**
 * Fixture whose Community node carries `keywords: []` and whose Route node
 * carries `responseKeys: []` — both explicit empty arrays. A File node is
 * included so the empty-array columns coexist with ordinary rows.
 */
function buildEmptyArrayGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode({ id: FILE_ID, kind: "File", name: "api.ts", filePath: "src/api.ts" });
  g.addNode({
    id: COMMUNITY_ID,
    kind: "Community",
    name: "empty-keywords",
    filePath: "",
    keywords: [],
  } as unknown as GraphNode);
  g.addNode({
    id: ROUTE_ID,
    kind: "Route",
    name: "GET /things",
    filePath: "src/api.ts",
    url: "/things",
    method: "GET",
    responseKeys: [],
  } as unknown as GraphNode);
  g.addEdge({ from: FILE_ID, to: ROUTE_ID as NodeId, type: "DEFINES", confidence: 1.0 });
  return g;
}

/**
 * Same shape as {@link buildEmptyArrayGraph} but with the `keywords` /
 * `responseKeys` fields absent. Used to prove `[]` is distinct from absent.
 */
function buildAbsentArrayGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode({ id: FILE_ID, kind: "File", name: "api.ts", filePath: "src/api.ts" });
  g.addNode({
    id: COMMUNITY_ID,
    kind: "Community",
    name: "empty-keywords",
    filePath: "",
  } as unknown as GraphNode);
  g.addNode({
    id: ROUTE_ID,
    kind: "Route",
    name: "GET /things",
    filePath: "src/api.ts",
    url: "/things",
    method: "GET",
  } as unknown as GraphNode);
  g.addEdge({ from: FILE_ID, to: ROUTE_ID as NodeId, type: "DEFINES", confidence: 1.0 });
  return g;
}

test("graphHash distinguishes empty-array fields from absent ones", () => {
  const withEmpty = graphHash(buildEmptyArrayGraph());
  const withAbsent = graphHash(buildAbsentArrayGraph());
  assert.notEqual(
    withEmpty,
    withAbsent,
    "graphHash({keywords: []}) must differ from graphHash with the field absent",
  );
});

test("graph-db round-trip preserves empty keywords / responseKeys byte-identically", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping round-trip");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    await assertGraphParity(buildEmptyArrayGraph(), {
      stores: [store],
      label: "empty-array-fields",
    });
  } finally {
    await store.close();
  }
});
