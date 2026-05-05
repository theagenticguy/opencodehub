import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphDbBindingError, GraphDbStore, NotImplementedError } from "./graphdb-adapter.js";
import { openStore, resolveStoreBackend } from "./index.js";

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
  const cases: readonly (readonly [string, () => Promise<unknown>])[] = [
    ["createSchema", () => s.createSchema()],
    [
      "bulkLoad",
      () =>
        // deliberately cast — we are testing the error path, not the arg shape.
        s.bulkLoad({} as never),
    ],
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
  // On platforms that ship the native binary, `open()` will proceed past the
  // import and throw NotImplementedError instead. Accept either as a PASS so
  // the suite remains portable — the load-bearing assertion is that a
  // missing binding surfaces as GraphDbBindingError, not a bare module
  // error.
  const s = new GraphDbStore("/tmp/graph.db");
  await assert.rejects(
    () => s.open(),
    (err: unknown) => err instanceof GraphDbBindingError || err instanceof NotImplementedError,
  );
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
