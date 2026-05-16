/**
 * BOM body item #7: Parquet embeddings sidecar.
 *
 * Embeddings live in `graph.lbug` (the lbug graph backend). The sidecar
 * stages rows through `temporal.duckdb` so we can lean on DuckDB's
 * deterministic Parquet writer (`COPY (... ORDER BY ...) TO '...' (FORMAT
 * PARQUET, COMPRESSION ZSTD)`). DuckDB v1.3+ rewrote its parquet writer
 * to drop implicit timestamps so two consecutive runs produce
 * byte-identical files.
 *
 * Determinism contract — non-negotiable, mirrored by the byte-identity
 * test in `embeddings-sidecar.test.ts`:
 *
 *   1. Row order = `node_id ASC, granularity ASC, chunk_index ASC`. lbug's
 *      `listEmbeddings()` already iterates in that order; the COPY query
 *      re-asserts it on the temp table for safety.
 *   2. ZSTD compression at the DuckDB default level. Two runs against the
 *      same store contents produce byte-identical Parquet files.
 *   3. The pack manifest pins `duckdbVersion` from the runtime
 *      `SELECT version()` result so the writer version is bound to the
 *      sidecar.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EmbeddingRow, Store } from "@opencodehub/storage";

/**
 * Inputs to {@link writeEmbeddingsSidecar}. Takes a composed
 * {@link Store} so the sidecar can stream from `store.graph` and route
 * the COPY through `store.temporal`.
 */
export interface SidecarOptions {
  /** Composed graph + temporal store. */
  readonly store: Store;
  /**
   * Absolute path to the destination Parquet file. The DuckDB-backed
   * writer validates the path before interpolating into the COPY
   * statement (DuckDB does not bind COPY destinations).
   */
  readonly outPath: string;
  /**
   * Optional embedding-tier filter. When omitted, every row in the
   * embeddings table is emitted in its native ordering.
   */
  readonly granularity?: "symbol" | "file" | "community";
}

/** Backend identifier for the writer that produced the sidecar. */
export type SidecarWriterBackend = "duck-copy" | "absent";

/**
 * Determinism class stamped on the sidecar. `"strict"` when the writer
 * produces byte-identical output across runs.
 */
export type SidecarDeterminismClass = "strict";

/** Result of {@link writeEmbeddingsSidecar}. */
export interface SidecarResult {
  readonly written: boolean;
  readonly rowCount: number;
  readonly determinismClass: SidecarDeterminismClass;
  readonly writerBackend: SidecarWriterBackend;
  readonly bytesWritten: number;
  readonly pinsHint: { readonly duckdbVersion?: string };
  readonly fileHash?: string;
}

/**
 * Write the optional Parquet embeddings sidecar.
 *
 * Returns `{written: false, writerBackend: "absent"}` for empty embeddings
 * (no file on disk). Returns `{written: true, ..., fileHash}` and writes
 * a deterministic Parquet file at `opts.outPath` otherwise. The temp table
 * used to stage the COPY is dropped before the call returns.
 */
export async function writeEmbeddingsSidecar(opts: SidecarOptions): Promise<SidecarResult> {
  const { store, outPath, granularity } = opts;

  const stage = filterByGranularity(store.graph.listEmbeddings(), granularity);
  const { rowCount, duckdbVersion } = await store.temporal.exportEmbeddingsToParquet(
    stage,
    outPath,
  );

  if (rowCount === 0) {
    return {
      written: false,
      rowCount: 0,
      determinismClass: "strict",
      writerBackend: "absent",
      bytesWritten: 0,
      pinsHint: {},
    };
  }

  const bytes = await readFile(outPath);
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  return {
    written: true,
    rowCount,
    determinismClass: "strict",
    writerBackend: "duck-copy",
    bytesWritten: bytes.byteLength,
    pinsHint: { duckdbVersion },
    fileHash,
  };
}

async function* filterByGranularity(
  rows: AsyncIterable<EmbeddingRow>,
  granularity: SidecarOptions["granularity"],
): AsyncIterable<EmbeddingRow> {
  for await (const row of rows) {
    if (granularity !== undefined && row.granularity !== granularity) continue;
    yield row;
  }
}
