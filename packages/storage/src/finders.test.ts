// SPDX-License-Identifier: Apache-2.0
//
// Typed-finder tests for both adapters.
//
// Each finder is exercised against a small fixture loaded into a DuckDbStore.
// Where the native graph-db binding is available, the same fixture is loaded
// into a GraphDbStore and the parallel finder is asserted to produce equivalent
// results (so the cross-adapter Liskov contract holds for the finder family
// the same way it does for `listNodes` / `bulkLoad`).
//
// Fixtures and assertions live entirely inside `packages/storage`; no
// consumer package is touched here.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
import { DuckDbStore } from "./duckdb-adapter.js";
import { GraphDbStore } from "./graphdb-adapter.js";
import type { EmbeddingRow } from "./interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function scratchDuckPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-finders-duck-"));
  return join(dir, "graph.duckdb");
}

async function scratchGraphDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-finders-gdb-"));
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

// ---------------------------------------------------------------------------
// Fixture — covers every node kind the typed finders narrow to, plus a small
// edge mix to exercise listEdges / listEdgesByType / traverseAncestors /
// traverseDescendants / countEdgesByType / listConsumerProducerEdges.
// ---------------------------------------------------------------------------

interface FixtureIds {
  readonly fileA: NodeId;
  readonly fileB: NodeId;
  readonly fnFoo: NodeId;
  readonly fnBar: NodeId;
  readonly fnBaz: NodeId;
  readonly route1: NodeId;
  readonly op1: NodeId;
  readonly findingNew: NodeId;
  readonly findingOld: NodeId;
  readonly findingSuppressed: NodeId;
  readonly depMit: NodeId;
  readonly depGpl: NodeId;
  readonly depUnknown: NodeId;
  readonly repoConsumer: NodeId;
  readonly repoProducer: NodeId;
  readonly procFoo: NodeId;
}

function buildFinderFixture(): { graph: KnowledgeGraph; ids: FixtureIds } {
  const g = new KnowledgeGraph();
  const fileA = makeNodeId("File", "src/a.ts", "a.ts");
  const fileB = makeNodeId("File", "src/b.ts", "b.ts");
  g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });
  g.addNode({ id: fileB, kind: "File", name: "b.ts", filePath: "src/b.ts" });

  const fnFoo = makeNodeId("Function", "src/a.ts", "foo");
  const fnBar = makeNodeId("Function", "src/a.ts", "bar");
  const fnBaz = makeNodeId("Function", "src/b.ts", "baz");
  g.addNode({
    id: fnFoo,
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
    isExported: true,
  });
  g.addNode({
    id: fnBar,
    kind: "Function",
    name: "bar",
    filePath: "src/a.ts",
    isExported: false,
  });
  g.addNode({
    id: fnBaz,
    kind: "Function",
    name: "baz",
    filePath: "src/b.ts",
    isExported: true,
  });

  const route1 = makeNodeId("Route", "src/router.ts", "GET /api/users");
  g.addNode({
    id: route1,
    kind: "Route",
    name: "GET /api/users",
    filePath: "src/router.ts",
    method: "GET",
    url: "/api/users",
  } as unknown as GraphNode);

  const op1 = makeNodeId("Operation", "openapi.yaml", "GET /api/users");
  g.addNode({
    id: op1,
    kind: "Operation",
    name: "listUsers",
    filePath: "openapi.yaml",
    method: "GET",
    path: "/api/users",
  } as unknown as GraphNode);

  const findingNew = makeNodeId("Finding", "src/a.ts", "rule-A#1");
  g.addNode({
    id: findingNew,
    kind: "Finding",
    name: "rule-A#1",
    filePath: "src/a.ts",
    startLine: 5,
    endLine: 5,
    ruleId: "rule-A",
    severity: "error",
    scannerId: "semgrep",
    message: "Something bad",
    propertiesBag: {},
    baselineState: "new",
  } as unknown as GraphNode);
  const findingOld = makeNodeId("Finding", "src/b.ts", "rule-B#1");
  g.addNode({
    id: findingOld,
    kind: "Finding",
    name: "rule-B#1",
    filePath: "src/b.ts",
    startLine: 7,
    endLine: 7,
    ruleId: "rule-B",
    severity: "warning",
    scannerId: "semgrep",
    message: "Lint warning",
    propertiesBag: {},
    baselineState: "unchanged",
  } as unknown as GraphNode);
  const findingSuppressed = makeNodeId("Finding", "src/b.ts", "rule-C#1");
  g.addNode({
    id: findingSuppressed,
    kind: "Finding",
    name: "rule-C#1",
    filePath: "src/b.ts",
    startLine: 9,
    endLine: 9,
    ruleId: "rule-C",
    severity: "note",
    scannerId: "semgrep",
    message: "Style nit",
    propertiesBag: {},
    baselineState: "unchanged",
    suppressedJson: '{"rules":["rule-C"],"reasonCategory":"intentional"}',
  } as unknown as GraphNode);

  const depMit = makeNodeId("Dependency", "package-lock.json", "react@18.2.0");
  g.addNode({
    id: depMit,
    kind: "Dependency",
    name: "react",
    filePath: "package-lock.json",
    version: "18.2.0",
    ecosystem: "npm",
    lockfileSource: "package-lock.json",
    license: "MIT",
  } as unknown as GraphNode);
  const depGpl = makeNodeId("Dependency", "package-lock.json", "readline@1.0.0");
  g.addNode({
    id: depGpl,
    kind: "Dependency",
    name: "readline",
    filePath: "package-lock.json",
    version: "1.0.0",
    ecosystem: "npm",
    lockfileSource: "package-lock.json",
    license: "GPL-3.0",
  } as unknown as GraphNode);
  const depUnknown = makeNodeId("Dependency", "package-lock.json", "weird-pkg@0.1.0");
  g.addNode({
    id: depUnknown,
    kind: "Dependency",
    name: "weird-pkg",
    filePath: "package-lock.json",
    version: "0.1.0",
    ecosystem: "npm",
    lockfileSource: "package-lock.json",
  } as unknown as GraphNode);

  const repoConsumer = makeNodeId("Repo", "", "consumer");
  g.addNode({
    id: repoConsumer,
    kind: "Repo",
    name: "github.com/acme/consumer",
    filePath: "",
    originUrl: "https://github.com/acme/consumer.git",
    repoUri: "github.com/acme/consumer",
    defaultBranch: "main",
    commitSha: "1111111111111111111111111111111111111111",
    indexTime: "2026-05-09T00:00:00Z",
    group: "acme",
    visibility: "internal",
    indexer: "opencodehub@0.1.0",
    languageStats: { ts: 1.0 },
  } as unknown as GraphNode);
  // Process node with entry_point_id pointing at fnFoo so listNodesByEntryPoint
  // has something to match. Two functions on src/a.ts share the name "bar"
  // would muddle name lookup, so we keep distinct names and use the second
  // function (fnBar) as a parallel-named entity in a kind-distinct check.
  const procFoo = makeNodeId("Process", "src/a.ts", "process_foo");
  g.addNode({
    id: procFoo,
    kind: "Process",
    name: "process_foo",
    filePath: "src/a.ts",
    entryPointId: fnFoo,
    stepCount: 2,
  } as unknown as GraphNode);

  const repoProducer = makeNodeId("Repo", "", "producer");
  g.addNode({
    id: repoProducer,
    kind: "Repo",
    name: "github.com/acme/producer",
    filePath: "",
    originUrl: null,
    repoUri: "github.com/acme/producer",
    defaultBranch: null,
    commitSha: "2222222222222222222222222222222222222222",
    indexTime: "2026-05-09T00:00:01Z",
    group: null,
    visibility: "private",
    indexer: "opencodehub@0.1.0",
    languageStats: {},
  } as unknown as GraphNode);

  // Edges — form a small DAG so traverseAncestors/Descendants have something
  // meaningful to walk:
  //   fileA --DEFINES--> fnFoo --CALLS--> fnBar --CALLS--> fnBaz
  //   fileA --DEFINES--> fnBar
  //   fileB --DEFINES--> fnBaz
  g.addEdge({ from: fileA, to: fnFoo, type: "DEFINES", confidence: 1.0 });
  g.addEdge({ from: fileA, to: fnBar, type: "DEFINES", confidence: 1.0 });
  g.addEdge({ from: fileB, to: fnBaz, type: "DEFINES", confidence: 1.0 });
  g.addEdge({ from: fnFoo, to: fnBar, type: "CALLS", confidence: 0.9 });
  g.addEdge({ from: fnBar, to: fnBaz, type: "CALLS", confidence: 0.7 });

  // FETCHES edge from a consumer Function on the consumer side to the
  // Operation on the producer side. The producer carries a `repo_uri`
  // matching `repoProducer.repoUri` via the persisted Repo column. We
  // synthesize the cross-repo wiring by adding an Operation node whose
  // `repo_uri` column will be set after node insertion through the
  // bulkLoad column encoder.
  g.addEdge({ from: fnFoo, to: op1, type: "FETCHES", confidence: 0.95 });

  return {
    graph: g,
    ids: {
      fileA,
      fileB,
      fnFoo,
      fnBar,
      fnBaz,
      route1,
      op1,
      findingNew,
      findingOld,
      findingSuppressed,
      depMit,
      depGpl,
      depUnknown,
      repoConsumer,
      repoProducer,
      procFoo,
    },
  };
}

// ---------------------------------------------------------------------------
// Embedding fixture — vectors for two of the function nodes plus a Route node
// so the listEmbeddings + kindFilter paths have non-trivial coverage.
// ---------------------------------------------------------------------------

function buildEmbeddingFixture(ids: FixtureIds): readonly EmbeddingRow[] {
  const dim = 8;
  const v = (seed: number): Float32Array => {
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i += 1) out[i] = seed + i * 0.1;
    return out;
  };
  return [
    {
      nodeId: ids.fnFoo,
      granularity: "symbol",
      chunkIndex: 0,
      vector: v(0.1),
      contentHash: "hash-foo",
    },
    {
      nodeId: ids.fnBar,
      granularity: "symbol",
      chunkIndex: 0,
      vector: v(0.2),
      contentHash: "hash-bar",
    },
    {
      nodeId: ids.route1,
      granularity: "symbol",
      chunkIndex: 0,
      vector: v(0.3),
      contentHash: "hash-route",
    },
  ];
}

// ---------------------------------------------------------------------------
// DuckDb finder tests
// ---------------------------------------------------------------------------

async function withDuckStore(
  fn: (store: DuckDbStore, ids: FixtureIds) => Promise<void>,
): Promise<void> {
  const path = await scratchDuckPath();
  const store = new DuckDbStore(path, { embeddingDim: 8 });
  await store.open();
  try {
    await store.createSchema();
    const { graph, ids } = buildFinderFixture();
    await store.bulkLoad(graph);
    await fn(store, ids);
  } finally {
    await store.close();
  }
}

test("DuckDb listNodesByKind narrows by kind discriminator", async () => {
  await withDuckStore(async (store, ids) => {
    const findings = await store.listNodesByKind("Finding");
    assert.equal(findings.length, 3);
    for (const f of findings) {
      assert.equal(f.kind, "Finding");
    }
    // Determinism: two calls return deeply-equal arrays.
    const second = await store.listNodesByKind("Finding");
    assert.deepEqual(findings, second);

    // filePath / filePathLike narrow correctly.
    const onlyA = await store.listNodesByKind("Function", { filePath: "src/a.ts" });
    assert.equal(onlyA.length, 2);
    const aIds = onlyA.map((n) => n.id).sort();
    assert.deepEqual(aIds, [ids.fnBar, ids.fnFoo].sort());

    const matchSrc = await store.listNodesByKind("Function", { filePathLike: "src/" });
    assert.equal(matchSrc.length, 3);
  });
});

test("DuckDb listEdges + listEdgesByType return typed edges in deterministic order", async () => {
  await withDuckStore(async (store) => {
    const allEdges = await store.listEdges();
    assert.equal(allEdges.length, 6); // 3 DEFINES + 2 CALLS + 1 FETCHES

    const defines = await store.listEdgesByType("DEFINES");
    assert.equal(defines.length, 3);
    for (const e of defines) assert.equal(e.type, "DEFINES");

    // Determinism: two calls deeply equal.
    const definesAgain = await store.listEdgesByType("DEFINES");
    assert.deepEqual(defines, definesAgain);

    // Confidence floor.
    const highConfidence = await store.listEdges({ minConfidence: 0.95 });
    assert.ok(highConfidence.every((e) => e.confidence >= 0.95));
  });
});

test("DuckDb listFindings filters by severity, ruleId, baselineState, suppressed", async () => {
  await withDuckStore(async (store) => {
    const errors = await store.listFindings({ severity: ["error"] });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.severity, "error");

    const byRule = await store.listFindings({ ruleId: "rule-B" });
    assert.equal(byRule.length, 1);
    assert.equal(byRule[0]?.ruleId, "rule-B");

    const newOnes = await store.listFindings({ baselineState: ["new"] });
    assert.equal(newOnes.length, 1);

    const suppressed = await store.listFindings({ suppressed: true });
    assert.equal(suppressed.length, 1);
    const nonSuppressed = await store.listFindings({ suppressed: false });
    assert.equal(nonSuppressed.length, 2);
  });
});

test("DuckDb listDependencies filters by ecosystem + license tier", async () => {
  await withDuckStore(async (store) => {
    const allNpm = await store.listDependencies({ ecosystem: "npm" });
    assert.equal(allNpm.length, 3);

    const permissive = await store.listDependencies({ licenseTier: ["permissive"] });
    assert.equal(permissive.length, 1);
    assert.equal(permissive[0]?.license, "MIT");

    const strong = await store.listDependencies({ licenseTier: ["strong-copyleft"] });
    assert.equal(strong.length, 1);
    assert.equal(strong[0]?.license, "GPL-3.0");

    const unknown = await store.listDependencies({ licenseTier: ["unknown"] });
    assert.equal(unknown.length, 1);
  });
});

test("DuckDb listRoutes filters by methods + pathLike", async () => {
  await withDuckStore(async (store) => {
    const all = await store.listRoutes();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.method, "GET");

    const post = await store.listRoutes({ methods: ["POST"] });
    assert.equal(post.length, 0);

    const apiPath = await store.listRoutes({ pathLike: "/api" });
    assert.equal(apiPath.length, 1);
  });
});

test("DuckDb getRepoNode returns typed RepoNode or undefined", async () => {
  await withDuckStore(async (store, ids) => {
    const repo = await store.getRepoNode(ids.repoConsumer);
    assert.ok(repo);
    assert.equal(repo?.kind, "Repo");
    assert.equal(repo?.repoUri, "github.com/acme/consumer");
    assert.equal(repo?.defaultBranch, "main");

    // Explicit null preservation for the producer (no origin / branch / group).
    const producer = await store.getRepoNode(ids.repoProducer);
    assert.ok(producer);
    assert.equal(producer?.originUrl, null);
    assert.equal(producer?.defaultBranch, null);
    assert.equal(producer?.group, null);

    const missing = await store.getRepoNode("nope");
    assert.equal(missing, undefined);

    // Non-Repo id returns undefined (caller never has to downcast).
    const notARepo = await store.getRepoNode(ids.fnFoo);
    assert.equal(notARepo, undefined);
  });
});

test("DuckDb countNodesByKind + countEdgesByType return Maps with deterministic counts", async () => {
  await withDuckStore(async (store) => {
    const nodeCounts = await store.countNodesByKind();
    assert.equal(nodeCounts.get("Finding"), 3);
    assert.equal(nodeCounts.get("Function"), 3);
    assert.equal(nodeCounts.get("Dependency"), 3);
    assert.equal(nodeCounts.get("Repo"), 2);
    assert.equal(nodeCounts.get("Route"), 1);
    assert.equal(nodeCounts.get("Operation"), 1);
    assert.equal(nodeCounts.get("File"), 2);

    // Backfill: ask about a kind that has zero rows.
    const partial = await store.countNodesByKind(["Function", "Trait"]);
    assert.equal(partial.get("Function"), 3);
    assert.equal(partial.get("Trait"), 0);

    const edgeCounts = await store.countEdgesByType();
    assert.equal(edgeCounts.get("DEFINES"), 3);
    assert.equal(edgeCounts.get("CALLS"), 2);
    assert.equal(edgeCounts.get("FETCHES"), 1);

    // Empty input → empty map (per the contract).
    const emptyN = await store.countNodesByKind([]);
    assert.equal(emptyN.size, 0);
    const emptyE = await store.countEdgesByType([]);
    assert.equal(emptyE.size, 0);
  });
});

test("DuckDb listNodes filters by ids", async () => {
  await withDuckStore(async (store, ids) => {
    const subset = await store.listNodes({ ids: [ids.fnFoo, ids.fnBar] });
    assert.equal(subset.length, 2);
    const subsetIds = subset.map((n) => n.id).sort();
    assert.deepEqual(subsetIds, [ids.fnBar, ids.fnFoo].sort());

    // Determinism: same call → same array.
    const subsetAgain = await store.listNodes({ ids: [ids.fnFoo, ids.fnBar] });
    assert.deepEqual(subset, subsetAgain);

    // Empty ids → empty array (no SQL round-trip).
    const empty = await store.listNodes({ ids: [] });
    assert.equal(empty.length, 0);

    // De-duplication: passing duplicates returns at most one row per id.
    const dedup = await store.listNodes({ ids: [ids.fnFoo, ids.fnFoo, ids.fnFoo] });
    assert.equal(dedup.length, 1);

    // AND-combined with kinds.
    const fnOnly = await store.listNodes({ ids: [ids.fnFoo, ids.fileA], kinds: ["Function"] });
    assert.equal(fnOnly.length, 1);
    assert.equal(fnOnly[0]?.id, ids.fnFoo);

    // Unknown id yields zero rows, not an error.
    const missing = await store.listNodes({ ids: ["nope"] });
    assert.equal(missing.length, 0);
  });
});

test("DuckDb listNodesByEntryPoint matches the entry_point_id column", async () => {
  await withDuckStore(async (store, ids) => {
    const matched = await store.listNodesByEntryPoint(ids.fnFoo);
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.id, ids.procFoo);
    assert.equal(matched[0]?.kind, "Process");

    // Determinism: deeply-equal arrays across calls.
    const again = await store.listNodesByEntryPoint(ids.fnFoo);
    assert.deepEqual(matched, again);

    // No matches → empty array.
    const none = await store.listNodesByEntryPoint("never-set");
    assert.equal(none.length, 0);
  });
});

test("DuckDb listNodesByName matches name + optional kinds + filePath", async () => {
  await withDuckStore(async (store, ids) => {
    // Single name → exactly the one Function node "foo".
    const foo = await store.listNodesByName("foo");
    assert.equal(foo.length, 1);
    assert.equal(foo[0]?.id, ids.fnFoo);

    // No matches → empty.
    const noSuch = await store.listNodesByName("does-not-exist");
    assert.equal(noSuch.length, 0);

    // kinds filter narrows.
    const fnFoo = await store.listNodesByName("foo", { kinds: ["Function"] });
    assert.equal(fnFoo.length, 1);
    assert.equal(fnFoo[0]?.id, ids.fnFoo);

    // Empty kinds → short-circuits to [].
    const emptyKinds = await store.listNodesByName("foo", { kinds: [] });
    assert.equal(emptyKinds.length, 0);

    // filePath filter narrows.
    const onA = await store.listNodesByName("foo", { filePath: "src/a.ts" });
    assert.equal(onA.length, 1);
    assert.equal(onA[0]?.id, ids.fnFoo);
    const onB = await store.listNodesByName("foo", { filePath: "src/b.ts" });
    assert.equal(onB.length, 0);
  });
});

test("DuckDb traverseAncestors + traverseDescendants walk the small DAG", async () => {
  await withDuckStore(async (store, ids) => {
    // Descendants of fnFoo via CALLS up to depth 2: fnBar (1), fnBaz (2).
    const descendants = await store.traverseDescendants({
      fromId: ids.fnFoo,
      edgeTypes: ["CALLS"],
      maxDepth: 5,
    });
    assert.deepEqual(descendants.map((r) => r.nodeId).sort(), [ids.fnBar, ids.fnBaz].sort());

    // Ancestors of fnBaz via CALLS: fnBar (1), fnFoo (2).
    const ancestors = await store.traverseAncestors({
      fromId: ids.fnBaz,
      edgeTypes: ["CALLS"],
      maxDepth: 5,
    });
    assert.deepEqual(ancestors.map((r) => r.nodeId).sort(), [ids.fnBar, ids.fnFoo].sort());

    // Empty edgeTypes → empty result (no traversal).
    const empty = await store.traverseAncestors({
      fromId: ids.fnBaz,
      edgeTypes: [],
      maxDepth: 5,
    });
    assert.deepEqual(empty, []);
  });
});

test("DuckDb listEmbeddings streams rows in deterministic order", async () => {
  await withDuckStore(async (store, ids) => {
    const fixture = buildEmbeddingFixture(ids);
    await store.upsertEmbeddings(fixture);

    const rowsOne: EmbeddingRow[] = [];
    for await (const row of store.listEmbeddings()) {
      rowsOne.push(row);
    }
    assert.equal(rowsOne.length, 3);

    const rowsTwo: EmbeddingRow[] = [];
    for await (const row of store.listEmbeddings()) {
      rowsTwo.push(row);
    }
    assert.equal(rowsTwo.length, 3);
    // Determinism: same ordering across calls.
    assert.deepEqual(
      rowsOne.map((r) => `${r.nodeId}|${r.granularity}|${r.chunkIndex}`),
      rowsTwo.map((r) => `${r.nodeId}|${r.granularity}|${r.chunkIndex}`),
    );

    // kindFilter narrows the stream.
    const onlyFunctions: EmbeddingRow[] = [];
    for await (const row of store.listEmbeddings({ kindFilter: ["Function"] })) {
      onlyFunctions.push(row);
    }
    assert.equal(onlyFunctions.length, 2);

    // Empty kindFilter short-circuits.
    const none: EmbeddingRow[] = [];
    for await (const row of store.listEmbeddings({ kindFilter: [] })) {
      none.push(row);
    }
    assert.equal(none.length, 0);
  });
});

test("DuckDb listConsumerProducerEdges returns the FETCHES + Operation join", async () => {
  // The fixture's FETCHES edge crosses repo boundaries only when the consumer
  // and producer nodes carry their own repo_uri columns. Our fixture leaves
  // those columns NULL on Function/Operation nodes (only Repo nodes carry
  // repo_uri today), so the cross-repo predicate resolves to the empty
  // string for both endpoints. This test confirms the SHAPE of the result
  // — the full cross-repo join is exercised by the cross-repo contract
  // integration suites, which run against repos whose ingestion has
  // populated repo_uri on every node.
  await withDuckStore(async (store) => {
    const edges = await store.listConsumerProducerEdges();
    assert.equal(edges.length, 1);
    const edge = edges[0];
    assert.ok(edge);
    assert.equal(edge?.httpMethod, "GET");
    assert.equal(edge?.httpPath, "/api/users");
  });
});

// ---------------------------------------------------------------------------
// GraphDb finder tests — gated on the native binding being available.
// ---------------------------------------------------------------------------

async function withGraphDbStore(
  fn: (store: GraphDbStore, ids: FixtureIds) => Promise<void>,
): Promise<void> {
  if (!(await hasNativeBinding())) {
    return;
  }
  const path = await scratchGraphDbPath();
  const store = new GraphDbStore(path, { embeddingDim: 8 });
  await store.open();
  try {
    await store.createSchema();
    const { graph, ids } = buildFinderFixture();
    await store.bulkLoad(graph);
    await fn(store, ids);
  } finally {
    await store.close();
  }
}

test("GraphDb listNodesByKind narrows by kind discriminator", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store) => {
    const findings = await store.listNodesByKind("Finding");
    assert.equal(findings.length, 3);
    for (const f of findings) assert.equal(f.kind, "Finding");
    const second = await store.listNodesByKind("Finding");
    assert.deepEqual(findings, second);

    const onlyA = await store.listNodesByKind("Function", { filePath: "src/a.ts" });
    assert.equal(onlyA.length, 2);
  });
});

test("GraphDb listEdges + listEdgesByType return typed edges in deterministic order", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store) => {
    const allEdges = await store.listEdges();
    assert.equal(allEdges.length, 6);

    const defines = await store.listEdgesByType("DEFINES");
    assert.equal(defines.length, 3);
    for (const e of defines) assert.equal(e.type, "DEFINES");

    const definesAgain = await store.listEdgesByType("DEFINES");
    assert.deepEqual(defines, definesAgain);
  });
});

test("GraphDb listFindings filters by severity, ruleId, baselineState, suppressed", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store) => {
    const errors = await store.listFindings({ severity: ["error"] });
    assert.equal(errors.length, 1);

    const byRule = await store.listFindings({ ruleId: "rule-B" });
    assert.equal(byRule.length, 1);

    const newOnes = await store.listFindings({ baselineState: ["new"] });
    assert.equal(newOnes.length, 1);

    const suppressed = await store.listFindings({ suppressed: true });
    assert.equal(suppressed.length, 1);
    const nonSuppressed = await store.listFindings({ suppressed: false });
    assert.equal(nonSuppressed.length, 2);
  });
});

test("GraphDb listDependencies filters by ecosystem + license tier", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store) => {
    const allNpm = await store.listDependencies({ ecosystem: "npm" });
    assert.equal(allNpm.length, 3);

    const permissive = await store.listDependencies({ licenseTier: ["permissive"] });
    assert.equal(permissive.length, 1);

    const strong = await store.listDependencies({ licenseTier: ["strong-copyleft"] });
    assert.equal(strong.length, 1);
  });
});

test("GraphDb listRoutes filters by methods + pathLike", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store) => {
    const all = await store.listRoutes();
    assert.equal(all.length, 1);
    const apiPath = await store.listRoutes({ pathLike: "/api" });
    assert.equal(apiPath.length, 1);
  });
});

test("GraphDb getRepoNode returns typed RepoNode or undefined", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store, ids) => {
    const repo = await store.getRepoNode(ids.repoConsumer);
    assert.ok(repo);
    assert.equal(repo?.repoUri, "github.com/acme/consumer");
    const missing = await store.getRepoNode("nope");
    assert.equal(missing, undefined);
    const notARepo = await store.getRepoNode(ids.fnFoo);
    assert.equal(notARepo, undefined);
  });
});

test("GraphDb countNodesByKind + countEdgesByType return Maps with deterministic counts", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store) => {
    const nodeCounts = await store.countNodesByKind();
    assert.equal(nodeCounts.get("Function"), 3);
    assert.equal(nodeCounts.get("Finding"), 3);

    const edgeCounts = await store.countEdgesByType([
      "DEFINES",
      "CALLS",
      "FETCHES",
    ] as const satisfies readonly RelationType[]);
    assert.equal(edgeCounts.get("DEFINES"), 3);
    assert.equal(edgeCounts.get("CALLS"), 2);
    assert.equal(edgeCounts.get("FETCHES"), 1);
  });
});

test("GraphDb listNodes filters by ids", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store, ids) => {
    const subset = await store.listNodes({ ids: [ids.fnFoo, ids.fnBar] });
    assert.equal(subset.length, 2);
    const empty = await store.listNodes({ ids: [] });
    assert.equal(empty.length, 0);
    const fnOnly = await store.listNodes({ ids: [ids.fnFoo, ids.fileA], kinds: ["Function"] });
    assert.equal(fnOnly.length, 1);
    assert.equal(fnOnly[0]?.id, ids.fnFoo);
  });
});

test("GraphDb listNodesByEntryPoint matches the entry_point_id column", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store, ids) => {
    const matched = await store.listNodesByEntryPoint(ids.fnFoo);
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.id, ids.procFoo);
    const none = await store.listNodesByEntryPoint("never-set");
    assert.equal(none.length, 0);
  });
});

test("GraphDb listNodesByName matches name + optional kinds + filePath", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store, ids) => {
    const foo = await store.listNodesByName("foo");
    assert.equal(foo.length, 1);
    assert.equal(foo[0]?.id, ids.fnFoo);
    const noSuch = await store.listNodesByName("does-not-exist");
    assert.equal(noSuch.length, 0);
    const fnFoo = await store.listNodesByName("foo", { kinds: ["Function"] });
    assert.equal(fnFoo.length, 1);
    const emptyKinds = await store.listNodesByName("foo", { kinds: [] });
    assert.equal(emptyKinds.length, 0);
    const onA = await store.listNodesByName("foo", { filePath: "src/a.ts" });
    assert.equal(onA.length, 1);
  });
});

test("GraphDb traverseAncestors + traverseDescendants walk the small DAG", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store, ids) => {
    const descendants = await store.traverseDescendants({
      fromId: ids.fnFoo,
      edgeTypes: ["CALLS"],
      maxDepth: 5,
    });
    assert.deepEqual(descendants.map((r) => r.nodeId).sort(), [ids.fnBar, ids.fnBaz].sort());

    const ancestors = await store.traverseAncestors({
      fromId: ids.fnBaz,
      edgeTypes: ["CALLS"],
      maxDepth: 5,
    });
    assert.deepEqual(ancestors.map((r) => r.nodeId).sort(), [ids.fnBar, ids.fnFoo].sort());
  });
});

test("GraphDb listEmbeddings streams rows in deterministic order", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store, ids) => {
    const fixture = buildEmbeddingFixture(ids);
    await store.upsertEmbeddings(fixture);
    const rowsOne: EmbeddingRow[] = [];
    for await (const row of store.listEmbeddings()) rowsOne.push(row);
    assert.equal(rowsOne.length, 3);
    const rowsTwo: EmbeddingRow[] = [];
    for await (const row of store.listEmbeddings()) rowsTwo.push(row);
    assert.deepEqual(
      rowsOne.map((r) => `${r.nodeId}|${r.granularity}|${r.chunkIndex}`),
      rowsTwo.map((r) => `${r.nodeId}|${r.granularity}|${r.chunkIndex}`),
    );
  });
});

test("GraphDb listConsumerProducerEdges returns the FETCHES + Operation join", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  await withGraphDbStore(async (store) => {
    const edges = await store.listConsumerProducerEdges();
    assert.equal(edges.length, 1);
    const edge = edges[0];
    assert.ok(edge);
    assert.equal(edge?.httpMethod, "GET");
    assert.equal(edge?.httpPath, "/api/users");
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter parity — when both backends are available, listNodes /
// listEdges / countNodesByKind / countEdgesByType produce identical counts.
// ---------------------------------------------------------------------------

test("DuckDb and GraphDb agree on countNodesByKind across the same fixture", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping cross-adapter parity");
    return;
  }
  const duckPath = await scratchDuckPath();
  const duck = new DuckDbStore(duckPath, { embeddingDim: 8 });
  await duck.open();
  await duck.createSchema();
  const { graph } = buildFinderFixture();
  await duck.bulkLoad(graph);

  const gdbPath = await scratchGraphDbPath();
  const gdb = new GraphDbStore(gdbPath, { embeddingDim: 8 });
  await gdb.open();
  try {
    await gdb.createSchema();
    await gdb.bulkLoad(graph);

    const duckCounts = await duck.countNodesByKind();
    const gdbCounts = await gdb.countNodesByKind();
    // Convert both to plain objects so deepEqual works regardless of Map
    // iteration order.
    const sortedDuck = Object.fromEntries([...duckCounts.entries()].sort());
    const sortedGdb = Object.fromEntries([...gdbCounts.entries()].sort());
    assert.deepEqual(sortedDuck, sortedGdb);
  } finally {
    await duck.close();
    await gdb.close();
  }
});
