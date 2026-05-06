import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import { assertReadOnlyCypher } from "./cypher-guard.js";
import { GraphDbBindingError, GraphDbStore, NotImplementedError } from "./graphdb-adapter.js";
import { openStore, resolveStoreBackend } from "./index.js";

async function scratchDbPath(): Promise<string> {
  // Per-test temp directory that holds a uniquely-named database file.
  // The native binding insists on a concrete file path rather than a
  // directory; we wrap the file in its own dir so parallel tests never
  // collide on the same file.
  const dir = await mkdtemp(join(tmpdir(), "och-graphdb-"));
  return join(dir, "graph.db");
}

async function hasNativeBinding(): Promise<boolean> {
  // Dynamic import probe: the native binding either loads cleanly or the
  // platform-specific `.node` file is missing. Any dlopen failure propagates
  // through the import and we return false so the caller can skip the
  // integration test.
  try {
    await import("@ladybugdb/core");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Constructor + getters
// ---------------------------------------------------------------------------

test("GraphDbStore stores constructor path and defaults", () => {
  const s = new GraphDbStore("/tmp/graph.db");
  assert.equal(s.getPath(), "/tmp/graph.db");
  assert.equal(s.isReadOnly(), false);
  assert.equal(s.getEmbeddingDim(), 768);
  assert.equal(s.getDefaultTimeoutMs(), 5_000);
});

test("GraphDbStore honours option overrides", () => {
  const s = new GraphDbStore("/tmp/graph.db", {
    readOnly: true,
    embeddingDim: 1024,
    timeoutMs: 7_500,
  });
  assert.equal(s.isReadOnly(), true);
  assert.equal(s.getEmbeddingDim(), 1024);
  assert.equal(s.getDefaultTimeoutMs(), 7_500);
});

// ---------------------------------------------------------------------------
// Stubbed methods must throw NotImplementedError with a clear message
// ---------------------------------------------------------------------------

test("stubbed methods throw NotImplementedError tagged with method name", async () => {
  const s = new GraphDbStore("/tmp/graph.db");
  // `query` is wired to the pool in AC-M3-2 and is no longer a stub; when
  // the pool is not open it throws a generic Error, not NotImplementedError.
  // `createSchema` and `bulkLoad` were wired in AC-M3-3 Commit 1; both
  // require an open pool so their before-open behaviour is tested
  // separately below.
  // search / vectorSearch / traverse / getMeta / setMeta were wired in
  // AC-M3-3 Commit 2 and upsertEmbeddings / listEmbeddingHashes in
  // Commit 3. The remaining stubs are the cochange and symbol-summary
  // surfaces, which AC-M3-4 lands.
  const cases: readonly (readonly [string, () => Promise<unknown>])[] = [
    ["bulkLoadCochanges", () => s.bulkLoadCochanges([])],
    ["lookupCochangesForFile", () => s.lookupCochangesForFile("a")],
    ["lookupCochangesBetween", () => s.lookupCochangesBetween("a", "b")],
    ["bulkLoadSymbolSummaries", () => s.bulkLoadSymbolSummaries([])],
    ["lookupSymbolSummary", () => s.lookupSymbolSummary("a", "b", "c")],
    ["lookupSymbolSummariesByNode", () => s.lookupSymbolSummariesByNode([])],
  ];

  for (const [name, call] of cases) {
    await assert.rejects(
      call,
      (err: unknown) =>
        err instanceof NotImplementedError &&
        (err as Error).message.includes(name) &&
        (err as Error).message.includes("graph-db"),
      `${name} should throw NotImplementedError tagged with its name`,
    );
  }
});

test("query before open rejects with a clear error (pool-wired in AC-M3-2)", async () => {
  const s = new GraphDbStore("/tmp/graph.db");
  await assert.rejects(() => s.query("RETURN 1"), /before open/);
});

test("createSchema before open rejects with a clear error", async () => {
  const s = new GraphDbStore("/tmp/graph.db");
  await assert.rejects(() => s.createSchema(), /before open/);
});

test("bulkLoad before open rejects with a clear error", async () => {
  const s = new GraphDbStore("/tmp/graph.db");
  // `{} as never` is a deliberate cast — we're exercising the pre-open
  // guard, not the bulkLoad argument shape.
  await assert.rejects(() => s.bulkLoad({} as never), /before open/);
});

test("healthCheck reports pool-not-open without throwing", async () => {
  const s = new GraphDbStore("/tmp/graph.db");
  const result = await s.healthCheck();
  assert.equal(result.ok, false);
  assert.match(String(result.message), /not open/);
});

test("close is a tolerant no-op before open", async () => {
  const s = new GraphDbStore("/tmp/graph.db");
  await s.close();
  await s.close();
});

test("open surfaces GraphDbBindingError when native binding absent", async () => {
  // On platforms where the native binary is missing (e.g. container runs
  // that pruned the platform-specific optional dep), `open()` must surface
  // a typed `GraphDbBindingError` rather than a bare module-not-found
  // error. On platforms that ship the binary, `open()` succeeds — we close
  // it afterwards so this suite remains portable across both modes.
  const s = new GraphDbStore("/tmp/graph-open-probe.db");
  try {
    await s.open();
    // Binary available — confirm the pool is actually live, then clean up.
    assert.equal(s.isReadOnly(), false);
    await s.close();
  } catch (err) {
    assert.ok(
      err instanceof GraphDbBindingError,
      `expected GraphDbBindingError, got ${(err as Error).name}: ${(err as Error).message}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Factory + env var resolution
// ---------------------------------------------------------------------------

test("resolveStoreBackend defaults to duck when env unset", () => {
  assert.equal(resolveStoreBackend(undefined, {}), "duck");
  assert.equal(resolveStoreBackend("auto", {}), "duck");
});

test("resolveStoreBackend respects explicit backend over env", () => {
  assert.equal(resolveStoreBackend("duck", { CODEHUB_STORE: "lbug" }), "duck");
  assert.equal(resolveStoreBackend("lbug", { CODEHUB_STORE: "duck" }), "lbug");
});

test("resolveStoreBackend reads CODEHUB_STORE env under auto", () => {
  assert.equal(resolveStoreBackend("auto", { CODEHUB_STORE: "lbug" }), "lbug");
  assert.equal(resolveStoreBackend("auto", { CODEHUB_STORE: "duck" }), "duck");
});

test("resolveStoreBackend rejects unknown CODEHUB_STORE values", () => {
  assert.throws(
    () => resolveStoreBackend("auto", { CODEHUB_STORE: "sqlite" }),
    /Invalid CODEHUB_STORE/,
  );
});

test("openStore returns DuckDbStore when backend=duck", async () => {
  const store = await openStore({ path: ":memory:", backend: "duck" });
  assert.equal(store.constructor.name, "DuckDbStore");
});

test("openStore returns GraphDbStore when backend=lbug", async () => {
  const store = await openStore({ path: "/tmp/graph.db", backend: "lbug" });
  assert.equal(store.constructor.name, "GraphDbStore");
});

// ---------------------------------------------------------------------------
// Integration: createSchema + bulkLoad (AC-M3-3 Commit 1)
// ---------------------------------------------------------------------------
//
// These tests require the native binding. On platforms without the prebuilt
// `.node` the suite gracefully skips; every one of the code paths still gets
// exercised by the unit tests above plus the AC-M3-4 round-trip suite.

test("createSchema runs the full DDL against a fresh store", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping integration test");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    // A follow-up query against CodeNode must succeed — if the DDL
    // silently fell over on some kinds this SELECT would throw.
    const rows = await store.query("MATCH (n:CodeNode) RETURN count(n) AS c");
    assert.equal(Number((rows[0] as { c?: unknown })?.c ?? -1), 0);
  } finally {
    await store.close();
  }
});

test("bulkLoad replace mode inserts nodes and edges by kind", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping integration test");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const fileA = makeNodeId("File", "src/a.ts", "a.ts");
    const fileB = makeNodeId("File", "src/b.ts", "b.ts");
    const fnX = makeNodeId("Function", "src/a.ts", "x");
    g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });
    g.addNode({ id: fileB, kind: "File", name: "b.ts", filePath: "src/b.ts" });
    g.addNode({
      id: fnX,
      kind: "Function",
      name: "x",
      filePath: "src/a.ts",
      signature: "function x()",
      parameterCount: 0,
      isExported: true,
    });
    g.addEdge({ from: fileA, to: fnX, type: "DEFINES", confidence: 1.0 });
    g.addEdge({ from: fileA, to: fileB, type: "IMPORTS", confidence: 0.9 });

    const stats = await store.bulkLoad(g);
    assert.equal(stats.nodeCount, g.nodeCount());
    assert.equal(stats.edgeCount, g.edgeCount());

    const nCountRow = await store.query("MATCH (n:CodeNode) RETURN count(n) AS c");
    const eDefRow = await store.query("MATCH ()-[r:DEFINES]->() RETURN count(r) AS c");
    const eImpRow = await store.query("MATCH ()-[r:IMPORTS]->() RETURN count(r) AS c");
    assert.equal(Number((nCountRow[0] as { c?: unknown })?.c ?? 0), 3);
    assert.equal(Number((eDefRow[0] as { c?: unknown })?.c ?? 0), 1);
    assert.equal(Number((eImpRow[0] as { c?: unknown })?.c ?? 0), 1);
  } finally {
    await store.close();
  }
});

test("bulkLoad replace mode truncates prior rows on second call", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping integration test");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();

    const g1 = new KnowledgeGraph();
    const a = makeNodeId("File", "src/a.ts", "a.ts");
    const b = makeNodeId("File", "src/b.ts", "b.ts");
    g1.addNode({ id: a, kind: "File", name: "a.ts", filePath: "src/a.ts" });
    g1.addNode({ id: b, kind: "File", name: "b.ts", filePath: "src/b.ts" });
    g1.addEdge({ from: a, to: b, type: "IMPORTS", confidence: 1.0 });
    await store.bulkLoad(g1);

    const g2 = new KnowledgeGraph();
    const c = makeNodeId("File", "src/c.ts", "c.ts");
    g2.addNode({ id: c, kind: "File", name: "c.ts", filePath: "src/c.ts" });
    await store.bulkLoad(g2, { mode: "replace" });

    const rows = await store.query("MATCH (n:CodeNode) RETURN n.id AS id ORDER BY n.id");
    const ids = rows.map((r) => String((r as { id?: unknown }).id));
    assert.deepEqual(ids, [c]);

    // Every relation table should also be empty after a replace.
    const eRow = await store.query("MATCH ()-[r:IMPORTS]->() RETURN count(r) AS c");
    assert.equal(Number((eRow[0] as { c?: unknown })?.c ?? -1), 0);
  } finally {
    await store.close();
  }
});

test("bulkLoad upsert mode preserves rows not present in the incoming graph", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping integration test");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();

    const g1 = new KnowledgeGraph();
    const a = makeNodeId("File", "src/a.ts", "a.ts");
    const b = makeNodeId("File", "src/b.ts", "b.ts");
    g1.addNode({ id: a, kind: "File", name: "a.ts", filePath: "src/a.ts" });
    g1.addNode({ id: b, kind: "File", name: "b.ts", filePath: "src/b.ts" });
    await store.bulkLoad(g1);

    // Upsert a single file with a refreshed field; `b` must survive.
    const g2 = new KnowledgeGraph();
    g2.addNode({
      id: a,
      kind: "File",
      name: "a.ts",
      filePath: "src/a.ts",
      contentHash: "fresh",
    });
    await store.bulkLoad(g2, { mode: "upsert" });

    const rows = await store.query(
      "MATCH (n:CodeNode) RETURN n.id AS id, n.content_hash AS hash ORDER BY n.id",
    );
    const rowRecs = rows.map((r) => r as { id?: unknown; hash?: unknown });
    assert.equal(rowRecs.length, 2);
    const aRow = rowRecs.find((r) => r.id === a);
    const bRow = rowRecs.find((r) => r.id === b);
    assert.ok(aRow && bRow, "both rows should survive the upsert");
    assert.equal(aRow?.hash, "fresh");
  } finally {
    await store.close();
  }
});

test("bulkLoad cycles through every declared edge kind without fault", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping integration test");
    return;
  }
  const { getAllRelationTypes } = await import("./graphdb-schema.js");
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    // Build one node per kind we need and one edge per declared relation.
    const nodes: NodeId[] = [];
    const relationTypes = getAllRelationTypes();
    for (let i = 0; i < relationTypes.length + 1; i += 1) {
      const id = makeNodeId("Function", `src/f${i}.ts`, `fn${i}`);
      nodes.push(id);
      g.addNode({ id, kind: "Function", name: `fn${i}`, filePath: `src/f${i}.ts` });
    }
    for (let i = 0; i < relationTypes.length; i += 1) {
      const fromId = nodes[i];
      const toId = nodes[i + 1];
      if (!fromId || !toId) throw new Error("unreachable");
      g.addEdge({
        from: fromId,
        to: toId,
        type: relationTypes[i] as "CALLS",
        confidence: 0.5 + i * 0.01,
        reason: `reason-${i}`,
        step: i,
      });
    }
    await store.bulkLoad(g);

    for (const kind of relationTypes) {
      const row = await store.query(`MATCH ()-[r:${kind}]->() RETURN count(r) AS c`);
      const count = Number((row[0] as { c?: unknown })?.c ?? -1);
      assert.equal(count, 1, `kind ${kind} should have exactly one edge`);
    }
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Cypher write-guard (AC-M3-3 Commit 2)
// ---------------------------------------------------------------------------

test("assertReadOnlyCypher accepts plain MATCH ... RETURN", () => {
  assertReadOnlyCypher("MATCH (n:CodeNode) RETURN n.id LIMIT 10");
  assertReadOnlyCypher("WITH 1 AS x RETURN x");
  assertReadOnlyCypher("RETURN 1 AS one");
});

test("assertReadOnlyCypher rejects every write verb the native binding accepts", () => {
  const writes = [
    "CREATE (n:CodeNode {id: '1'})",
    "MERGE (n:CodeNode {id: '1'}) ON CREATE SET n.name = 'x'",
    "MATCH (n:CodeNode) DELETE n",
    "MATCH (n:CodeNode {id: '1'}) SET n.name = 'x'",
    "MATCH (n:CodeNode {id: '1'}) REMOVE n.name",
    "DROP TABLE CodeNode",
    "COPY CodeNode FROM 'file.csv'",
    "INSTALL FTS",
    "LOAD EXTENSION FTS",
  ];
  for (const stmt of writes) {
    assert.throws(
      () => assertReadOnlyCypher(stmt),
      /Banned keyword|Leading keyword not allowed|LOAD EXTENSION|CALL procedure|CALL requires/,
    );
  }
});

test("assertReadOnlyCypher tolerates write keywords inside line comments", () => {
  assertReadOnlyCypher("// CREATE is mentioned here but not executed\nRETURN 1 AS one");
  assertReadOnlyCypher("/* MERGE */ RETURN 1 AS one");
});

test("assertReadOnlyCypher rejects empty / non-string statements", () => {
  assert.throws(() => assertReadOnlyCypher(""), /non-empty|must contain/);
  // `as never` to sidestep the type guard — we care about the runtime
  // behaviour, which must fail cleanly rather than crash.
  assert.throws(() => assertReadOnlyCypher(null as unknown as string), /non-empty|must contain/);
});

// ---------------------------------------------------------------------------
// Integration: query / search / vectorSearch / traverse / setMeta / getMeta
// ---------------------------------------------------------------------------

test("query rejects writes but passes reads through to the pool", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    // Reads succeed.
    const rows = await store.query("MATCH (n:CodeNode) RETURN count(n) AS c");
    assert.equal(Number((rows[0] as { c?: unknown })?.c ?? -1), 0);
    // Writes are rejected up front — the pool never sees them.
    await assert.rejects(
      () => store.query("CREATE (n:CodeNode {id: 'x'})"),
      /Banned keyword|Leading keyword not allowed/,
    );
  } finally {
    await store.close();
  }
});

test("traverse (down) reaches transitive children within depth bound", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const a = makeNodeId("Function", "x.ts", "A");
    const b = makeNodeId("Function", "x.ts", "B");
    const c = makeNodeId("Function", "x.ts", "C");
    const d = makeNodeId("Function", "x.ts", "D");
    for (const [id, name] of [
      [a, "A"],
      [b, "B"],
      [c, "C"],
      [d, "D"],
    ] as const) {
      g.addNode({ id, kind: "Function", name, filePath: "x.ts" });
    }
    g.addEdge({ from: a, to: b, type: "CALLS", confidence: 1.0 });
    g.addEdge({ from: b, to: c, type: "CALLS", confidence: 1.0 });
    g.addEdge({ from: c, to: d, type: "CALLS", confidence: 1.0 });
    await store.bulkLoad(g);

    const downDepth2 = await store.traverse({
      startId: a,
      direction: "down",
      maxDepth: 2,
      relationTypes: ["CALLS"],
    });
    const reachedIds = new Set(downDepth2.map((r) => r.nodeId));
    assert.ok(reachedIds.has(b), "B should be reached at depth 1");
    assert.ok(reachedIds.has(c), "C should be reached at depth 2");
    assert.ok(!reachedIds.has(d), "D must be pruned by depth bound");

    const upFromD = await store.traverse({
      startId: d,
      direction: "up",
      maxDepth: 3,
      relationTypes: ["CALLS"],
    });
    const upIds = new Set(upFromD.map((r) => r.nodeId));
    assert.ok(upIds.has(c) && upIds.has(b) && upIds.has(a), "up traversal reaches A");
  } finally {
    await store.close();
  }
});

test("traverse respects minConfidence filter", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const a = makeNodeId("Function", "x.ts", "A");
    const b = makeNodeId("Function", "x.ts", "B");
    const c = makeNodeId("Function", "x.ts", "C");
    g.addNode({ id: a, kind: "Function", name: "A", filePath: "x.ts" });
    g.addNode({ id: b, kind: "Function", name: "B", filePath: "x.ts" });
    g.addNode({ id: c, kind: "Function", name: "C", filePath: "x.ts" });
    g.addEdge({ from: a, to: b, type: "CALLS", confidence: 0.3 });
    g.addEdge({ from: a, to: c, type: "CALLS", confidence: 0.9 });
    await store.bulkLoad(g);

    const hits = await store.traverse({
      startId: a,
      direction: "down",
      maxDepth: 1,
      relationTypes: ["CALLS"],
      minConfidence: 0.5,
    });
    const ids = new Set(hits.map((r) => r.nodeId));
    assert.ok(ids.has(c), "confident edge survives");
    assert.ok(!ids.has(b), "low-confidence edge is pruned");
  } finally {
    await store.close();
  }
});

test("search: BM25 index finds a distinct symbol name", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const ids: NodeId[] = [
      makeNodeId("Function", "src/user.ts", "parseUserProfile"),
      makeNodeId("Function", "src/view.ts", "renderMarkdownView"),
    ];
    g.addNode({
      id: ids[0] as NodeId,
      kind: "Function",
      name: "parseUserProfile",
      filePath: "src/user.ts",
      signature: "function parseUserProfile()",
    });
    g.addNode({
      id: ids[1] as NodeId,
      kind: "Function",
      name: "renderMarkdownView",
      filePath: "src/view.ts",
      signature: "function renderMarkdownView()",
    });
    await store.bulkLoad(g);

    const results = await store.search({ text: "parseUserProfile", limit: 5 });
    assert.ok(results.length >= 1, "search should return at least one row");
    const top = results[0];
    assert.ok(top);
    assert.equal(top.nodeId, ids[0]);
    assert.ok(top.score > 0, "BM25 score should be positive");
  } finally {
    await store.close();
  }
});

// NOTE: a real vectorSearch integration test lands in AC-M3-3 Commit 3
// alongside upsertEmbeddings — the vector query path is already wired here
// but it needs at least one embedding row to return non-empty results, and
// upsertEmbeddings is still a stub at this commit.

test("vectorSearch rejects vectors with the wrong dimension", async () => {
  const store = new GraphDbStore("/tmp/graph-vec-dim.db", { embeddingDim: 4 });
  // No open() — the dimension check runs before we reach the pool so the
  // test does not need a live native binding.
  await assert.rejects(
    () => store.vectorSearch({ vector: new Float32Array([1, 0]) }),
    /dimension mismatch/,
  );
});

test("setMeta → getMeta round-trips the full shape", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    const meta = {
      schemaVersion: "1.2",
      lastCommit: "abc123",
      indexedAt: "2026-05-05T00:00:00Z",
      nodeCount: 100,
      edgeCount: 250,
      stats: { files: 10, functions: 90 },
      cacheHitRatio: 0.75,
      cacheSizeBytes: 1024,
      lastCompaction: "2026-05-04T12:00:00Z",
    };
    await store.setMeta(meta);
    const read = await store.getMeta();
    assert.deepEqual(read, meta);
  } finally {
    await store.close();
  }
});

test("getMeta returns undefined on a fresh store", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    const read = await store.getMeta();
    assert.equal(read, undefined);
  } finally {
    await store.close();
  }
});

test("healthCheck returns ok once the pool is open", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    const result = await store.healthCheck();
    assert.equal(result.ok, true);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Integration: upsertEmbeddings + listEmbeddingHashes (AC-M3-3 Commit 3)
// ---------------------------------------------------------------------------

test("upsertEmbeddings dimension mismatch throws without touching the store", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath(), { embeddingDim: 4 });
  await store.open();
  try {
    await store.createSchema();
    await assert.rejects(
      () =>
        store.upsertEmbeddings([
          {
            nodeId: "x" as NodeId,
            chunkIndex: 0,
            vector: new Float32Array([1, 0]),
            contentHash: "h",
          },
        ]),
      /dimension mismatch/,
    );
  } finally {
    await store.close();
  }
});

test("listEmbeddingHashes is empty on a fresh store", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath(), { embeddingDim: 4 });
  await store.open();
  try {
    await store.createSchema();
    const hashes = await store.listEmbeddingHashes();
    assert.ok(hashes instanceof Map, "returns a Map instance");
    assert.equal(hashes.size, 0);
  } finally {
    await store.close();
  }
});

test("upsertEmbeddings writes one row per (granularity, node_id, chunk_index)", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath(), { embeddingDim: 4 });
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const fnId = makeNodeId("Function", "src/a.ts", "a");
    const fileId = makeNodeId("File", "src/a.ts", "src/a.ts");
    g.addNode({ id: fnId, kind: "Function", name: "a", filePath: "src/a.ts" });
    g.addNode({ id: fileId, kind: "File", name: "a.ts", filePath: "src/a.ts" });
    await store.bulkLoad(g);

    await store.upsertEmbeddings([
      {
        nodeId: fnId,
        granularity: "symbol",
        chunkIndex: 0,
        vector: new Float32Array([1, 0, 0, 0]),
        contentHash: "h-sym-0",
      },
      {
        nodeId: fnId,
        granularity: "symbol",
        chunkIndex: 1,
        vector: new Float32Array([1, 0, 0, 0]),
        contentHash: "h-sym-1",
      },
      {
        nodeId: fileId,
        granularity: "file",
        chunkIndex: 0,
        vector: new Float32Array([0.9, 0.1, 0, 0]),
        contentHash: "h-file",
      },
    ]);

    const hashes = await store.listEmbeddingHashes();
    assert.equal(hashes.size, 3);
    assert.equal(hashes.get(`symbol\0${fnId}\0${0}`), "h-sym-0");
    assert.equal(hashes.get(`symbol\0${fnId}\0${1}`), "h-sym-1");
    assert.equal(hashes.get(`file\0${fileId}\0${0}`), "h-file");
  } finally {
    await store.close();
  }
});

test("upsertEmbeddings overwrites rows with matching composite key", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath(), { embeddingDim: 4 });
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const fnId = makeNodeId("Function", "src/a.ts", "a");
    g.addNode({ id: fnId, kind: "Function", name: "a", filePath: "src/a.ts" });
    await store.bulkLoad(g);

    await store.upsertEmbeddings([
      {
        nodeId: fnId,
        granularity: "symbol",
        chunkIndex: 0,
        vector: new Float32Array([1, 0, 0, 0]),
        contentHash: "original",
      },
    ]);
    let hashes = await store.listEmbeddingHashes();
    assert.equal(hashes.get(`symbol\0${fnId}\0${0}`), "original");

    await store.upsertEmbeddings([
      {
        nodeId: fnId,
        granularity: "symbol",
        chunkIndex: 0,
        vector: new Float32Array([0, 1, 0, 0]),
        contentHash: "updated",
      },
    ]);
    hashes = await store.listEmbeddingHashes();
    assert.equal(hashes.size, 1, "upsert replaces the row, not duplicated");
    assert.equal(hashes.get(`symbol\0${fnId}\0${0}`), "updated");
  } finally {
    await store.close();
  }
});

test("vectorSearch returns nearest row after upsertEmbeddings", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping");
    return;
  }
  const store = new GraphDbStore(await scratchDbPath(), { embeddingDim: 4 });
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const ids: NodeId[] = [];
    const vectors = [
      [1.0, 0.0, 0.0, 0.0],
      [0.9, 0.1, 0.0, 0.0],
      [0.0, 1.0, 0.0, 0.0],
    ];
    for (let i = 0; i < vectors.length; i += 1) {
      const id = makeNodeId("File", `src/f${i}.ts`, `f${i}`);
      ids.push(id);
      g.addNode({ id, kind: "File", name: `f${i}`, filePath: `src/f${i}.ts` });
    }
    await store.bulkLoad(g);
    await store.upsertEmbeddings(
      ids.map((id, i) => ({
        nodeId: id,
        chunkIndex: 0,
        vector: new Float32Array(vectors[i] ?? []),
        contentHash: `h${i}`,
      })),
    );
    const hits = await store.vectorSearch({
      vector: new Float32Array([1.0, 0.0, 0.0, 0.0]),
      limit: 2,
    });
    assert.equal(hits.length, 2);
    // Nearest first — identical vector wins.
    assert.equal(hits[0]?.nodeId, ids[0]);
    assert.ok(
      (hits[0]?.distance ?? Number.POSITIVE_INFINITY) <=
        (hits[1]?.distance ?? Number.POSITIVE_INFINITY),
    );
  } finally {
    await store.close();
  }
});
