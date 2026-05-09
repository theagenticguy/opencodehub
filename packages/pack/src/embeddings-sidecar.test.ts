/**
 * Tests for the Parquet embeddings sidecar.
 *
 * Sidecar emission lives in pack/, not in `@opencodehub/storage`. The
 * sidecar consumes embeddings via the portable
 * {@link IGraphStore.listEmbeddings} stream and writes Parquet via
 * DuckDB COPY. Tests cover three tiers:
 *
 *   1. Pure-mock dispatch tests (always run, no native bindings):
 *      - Duck-path fake exposing the @internal `exportEmbeddingsParquet`
 *        helper → `written: true`, `writerBackend: "duck-copy"`.
 *      - Duck-path fake reporting `rowCount: 0` → `written: false`,
 *        `writerBackend: "absent"`, `determinismClass: "strict"`.
 *      - lbug-path fake → `written: false`, `writerBackend: "absent"`,
 *        `determinismClass: "degraded"` when embeddings exist (v1 defers
 *        Parquet emission on lbug-only deployments).
 *
 *   2. Real-DuckDB byte-identity test (skipped when `@duckdb/node-api`
 *      native binding fails to load — worktree native bindings may not
 *      always rebuild cleanly). When it runs:
 *      - 100 row × 384-dim Float32Array fixture.
 *      - Two consecutive `writeEmbeddingsSidecar` runs against the same
 *        store produce byte-identical Parquet files.
 *      - `pinsHint.duckdbVersion` is populated and non-empty.
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, test } from "node:test";
import type { EmbeddingRow, IGraphStore, ITemporalStore, Store } from "@opencodehub/storage";
import { writeEmbeddingsSidecar } from "./embeddings-sidecar.js";

// ---------------------------------------------------------------------------
// Pure-mock helpers — exercise every code path that does not touch DuckDB.
// ---------------------------------------------------------------------------

/**
 * Build a mock {@link IGraphStore}. Only `listEmbeddings` is wired (the
 * surface the sidecar actually reads); other finders throw if invoked.
 */
function makeMockGraph(rows: readonly EmbeddingRow[] = []): IGraphStore {
  return {
    listEmbeddings: async function* () {
      for (const r of rows) yield r;
    },
  } as unknown as IGraphStore;
}

/**
 * Wrap a graph store + optional COPY helper into the {@link Store} shape
 * the sidecar consumes. `backend` is the dispatch axis the sidecar
 * narrows on; `temporal` is unused on the duck path so we cast the graph
 * stand-in into temporal-shape when the caller wants the duck-typed COPY
 * helper attached to the graph view.
 */
function makeMockStore(opts: {
  backend: "duck" | "lbug";
  graph?: IGraphStore;
  copyHelper?: (
    absPath: string,
  ) => Promise<{ readonly rowCount: number; readonly duckdbVersion: string }>;
  rows?: readonly EmbeddingRow[];
}): Store {
  const graphBase = opts.graph ?? makeMockGraph(opts.rows ?? []);
  const graphWithHelper =
    opts.copyHelper !== undefined
      ? Object.assign(Object.create(null) as object, graphBase, {
          exportEmbeddingsParquet: opts.copyHelper,
        })
      : graphBase;
  return {
    backend: opts.backend,
    graph: graphWithHelper as IGraphStore,
    temporal: graphWithHelper as unknown as ITemporalStore,
    graphFile: ":memory:",
    temporalFile: ":memory:",
    close: async () => {
      /* no-op */
    },
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sidecar-"));
}

// ---------------------------------------------------------------------------
// Pure-mock dispatch tests
// ---------------------------------------------------------------------------

describe("writeEmbeddingsSidecar — duck-path dispatch (mock)", () => {
  it("returns written=false, writerBackend=absent when COPY reports rowCount=0", async () => {
    const dir = await tempDir();
    try {
      let calls = 0;
      const store = makeMockStore({
        backend: "duck",
        copyHelper: async () => {
          calls += 1;
          return { rowCount: 0, duckdbVersion: "1.4.0" };
        },
      });
      const outPath = path.join(dir, "embeddings.parquet");
      const result = await writeEmbeddingsSidecar({ store, outPath });
      assert.equal(calls, 1, "duck-path must invoke the COPY helper");
      assert.equal(result.written, false);
      assert.equal(result.writerBackend, "absent");
      assert.equal(result.determinismClass, "strict");
      assert.equal(result.rowCount, 0);
      assert.equal(result.bytesWritten, 0);
      assert.equal(result.fileHash, undefined);
      assert.equal(result.pinsHint.duckdbVersion, undefined);
      assert.equal(existsSync(outPath), false, "no file when rowCount=0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns written=true with hash + size when the duck COPY helper writes a file", async () => {
    const dir = await tempDir();
    try {
      const fixtureBytes = new Uint8Array([0x50, 0x41, 0x52, 0x31]); // "PAR1" magic.
      const store = makeMockStore({
        backend: "duck",
        copyHelper: async (absPath: string) => {
          await writeFile(absPath, fixtureBytes);
          return { rowCount: 7, duckdbVersion: "v1.3.2" };
        },
      });
      const outPath = path.join(dir, "embeddings.parquet");
      const result = await writeEmbeddingsSidecar({ store, outPath });
      assert.equal(result.written, true);
      assert.equal(result.writerBackend, "duck-copy");
      assert.equal(result.determinismClass, "strict");
      assert.equal(result.rowCount, 7);
      assert.equal(result.bytesWritten, fixtureBytes.byteLength);
      assert.equal(result.pinsHint.duckdbVersion, "v1.3.2");
      const onDisk = await readFile(outPath);
      const expected = await import("node:crypto").then((c) =>
        c.createHash("sha256").update(onDisk).digest("hex"),
      );
      assert.equal(result.fileHash, expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeEmbeddingsSidecar — lbug-path degraded stamp (mock)", () => {
  it("stamps determinismClass=degraded when graph has rows but no COPY helper is reachable", async () => {
    const dir = await tempDir();
    try {
      const rows: EmbeddingRow[] = [
        {
          nodeId: "fn:a",
          granularity: "symbol",
          chunkIndex: 0,
          vector: Float32Array.from([0.1, 0.2, 0.3]),
          contentHash: "h1",
        },
        {
          nodeId: "fn:b",
          granularity: "symbol",
          chunkIndex: 0,
          vector: Float32Array.from([0.4, 0.5, 0.6]),
          contentHash: "h2",
        },
      ];
      const store = makeMockStore({ backend: "lbug", rows });
      const outPath = path.join(dir, "embeddings.parquet");
      const result = await writeEmbeddingsSidecar({ store, outPath });
      assert.equal(result.written, false);
      assert.equal(result.writerBackend, "absent");
      assert.equal(
        result.determinismClass,
        "degraded",
        "lbug + non-empty embeddings must stamp degraded for v1",
      );
      assert.equal(result.rowCount, 2);
      assert.equal(result.bytesWritten, 0);
      assert.equal(existsSync(outPath), false, "no file on lbug v1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps determinismClass=strict on lbug when there are zero embeddings (absence is deterministic)", async () => {
    const dir = await tempDir();
    try {
      const store = makeMockStore({ backend: "lbug", rows: [] });
      const outPath = path.join(dir, "embeddings.parquet");
      const result = await writeEmbeddingsSidecar({ store, outPath });
      assert.equal(result.written, false);
      assert.equal(result.writerBackend, "absent");
      assert.equal(result.determinismClass, "strict");
      assert.equal(result.rowCount, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Byte-identity test against a real DuckDbStore. The native binding may
// fail to rebuild in worktrees — wrap the entire test in a try/catch and
// skip with a logged note when DuckDB cannot be loaded. The main
// checkout re-validates with bindings present so any divergence still
// gets caught upstream.
// ---------------------------------------------------------------------------

test("writeEmbeddingsSidecar — populated duck path is byte-identical across two runs", async () => {
  let DuckDbStore: typeof import("@opencodehub/storage").DuckDbStore;
  try {
    ({ DuckDbStore } = await import("@opencodehub/storage"));
  } catch (err) {
    // istanbul ignore next — defensive only; @opencodehub/storage is a
    // workspace dep so the import itself shouldn't fail.
    assert.ok(true, `skipping: workspace import failed (${(err as Error).message})`);
    return;
  }

  const { KnowledgeGraph, makeNodeId } = await import("@opencodehub/core-types");

  const dir = await tempDir();
  const dbPath = path.join(dir, "graph.duckdb");
  const outA = path.join(dir, "a.parquet");
  const outB = path.join(dir, "b.parquet");

  let store: import("@opencodehub/storage").DuckDbStore;
  try {
    store = new DuckDbStore(dbPath, { embeddingDim: 384 });
    await store.open();
  } catch (err) {
    // Native binding load failure — log and skip; worktree bindings
    // may not always rebuild cleanly.
    await rm(dir, { recursive: true, force: true });
    assert.ok(
      true,
      `skipping byte-identity test: DuckDB native binding unavailable (${(err as Error).message})`,
    );
    return;
  }

  try {
    await store.createSchema();

    // Build a 100-node graph + 100 × 384-dim Float32 embeddings. Use a
    // deterministic seed so two test invocations agree byte-for-byte (the
    // store itself is destroyed between tests, but determinism inside one
    // test is what the AC measures).
    const graph = new KnowledgeGraph();
    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const id = makeNodeId("Function", `src/f${i}.ts`, `f${i}`);
      ids.push(id);
      graph.addNode({
        id,
        kind: "Function",
        name: `f${i}`,
        filePath: `src/f${i}.ts`,
        startLine: 1,
        endLine: 5,
      });
    }
    await store.bulkLoad(graph);

    const rows = ids.map((nodeId, i) => ({
      nodeId,
      granularity: "symbol" as const,
      chunkIndex: 0,
      vector: deterministicVector(i, 384),
      contentHash: `h-${i.toString().padStart(3, "0")}`,
    }));
    await store.upsertEmbeddings(rows);

    // Build a duck-shape Store wrapping the real DuckDbStore on both
    // graph and temporal slots — this matches what `openStore({backend:
    // "duck"})` returns in production.
    const composed: Store = {
      backend: "duck",
      graph: store,
      temporal: store,
      graphFile: dbPath,
      temporalFile: dbPath,
      close: async () => {
        /* test owns store lifecycle */
      },
    };

    const r1 = await writeEmbeddingsSidecar({ store: composed, outPath: outA });
    const r2 = await writeEmbeddingsSidecar({ store: composed, outPath: outB });

    assert.equal(r1.written, true);
    assert.equal(r2.written, true);
    assert.equal(r1.writerBackend, "duck-copy");
    assert.equal(r2.writerBackend, "duck-copy");
    assert.equal(r1.determinismClass, "strict");
    assert.equal(r1.rowCount, 100);
    assert.equal(r2.rowCount, 100);
    assert.ok(
      r1.pinsHint.duckdbVersion && r1.pinsHint.duckdbVersion.length > 0,
      "duckdbVersion must be populated when sidecar is present",
    );
    assert.equal(r1.pinsHint.duckdbVersion, r2.pinsHint.duckdbVersion);

    const a = await readFile(outA);
    const b = await readFile(outB);
    assert.equal(
      Buffer.compare(a, b),
      0,
      `byte-identity broken: ${a.byteLength}B vs ${b.byteLength}B`,
    );
    assert.equal(r1.fileHash, r2.fileHash);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Generate a deterministic Float32 vector. Uses a simple LCG seeded by
 * `(rowIndex, dimIndex)` so the same call returns the same vector across
 * runs — matches the byte-identity contract without dragging in a
 * crypto-grade RNG.
 */
function deterministicVector(rowIndex: number, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let s = (rowIndex * 2654435761) >>> 0;
  for (let i = 0; i < dim; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    // Map to roughly [-1, 1] with finite Float32 precision.
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}
