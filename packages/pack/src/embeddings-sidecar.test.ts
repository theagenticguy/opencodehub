/**
 * Tests for `writeEmbeddingsSidecar`.
 *
 * The sidecar streams embeddings out of the graph store (lbug in production)
 * into a per-call temp table on `temporal.duckdb`, then runs DuckDB's
 * deterministic `COPY (... ORDER BY ...) TO '...' (FORMAT PARQUET, COMPRESSION
 * ZSTD)` to produce the byte-identical Parquet sidecar.
 *
 * Coverage tiers:
 *   1. Mock-only dispatch: empty input → no file; non-empty input → file with
 *      hash + size + duckdbVersion stamped.
 *   2. Real-backend byte-identity: opens a real DuckDbStore as the temporal
 *      view, drives a synthetic graph stream through it, runs the sidecar
 *      twice, asserts file SHA equality. Skipped when native DuckDB binding
 *      can't load.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, test } from "node:test";
import type { EmbeddingRow, Store } from "@opencodehub/storage";

import { writeEmbeddingsSidecar } from "./embeddings-sidecar.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sidecar-"));
}

interface MockOpts {
  readonly rows: readonly EmbeddingRow[];
  /** Override the COPY step. When omitted, writes a deterministic placeholder. */
  readonly export?: (
    rows: AsyncIterable<EmbeddingRow>,
    absPath: string,
  ) => Promise<{ readonly rowCount: number; readonly duckdbVersion: string }>;
}

function makeMockStore(opts: MockOpts): Store {
  const graph = {
    listEmbeddings: async function* () {
      for (const row of opts.rows) yield row;
    },
  } as unknown as Store["graph"];

  const exporter =
    opts.export ??
    (async (rows: AsyncIterable<EmbeddingRow>, absPath: string) => {
      let n = 0;
      const buf: string[] = [];
      for await (const r of rows) {
        n += 1;
        buf.push(
          `${r.nodeId}\t${r.granularity ?? "symbol"}\t${r.chunkIndex}\t${[...r.vector].join(",")}`,
        );
      }
      if (n > 0) await writeFile(absPath, buf.join("\n"));
      return { rowCount: n, duckdbVersion: "mock-1.0.0" };
    });

  const temporal = {
    exportEmbeddingsToParquet: exporter,
  } as unknown as Store["temporal"];

  return {
    graph,
    temporal,
    graphFile: ":memory:",
    temporalFile: ":memory:",
    close: async () => {},
  };
}

describe("writeEmbeddingsSidecar — mock dispatch", () => {
  it("returns written=false, writerBackend=absent for empty embeddings", async () => {
    const dir = await tempDir();
    try {
      const store = makeMockStore({ rows: [] });
      const outPath = path.join(dir, "embeddings.parquet");
      const result = await writeEmbeddingsSidecar({ store, outPath });
      assert.equal(result.written, false);
      assert.equal(result.writerBackend, "absent");
      assert.equal(result.determinismClass, "strict");
      assert.equal(result.rowCount, 0);
      assert.equal(result.bytesWritten, 0);
      assert.equal(result.fileHash, undefined);
      assert.equal(result.pinsHint.duckdbVersion, undefined);
      assert.equal(existsSync(outPath), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns written=true with hash + size + duckdbVersion when rows are present", async () => {
    const dir = await tempDir();
    try {
      const rows: EmbeddingRow[] = [
        {
          nodeId: "Function:a.ts:fn",
          granularity: "symbol",
          chunkIndex: 0,
          vector: new Float32Array([0.1, 0.2, 0.3]),
          contentHash: "h-0",
        },
      ];
      const store = makeMockStore({ rows });
      const outPath = path.join(dir, "embeddings.parquet");
      const result = await writeEmbeddingsSidecar({ store, outPath });
      assert.equal(result.written, true);
      assert.equal(result.writerBackend, "duck-copy");
      assert.equal(result.determinismClass, "strict");
      assert.equal(result.rowCount, 1);
      assert.ok(result.bytesWritten > 0);
      assert.equal(result.pinsHint.duckdbVersion, "mock-1.0.0");
      assert.ok(result.fileHash && result.fileHash.length === 64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters by granularity when supplied", async () => {
    const dir = await tempDir();
    try {
      const rows: EmbeddingRow[] = [
        {
          nodeId: "n1",
          granularity: "symbol",
          chunkIndex: 0,
          vector: new Float32Array([1]),
          contentHash: "h",
        },
        {
          nodeId: "n2",
          granularity: "file",
          chunkIndex: 0,
          vector: new Float32Array([2]),
          contentHash: "h",
        },
      ];
      const store = makeMockStore({ rows });
      const outPath = path.join(dir, "embeddings.parquet");
      const result = await writeEmbeddingsSidecar({
        store,
        outPath,
        granularity: "file",
      });
      assert.equal(result.rowCount, 1, "granularity filter must drop non-matches");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real-backend byte-identity test — opens a real DuckDbStore for temporal,
// drives a synthetic graph stream, asserts SHA equality across two runs.
// ---------------------------------------------------------------------------

test("byte-identity: two runs against same input produce identical Parquet", async () => {
  let DuckDbStore: typeof import("@opencodehub/storage").DuckDbStore;
  try {
    ({ DuckDbStore } = await import("@opencodehub/storage"));
  } catch (err) {
    assert.ok(true, `skipping: workspace import failed (${(err as Error).message})`);
    return;
  }

  const dir = await tempDir();
  const dbPath = path.join(dir, "temporal.duckdb");
  const outA = path.join(dir, "a.parquet");
  const outB = path.join(dir, "b.parquet");

  let temporal: import("@opencodehub/storage").DuckDbStore;
  try {
    temporal = new DuckDbStore(dbPath);
    await temporal.open();
    await temporal.createSchema();
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    assert.ok(
      true,
      `skipping byte-identity test: DuckDB binding unavailable (${(err as Error).message})`,
    );
    return;
  }

  try {
    const rows: EmbeddingRow[] = Array.from({ length: 100 }, (_, i) => ({
      nodeId: `Function:src/f${i}.ts:f${i}`,
      granularity: "symbol" as const,
      chunkIndex: 0,
      vector: deterministicVector(i, 64),
      contentHash: `h-${i.toString().padStart(3, "0")}`,
    }));

    const graph = {
      listEmbeddings: async function* () {
        for (const row of rows) yield row;
      },
    } as unknown as Store["graph"];

    const composed: Store = {
      graph,
      temporal,
      graphFile: ":memory:",
      temporalFile: dbPath,
      close: async () => {
        /* test owns lifecycle */
      },
    };

    const r1 = await writeEmbeddingsSidecar({ store: composed, outPath: outA });
    const r2 = await writeEmbeddingsSidecar({ store: composed, outPath: outB });

    assert.equal(r1.written, true);
    assert.equal(r2.written, true);
    assert.equal(r1.rowCount, 100);
    assert.equal(r2.rowCount, 100);
    assert.equal(r1.writerBackend, "duck-copy");
    assert.ok(r1.pinsHint.duckdbVersion && r1.pinsHint.duckdbVersion.length > 0);
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
    await temporal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function deterministicVector(rowIndex: number, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let s = (rowIndex * 2654435761) >>> 0;
  for (let i = 0; i < dim; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}
