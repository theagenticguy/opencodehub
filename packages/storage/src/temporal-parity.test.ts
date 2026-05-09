/**
 * ITemporalStore parity gate (architecture-revised.md §AC-A-3).
 *
 * After AC-A-1 split the storage interface into {@link IGraphStore}
 * (graph-only) and {@link ITemporalStore} (tabular-only), AC-A-3 deleted
 * the residual cochange + symbol-summary methods from {@link GraphDbStore}
 * — those rows now live exclusively on the DuckDB-backed temporal view
 * regardless of which graph backend the caller picked.
 *
 * This file is the parity tripwire for that contract:
 *
 *   1. The ITemporalStore methods exposed by `openStore({backend:"duck"})`
 *      and `openStore({backend:"lbug"})` round-trip cochange + symbol
 *      summary rows identically (byte-equivalent JS values).
 *   2. The `OpenStoreResult.temporalFile` path is `<dir>/temporal.duckdb`
 *      under the `lbug` backend (sibling to `graph.lbug`) and equal to
 *      `OpenStoreResult.graphFile` under the `duck` backend (single
 *      shared connection).
 *
 * Because both backends route ITemporalStore through DuckDbStore, the
 * native graph-db binding is NOT required for these tests — we only ever
 * open the `temporal` view, never the `graph` view. The graph-tier
 * round-trip is covered by `graph-hash-parity.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "./index.js";
import type {
  CochangeRow,
  ITemporalStore,
  OpenStoreResult,
  SymbolSummaryRow,
} from "./interface.js";

async function scratchDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Path to the legacy graph.duckdb filename inside a fresh scratch dir. */
async function scratchDbPath(prefix: string): Promise<string> {
  const dir = await scratchDir(prefix);
  return join(dir, "graph.duckdb");
}

// ---------------------------------------------------------------------------
// Fixtures — small, deterministic input sets covering both surfaces.
// ---------------------------------------------------------------------------

function fixtureCochanges(): readonly CochangeRow[] {
  return [
    {
      sourceFile: "src/a.ts",
      targetFile: "src/b.ts",
      cocommitCount: 8,
      totalCommitsSource: 10,
      totalCommitsTarget: 12,
      lastCocommitAt: "2026-01-01T00:00:00.000Z",
      lift: 3.2,
    },
    {
      sourceFile: "src/a.ts",
      targetFile: "src/c.ts",
      cocommitCount: 1,
      totalCommitsSource: 10,
      totalCommitsTarget: 50,
      lastCocommitAt: "2026-01-02T00:00:00.000Z",
      lift: 0.4,
    },
    {
      sourceFile: "src/d.ts",
      targetFile: "src/a.ts",
      cocommitCount: 5,
      totalCommitsSource: 7,
      totalCommitsTarget: 10,
      lastCocommitAt: "2026-01-03T00:00:00.000Z",
      lift: 1.8,
    },
  ];
}

function fixtureSummaries(): readonly SymbolSummaryRow[] {
  return [
    {
      nodeId: "Function:src/a.ts:alpha",
      contentHash: "h1",
      promptVersion: "1",
      modelId: "anthropic.claude-haiku-4-5",
      summaryText: "Do the alpha thing.",
      signatureSummary: "(x: int) -> int",
      returnsTypeSummary: "the alpha count",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      nodeId: "Function:src/a.ts:alpha",
      contentHash: "h1",
      promptVersion: "2",
      modelId: "anthropic.claude-haiku-4-5",
      summaryText: "Do the alpha thing v2.",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    {
      nodeId: "Function:src/b.ts:beta",
      contentHash: "h2",
      promptVersion: "1",
      modelId: "anthropic.claude-haiku-4-5",
      summaryText: "Do the beta thing.",
      createdAt: "2026-01-03T00:00:00.000Z",
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers — load fixtures, snapshot the resulting state, normalise for parity
// ---------------------------------------------------------------------------

interface TemporalSnapshot {
  readonly cochangesForA: readonly CochangeRow[];
  readonly cochangesBetweenAB: CochangeRow | undefined;
  readonly summaryAlphaV1: SymbolSummaryRow | undefined;
  readonly summariesByNode: readonly SymbolSummaryRow[];
}

async function loadFixturesAndSnapshot(temporal: ITemporalStore): Promise<TemporalSnapshot> {
  await temporal.bulkLoadCochanges(fixtureCochanges());
  await temporal.bulkLoadSymbolSummaries(fixtureSummaries());
  const cochangesForA = await temporal.lookupCochangesForFile("src/a.ts");
  const cochangesBetweenAB = await temporal.lookupCochangesBetween("src/a.ts", "src/b.ts");
  const summaryAlphaV1 = await temporal.lookupSymbolSummary("Function:src/a.ts:alpha", "h1", "1");
  const summariesByNode = await temporal.lookupSymbolSummariesByNode([
    "Function:src/a.ts:alpha",
    "Function:src/b.ts:beta",
  ]);
  return { cochangesForA, cochangesBetweenAB, summaryAlphaV1, summariesByNode };
}

/**
 * Open a composed store, but only initialise its `temporal` view. The
 * graph view stays unopened — for the lbug backend that means the native
 * `@ladybugdb/core` binding is not required, since cochange + summary
 * data lives on the DuckDB-backed temporal store on every backend.
 */
async function openTemporalOnly(
  backend: "duck" | "lbug",
  dbPath: string,
): Promise<{ store: OpenStoreResult; temporal: ITemporalStore }> {
  const store = await openStore({ path: dbPath, backend });
  await store.temporal.open();
  await store.temporal.createSchema();
  return { store, temporal: store.temporal };
}

async function closeTemporalOnly(store: OpenStoreResult): Promise<void> {
  // The lbug close() also closes the (unopened) graph adapter; that path
  // is a no-op when the pool was never opened — see GraphDbStore.close().
  await store.temporal.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("temporal-parity: round-trip cochanges + summaries via openStore({backend:'duck'})", async () => {
  const dbPath = await scratchDbPath("och-temporal-parity-duck-");
  const { store, temporal } = await openTemporalOnly("duck", dbPath);
  try {
    const snapshot = await loadFixturesAndSnapshot(temporal);

    // lookupCochangesForFile defaults: minLift=1.0 → drops the 0.4 row,
    // sorts by lift DESC.
    assert.equal(snapshot.cochangesForA.length, 2);
    assert.equal(snapshot.cochangesForA[0]?.lift, 3.2);
    assert.equal(snapshot.cochangesForA[0]?.targetFile, "src/b.ts");
    assert.equal(snapshot.cochangesForA[1]?.sourceFile, "src/d.ts");

    assert.ok(snapshot.cochangesBetweenAB);
    assert.equal(snapshot.cochangesBetweenAB?.lift, 3.2);

    assert.ok(snapshot.summaryAlphaV1);
    assert.equal(snapshot.summaryAlphaV1?.summaryText, "Do the alpha thing.");
    assert.equal(snapshot.summaryAlphaV1?.signatureSummary, "(x: int) -> int");

    // (node_id ASC, prompt_version ASC, content_hash ASC) — three rows
    // for the two requested nodes (alpha v1 + alpha v2 + beta v1).
    assert.equal(snapshot.summariesByNode.length, 3);
    assert.equal(snapshot.summariesByNode[0]?.nodeId, "Function:src/a.ts:alpha");
    assert.equal(snapshot.summariesByNode[0]?.promptVersion, "1");
    assert.equal(snapshot.summariesByNode[1]?.nodeId, "Function:src/a.ts:alpha");
    assert.equal(snapshot.summariesByNode[1]?.promptVersion, "2");
    assert.equal(snapshot.summariesByNode[2]?.nodeId, "Function:src/b.ts:beta");
  } finally {
    await closeTemporalOnly(store);
  }
});

test("temporal-parity: round-trip cochanges + summaries via openStore({backend:'lbug'})", async () => {
  const dbPath = await scratchDbPath("och-temporal-parity-lbug-");
  const { store, temporal } = await openTemporalOnly("lbug", dbPath);
  try {
    const snapshot = await loadFixturesAndSnapshot(temporal);

    assert.equal(snapshot.cochangesForA.length, 2);
    assert.equal(snapshot.cochangesForA[0]?.lift, 3.2);
    assert.ok(snapshot.cochangesBetweenAB);
    assert.equal(snapshot.cochangesBetweenAB?.lift, 3.2);
    assert.ok(snapshot.summaryAlphaV1);
    assert.equal(snapshot.summaryAlphaV1?.summaryText, "Do the alpha thing.");
    assert.equal(snapshot.summariesByNode.length, 3);
  } finally {
    await closeTemporalOnly(store);
  }
});

test("temporal-parity: openStore composes identical temporal snapshots across backends", async () => {
  const duckPath = await scratchDbPath("och-temporal-parity-cross-duck-");
  const lbugPath = await scratchDbPath("och-temporal-parity-cross-lbug-");

  const { store: duckStore, temporal: duckTemporal } = await openTemporalOnly("duck", duckPath);
  const { store: lbugStore, temporal: lbugTemporal } = await openTemporalOnly("lbug", lbugPath);

  try {
    const a = await loadFixturesAndSnapshot(duckTemporal);
    const b = await loadFixturesAndSnapshot(lbugTemporal);

    // The two backends route ITemporalStore through DuckDbStore — every
    // method returns identical values for identical inputs. JSON round-
    // trip pins the equality across the readonly + spread shapes vitest
    // would otherwise treat as deeply distinct.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  } finally {
    await closeTemporalOnly(duckStore);
    await closeTemporalOnly(lbugStore);
  }
});

test("openStore({backend:'lbug'}) splits artifacts into graph.lbug + temporal.duckdb siblings", async () => {
  // AC-A-3 §4 — the temporal store lives at <dir>/temporal.duckdb, the
  // graph store at <dir>/graph.lbug, regardless of the legacy filename
  // the caller passes through.
  const dbPath = await scratchDbPath("och-temporal-parity-paths-");
  const store = await openStore({ path: dbPath, backend: "lbug" });
  try {
    const dir = join(dbPath, "..");
    assert.equal(store.graphFile, join(dir, "graph.lbug"));
    assert.equal(store.temporalFile, join(dir, "temporal.duckdb"));
    assert.notEqual(store.graphFile, store.temporalFile);
  } finally {
    // Neither view was opened — close() is a no-op on each adapter.
    await store.close();
  }
});

test("openStore({backend:'duck'}) collapses graph + temporal to the same DuckDB connection", async () => {
  const dbPath = await scratchDbPath("och-temporal-parity-duck-paths-");
  const store = await openStore({ path: dbPath, backend: "duck" });
  try {
    assert.equal(store.graphFile, dbPath);
    assert.equal(store.temporalFile, dbPath);
    // Identity equality — the same DuckDbStore instance fronts both views.
    assert.equal(store.graph as unknown, store.temporal as unknown);
  } finally {
    await store.close();
  }
});
