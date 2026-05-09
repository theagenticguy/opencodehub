/**
 * BOM body item #7: Parquet embeddings sidecar (AC-M5-6, AC-A-4 relocation).
 *
 * AC-A-4 moved sidecar emission OUT of `@opencodehub/storage` and into the
 * pack layer. The sidecar is now a packaging concern: it consumes
 * embeddings via {@link IGraphStore.listEmbeddings} (a portable graph-side
 * method shipped by both adapters in AC-A-6a) and writes Parquet via the
 * temporal store's DuckDB `COPY ... TO ... (FORMAT PARQUET, COMPRESSION
 * ZSTD)`. Third-party graph adapters (AGE, Memgraph, Neo4j, Neptune)
 * therefore do NOT implement Parquet emission themselves — pack handles
 * it from the deterministic row stream.
 *
 * Backend dispatch (per architecture-revised.md §AC-A-4):
 *
 *   - `backend === "duck"`: temporal IS the same DuckDB connection that
 *     owns the `embeddings` table. We call the @internal helper
 *     `DuckDbStore.exportEmbeddingsParquet` directly — it runs `COPY` over
 *     the existing rows and produces byte-identical output across runs.
 *     `determinismClass: "strict"`, `writerBackend: "duck-copy"`.
 *
 *   - `backend === "lbug"`: graph rows live in `@ladybugdb/core`; the paired
 *     temporal DuckDB has no embeddings table. v1 stamps
 *     `determinismClass: "degraded"`, `writerBackend: "absent"` and emits
 *     no file. AC-A-4 anti-goal §10 explicitly permits this:
 *     "accept `determinism_class: degraded` on lbug-only deployments for
 *     v1". A future iteration can stage rows into the temporal store
 *     before COPY (or fall back to `@dsnp/parquetjs`) once the dep
 *     footprint is acceptable.
 *
 * Determinism contract — non-negotiable, mirrored by the byte-identity
 * test in `embeddings-sidecar.test.ts` for the duck path:
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
 *      `SELECT version()` result.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DuckDbStore, type IGraphStore, type Store } from "@opencodehub/storage";

/**
 * Inputs to {@link writeEmbeddingsSidecar}. AC-A-4 takes a composed
 * {@link Store} (= `OpenStoreResult`) so the sidecar can dispatch on
 * backend and route through whichever adapter owns the embeddings.
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
   * Optional embedding-tier filter. When omitted the writer emits every
   * row from the `embeddings` table in its native ordering. Reserved for
   * future tier-specific packs; the duck-path COPY ignores it today.
   */
  readonly granularity?: "symbol" | "file" | "community";
}

/**
 * Backend identifier for the writer that produced the sidecar (or
 * `"absent"` when no file was written).
 */
export type SidecarWriterBackend = "duck-copy" | "parquetjs" | "absent";

/**
 * Determinism class stamped on the sidecar. `"strict"` when the writer
 * produces byte-identical output across runs; `"degraded"` otherwise
 * (e.g., lbug-only deployments where the pack writes no Parquet for v1).
 */
export type SidecarDeterminismClass = "strict" | "degraded";

/** Result of {@link writeEmbeddingsSidecar}. */
export interface SidecarResult {
  /** True when a Parquet file was written to `outPath`. */
  readonly written: boolean;
  /** Number of `embeddings` rows materialized into the file (0 when not written). */
  readonly rowCount: number;
  /** Strictness signal — `"degraded"` when the writer cannot emit a deterministic file. */
  readonly determinismClass: SidecarDeterminismClass;
  /** Which writer produced the file, or `"absent"` when no file was written. */
  readonly writerBackend: SidecarWriterBackend;
  /** Bytes written to disk; `0` when the sidecar is absent. */
  readonly bytesWritten: number;
  /**
   * Hint payload for `PackPins`. `duckdbVersion` is the runtime
   * `SELECT version()` result from the DuckDB binding that wrote the
   * file — pinning it stabilizes the cross-environment determinism
   * contract because the parquet `created_by` metadata embeds this
   * string. Undefined when no Parquet file was written.
   */
  readonly pinsHint: { readonly duckdbVersion?: string };
  /** sha256 hex of the written file. Undefined when no Parquet file was written. */
  readonly fileHash?: string;
}

/**
 * Structural type for stores that expose the @internal DuckDB COPY helper.
 * Pulled out so the runtime predicate stays explicit at the call site —
 * pack does not import the helper symbol itself, just narrows by
 * `instanceof DuckDbStore` plus a defensive duck-type check.
 */
interface ParquetCopyCapableStore {
  exportEmbeddingsParquet(
    absOutPath: string,
  ): Promise<{ readonly rowCount: number; readonly duckdbVersion: string }>;
}

/**
 * Write the optional Parquet embeddings sidecar.
 *
 * Returns `{ written: false, rowCount: 0, writerBackend: "absent", ... }`
 * when:
 *   - the `embeddings` table is empty (S-M5-3 — pack omits the BomItem);
 *   - the backend is `lbug` (v1 degraded path — no temporal embeddings
 *     table to COPY from).
 *
 * Returns `{ written: true, ..., fileHash, bytesWritten }` and writes the
 * Parquet file at `opts.outPath` when the duck-path emitter ran. The
 * caller (typically {@link generatePack}) appends the BomItem and pins
 * `duckdbVersion` from `pinsHint`.
 */
export async function writeEmbeddingsSidecar(opts: SidecarOptions): Promise<SidecarResult> {
  const { store, outPath } = opts;

  // Locate the DuckDB-capable store. `backend === "duck"` → temporal IS
  // the graph store; `backend === "lbug"` → the temporal DuckDB has no
  // embeddings table, so the COPY helper is unreachable. The duck-type
  // probe lets test fakes inject the helper without instantiating a
  // real DuckDbStore (the byte-identity test does so).
  const copyHelper = resolveCopyHelper(store);

  if (copyHelper === undefined) {
    // lbug path (or any community backend without DuckDB temporal): we
    // cannot emit a deterministic Parquet file in v1. Stamp degraded so
    // generatePack downgrades the manifest's determinism_class
    // accordingly.
    //
    // Probe `listEmbeddings()` so callers and tests can still see whether
    // any rows exist — the count signals to operators that the stamp is
    // a deliberate v1 limitation rather than an empty table.
    const rowCount = await countEmbeddings(store.graph, opts.granularity);
    return {
      written: false,
      rowCount,
      determinismClass: rowCount === 0 ? "strict" : "degraded",
      writerBackend: "absent",
      bytesWritten: 0,
      pinsHint: {},
    };
  }

  const { rowCount, duckdbVersion } = await copyHelper.exportEmbeddingsParquet(outPath);

  if (rowCount === 0) {
    // S-M5-3 — empty embeddings means NO file on disk and no manifest
    // entry. `determinismClass: "strict"` because absence is itself a
    // deterministic outcome on the duck path.
    return {
      written: false,
      rowCount: 0,
      determinismClass: "strict",
      writerBackend: "absent",
      bytesWritten: 0,
      pinsHint: {},
    };
  }

  // Read the whole file for byte-identity hashing; derive size from the
  // same buffer so `bytesWritten` and `fileHash` are taken from one read
  // (no stat/read race). The typical pack target's sidecar is small
  // (hundreds of KB to a few MB); the pack writer hashes every BOM body
  // anyway.
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

/**
 * Return the @internal DuckDB COPY helper if the store exposes one.
 *
 * Lookup order (matches AC-A-4 dispatch §AC-A-4):
 *   1. `store.graph` is a `DuckDbStore` (backend === "duck"). The graph
 *      view IS the embedding-owning DuckDB connection.
 *   2. `store.temporal` is a `DuckDbStore` AND its file holds the
 *      embeddings (backend === "duck"; same instance as graph in this
 *      arrangement).
 *   3. Either view duck-types as {@link ParquetCopyCapableStore} — used
 *      by the test fakes that simulate the COPY helper without a native
 *      DuckDB binding.
 *
 * Returns `undefined` when no helper is reachable. lbug-backed Stores
 * land here in v1 (their temporal DuckDB has no embeddings table; the
 * graph view is `GraphDbStore`).
 */
function resolveCopyHelper(store: Store): ParquetCopyCapableStore | undefined {
  if (store.graph instanceof DuckDbStore) {
    return store.graph;
  }
  if (store.temporal instanceof DuckDbStore && store.backend === "duck") {
    return store.temporal;
  }
  // Duck-type fallback for test fakes that attach `exportEmbeddingsParquet`
  // to a plain object without instantiating a real DuckDbStore. We honor
  // this only on the duck path — lbug deliberately resolves to absent.
  if (store.backend === "duck") {
    if (hasParquetCopy(store.graph)) return store.graph;
    if (hasParquetCopy(store.temporal)) return store.temporal as unknown as ParquetCopyCapableStore;
  }
  return undefined;
}

function hasParquetCopy(store: unknown): store is ParquetCopyCapableStore {
  if (store === null || typeof store !== "object") return false;
  const fn = (store as { exportEmbeddingsParquet?: unknown }).exportEmbeddingsParquet;
  return typeof fn === "function";
}

/**
 * Count rows in the embeddings stream so the degraded-path result still
 * carries an honest `rowCount`. Drains the iterator (which is the only
 * portable surface across both adapters) — a pure COUNT(*) shortcut isn't
 * on `IGraphStore` and adding one would widen the interface, against the
 * AC-A-4 anti-goal "DO NOT change `IGraphStore.listEmbeddings` signature".
 *
 * Tolerant of test fakes that don't implement `listEmbeddings`: when the
 * method is missing we treat that as zero embeddings (the fake clearly
 * doesn't model the embeddings table). Real adapters always implement
 * it (AC-A-6a shipped both adapters) so this guard never trips in
 * production.
 */
async function countEmbeddings(
  graph: IGraphStore,
  granularity: SidecarOptions["granularity"],
): Promise<number> {
  if (typeof (graph as { listEmbeddings?: unknown }).listEmbeddings !== "function") {
    return 0;
  }
  let n = 0;
  for await (const row of graph.listEmbeddings()) {
    if (granularity !== undefined && row.granularity !== granularity) continue;
    n += 1;
  }
  return n;
}
