import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDbStore } from "./duckdb-adapter.js";

async function scratchDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-storage-duck-"));
  return join(dir, "temporal.duckdb");
}

// ---------------------------------------------------------------------------
// Cochanges
// ---------------------------------------------------------------------------

test("bulkLoadCochanges: replaces rows and sorts insertion deterministically", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    await store.bulkLoadCochanges([
      {
        sourceFile: "src/a.ts",
        targetFile: "src/b.ts",
        cocommitCount: 10,
        totalCommitsSource: 20,
        totalCommitsTarget: 15,
        lastCocommitAt: "2026-01-01T00:00:00.000Z",
        lift: 2.5,
      },
      {
        sourceFile: "src/a.ts",
        targetFile: "src/c.ts",
        cocommitCount: 3,
        totalCommitsSource: 20,
        totalCommitsTarget: 30,
        lastCocommitAt: "2026-02-01T00:00:00.000Z",
        lift: 0.7,
      },
    ]);

    const rows = await store.exec(
      "SELECT source_file, target_file, cocommit_count, lift FROM cochanges ORDER BY source_file, target_file",
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.["target_file"], "src/b.ts");
    assert.equal(rows[1]?.["target_file"], "src/c.ts");

    // Second bulk load fully replaces prior contents.
    await store.bulkLoadCochanges([
      {
        sourceFile: "src/x.ts",
        targetFile: "src/y.ts",
        cocommitCount: 2,
        totalCommitsSource: 4,
        totalCommitsTarget: 5,
        lastCocommitAt: "2026-03-01T00:00:00.000Z",
        lift: 5.0,
      },
    ]);
    const after = await store.exec("SELECT source_file FROM cochanges");
    assert.equal(after.length, 1);
    assert.equal(after[0]?.["source_file"], "src/x.ts");
  } finally {
    await store.close();
  }
});

test("lookupCochangesForFile: ranks by lift and filters below minLift", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    await store.bulkLoadCochanges([
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
    ]);

    const defaults = await store.lookupCochangesForFile("src/a.ts");
    // Defaults: minLift=1.0, drops the 0.4 row; sorted by lift DESC.
    assert.equal(defaults.length, 2);
    assert.equal(defaults[0]?.lift, 3.2);
    assert.equal(defaults[0]?.targetFile, "src/b.ts");
    assert.equal(defaults[1]?.sourceFile, "src/d.ts");

    const weak = await store.lookupCochangesForFile("src/a.ts", { minLift: 0 });
    assert.equal(weak.length, 3);

    const capped = await store.lookupCochangesForFile("src/a.ts", { limit: 1 });
    assert.equal(capped.length, 1);
    assert.equal(capped[0]?.targetFile, "src/b.ts");
  } finally {
    await store.close();
  }
});

test("lookupCochangesBetween: returns the row in either ordering", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoadCochanges([
      {
        sourceFile: "src/a.ts",
        targetFile: "src/b.ts",
        cocommitCount: 4,
        totalCommitsSource: 6,
        totalCommitsTarget: 6,
        lastCocommitAt: "2026-01-01T00:00:00.000Z",
        lift: 2.0,
      },
    ]);
    const forward = await store.lookupCochangesBetween("src/a.ts", "src/b.ts");
    const reverse = await store.lookupCochangesBetween("src/b.ts", "src/a.ts");
    assert.ok(forward);
    assert.ok(reverse);
    assert.equal(forward?.lift, 2.0);
    assert.equal(reverse?.lift, 2.0);

    const missing = await store.lookupCochangesBetween("src/a.ts", "src/zzz.ts");
    assert.equal(missing, undefined);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Symbol summaries
// ---------------------------------------------------------------------------

test("bulkLoadSymbolSummaries: inserts rows and supports single-row lookup", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "hash-a",
        promptVersion: "1",
        modelId: "anthropic.claude-haiku-4-5",
        summaryText: "Do the alpha thing.",
        signatureSummary: "(x: int) -> int",
        returnsTypeSummary: "the alpha count",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/b.ts:beta",
        contentHash: "hash-b",
        promptVersion: "1",
        modelId: "anthropic.claude-haiku-4-5",
        summaryText: "Do the beta thing.",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    const hit = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-a", "1");
    assert.ok(hit);
    assert.equal(hit?.summaryText, "Do the alpha thing.");
    assert.equal(hit?.signatureSummary, "(x: int) -> int");
    assert.equal(hit?.returnsTypeSummary, "the alpha count");

    // Cache miss on any slot of the composite key → undefined.
    const missHash = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-x", "1");
    assert.equal(missHash, undefined);
    const missPrompt = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-a", "2");
    assert.equal(missPrompt, undefined);
    const missNode = await store.lookupSymbolSummary("Function:src/a.ts:zeta", "hash-a", "1");
    assert.equal(missNode, undefined);
  } finally {
    await store.close();
  }
});

test("bulkLoadSymbolSummaries: re-insert on same composite key overwrites row", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "hash-a",
        promptVersion: "1",
        modelId: "m1",
        summaryText: "first",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "hash-a",
        promptVersion: "1",
        modelId: "m2",
        summaryText: "second",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    const hit = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-a", "1");
    assert.equal(hit?.summaryText, "second");
    assert.equal(hit?.modelId, "m2");
  } finally {
    await store.close();
  }
});

test("lookupSymbolSummariesByNode: returns rows for every requested node, ordered deterministically", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "h1",
        promptVersion: "2",
        modelId: "m",
        summaryText: "alpha v2",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "h1",
        promptVersion: "1",
        modelId: "m",
        summaryText: "alpha v1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/b.ts:beta",
        contentHash: "h2",
        promptVersion: "1",
        modelId: "m",
        summaryText: "beta",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/c.ts:gamma",
        contentHash: "h3",
        promptVersion: "1",
        modelId: "m",
        summaryText: "gamma",
        createdAt: "2026-01-04T00:00:00.000Z",
      },
    ]);
    const hits = await store.lookupSymbolSummariesByNode([
      "Function:src/a.ts:alpha",
      "Function:src/b.ts:beta",
    ]);
    assert.equal(hits.length, 3);
    // Ordered by (node_id ASC, prompt_version ASC, content_hash ASC).
    assert.equal(hits[0]?.nodeId, "Function:src/a.ts:alpha");
    assert.equal(hits[0]?.promptVersion, "1");
    assert.equal(hits[1]?.nodeId, "Function:src/a.ts:alpha");
    assert.equal(hits[1]?.promptVersion, "2");
    assert.equal(hits[2]?.nodeId, "Function:src/b.ts:beta");

    const empty = await store.lookupSymbolSummariesByNode([]);
    assert.equal(empty.length, 0);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// exec + healthCheck
// ---------------------------------------------------------------------------

test("exec + healthCheck round-trip on a fresh schema", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const h = await store.healthCheck();
    assert.equal(h.ok, true);

    // The temporal schema exposes cochanges + symbol_summaries — any other
    // graph-tier table must not exist.
    const cochangeCount = await store.exec("SELECT COUNT(*) AS n FROM cochanges");
    const summaryCount = await store.exec("SELECT COUNT(*) AS n FROM symbol_summaries");
    assert.equal(Number(cochangeCount[0]?.["n"]), 0);
    assert.equal(Number(summaryCount[0]?.["n"]), 0);

    // Graph-tier tables (nodes / relations / embeddings) must NOT exist.
    await assert.rejects(
      () => store.exec("SELECT COUNT(*) FROM nodes"),
      /nodes/,
      "temporal.duckdb must not carry the nodes table",
    );

    // exec rejects writes via the SQL guard.
    await assert.rejects(
      () => store.exec("CREATE TABLE x (a INT)"),
      /CREATE/,
      "exec must reject writes",
    );
  } finally {
    await store.close();
  }
});
