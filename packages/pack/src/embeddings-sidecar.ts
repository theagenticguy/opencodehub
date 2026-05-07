/**
 * BOM body item: Parquet embeddings sidecar (AC-M5-6 — item 7/9).
 *
 * Streams the live `embeddings` table to a Parquet file via DuckDB
 * `COPY ... TO ... (FORMAT PARQUET, COMPRESSION ZSTD)`. Optional by
 * design: when no embeddings exist the sidecar is ABSENT — no file on
 * disk and {@link generatePack} omits it from `manifest.files[]` (S-M5-3).
 *
 * Determinism contract — non-negotiable, mirrored by the byte-identity
 * test in `embeddings-sidecar.test.ts`:
 *
 *   1. Row order = `node_id ASC, granularity ASC, chunk_index ASC`. The
 *      DuckDB COPY runs the inner SELECT to completion before writing,
 *      so the row groups in the resulting Parquet land in that order.
 *   2. ZSTD compression at the DuckDB default level. Two consecutive
 *      runs against the same store contents produce byte-identical
 *      `.parquet` files.
 *   3. DuckDB v1.3.0+ ("Ossivalis", 2025) rewrote the parquet writer to
 *      drop the implicit timestamps that previously broke byte-identity.
 *      The `created_by` metadata still carries the engine version, so
 *      the pack manifest pins `duckdbVersion` to the runtime
 *      `SELECT version()` result. A run on a different DuckDB engine
 *      version is therefore expected to produce a different file (the
 *      pack hash will diverge — that is the right behaviour).
 *
 * Why the structural duck-type for {@link IGraphStore}? The COPY/Parquet
 * path is DuckDB-specific. Adding it to {@link IGraphStore} would commit
 * every alternate adapter (GraphDbStore, future LanceDB, mocks) to a
 * stub-throw. Instead the sidecar checks at runtime whether the store
 * implements `exportEmbeddingsParquet`. Stores that don't (or mocks
 * pretending the table is empty) cleanly resolve to `absent: true`.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { IGraphStore } from "@opencodehub/storage";

/** Inputs to {@link buildEmbeddingsSidecar}. */
export interface EmbeddingsSidecarOpts {
  /** Open graph store. Production callers pass a `DuckDbStore`. */
  readonly store: IGraphStore;
  /**
   * Absolute path to the destination Parquet file. The DuckStore
   * validates the path before interpolating into the COPY statement
   * (prepared statements do not bind COPY destinations).
   */
  readonly outPath: string;
}

/** Result of {@link buildEmbeddingsSidecar}. */
export interface EmbeddingsSidecarResult {
  /** Bytes written to disk; `0` when the sidecar is absent. */
  readonly bytesWritten: number;
  /** Number of `embeddings` rows materialized into the file. `0` when absent. */
  readonly rowCount: number;
  /**
   * `true` when no Parquet file was written (either the embeddings table is
   * empty, or the store does not support Parquet export). The caller MUST
   * skip the BOM item entirely in this case (S-M5-3).
   */
  readonly absent: boolean;
  /**
   * Hint payload for `PackPins`. `duckdbVersion` is the runtime
   * `SELECT version()` result from the DuckDB binding that wrote the file
   * — pinning it stabilizes the cross-environment determinism contract,
   * because the parquet writer's `created_by` metadata embeds this string.
   * Undefined when the sidecar is absent.
   */
  readonly pinsHint: { readonly duckdbVersion?: string };
  /** sha256 hex of the written file. Undefined when the sidecar is absent. */
  readonly fileHash?: string;
}

/**
 * Structural type for stores that can export `embeddings` to Parquet. Pulled
 * out as its own type so the sidecar can duck-type without importing
 * concrete-class symbols (`DuckDbStore`) and tightening the cross-package
 * dependency graph.
 */
interface ParquetExportingStore {
  exportEmbeddingsParquet(
    absOutPath: string,
  ): Promise<{ readonly rowCount: number; readonly duckdbVersion: string }>;
}

/**
 * Build the optional Parquet embeddings sidecar.
 *
 * Returns `{absent: true, ...}` and writes nothing when:
 *   - the store does not implement `exportEmbeddingsParquet` (e.g. mock
 *     stores in pack tests, or a future non-DuckDB backend), or
 *   - the underlying `embeddings` table has zero rows (S-M5-3).
 *
 * Returns `{absent: false, fileHash, bytesWritten, ...}` and writes the
 * Parquet file at `opts.outPath` when the store backs the call. The
 * caller (typically {@link generatePack}) appends a `BomItem` and pins
 * `duckdbVersion` from `pinsHint`.
 */
export async function buildEmbeddingsSidecar(
  opts: EmbeddingsSidecarOpts,
): Promise<EmbeddingsSidecarResult> {
  const { store, outPath } = opts;

  if (!hasParquetExport(store)) {
    return {
      bytesWritten: 0,
      rowCount: 0,
      absent: true,
      pinsHint: {},
    };
  }

  const { rowCount, duckdbVersion } = await store.exportEmbeddingsParquet(outPath);

  if (rowCount === 0) {
    // Store has signalled empty embeddings — by contract NO file was
    // written. Surface `duckdbVersion` only when the sidecar is actually
    // produced; the absent case leaves `pinsHint.duckdbVersion`
    // undefined so generatePack can fall back to the package-version
    // pin without overriding it with a runtime value that has nothing
    // bound to a written file.
    return {
      bytesWritten: 0,
      rowCount: 0,
      absent: true,
      pinsHint: {},
    };
  }

  // Stat for size + hash for byte-identity verification by callers.
  // Reading the whole file is fine here: the typical M5 pack target is
  // a single repo and the `.parquet` file is small (hundreds of KB to a
  // few MB). The pack writer hashes every BOM body anyway.
  const [{ size }, bytes] = await Promise.all([stat(outPath), readFile(outPath)]);
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  return {
    bytesWritten: size,
    rowCount,
    absent: false,
    pinsHint: { duckdbVersion },
    fileHash,
  };
}

/**
 * Runtime predicate for the structural `exportEmbeddingsParquet` contract.
 * Lifted to a named function so the type narrowing is explicit at the call
 * site — TS narrows `store` to `IGraphStore & ParquetExportingStore` once
 * this returns true.
 */
function hasParquetExport(store: IGraphStore): store is IGraphStore & ParquetExportingStore {
  const fn = (store as Partial<ParquetExportingStore>).exportEmbeddingsParquet;
  return typeof fn === "function";
}
