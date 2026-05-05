import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
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
  const cases: readonly (readonly [string, () => Promise<unknown>])[] = [
    ["upsertEmbeddings", () => s.upsertEmbeddings([])],
    ["listEmbeddingHashes", () => s.listEmbeddingHashes()],
    ["search", () => s.search({ text: "x" })],
    ["vectorSearch", () => s.vectorSearch({ vector: new Float32Array([0]) })],
    ["traverse", () => s.traverse({ startId: "x", direction: "both", maxDepth: 1 })],
    ["getMeta", () => s.getMeta()],
    [
      "setMeta",
      () =>
        s.setMeta({
          schemaVersion: "0",
          indexedAt: "1970-01-01T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
        }),
    ],
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
