/**
 * Storage abstraction for OpenCodeHub knowledge graphs.
 *
 * The interface is designed around DuckDB as the primary backend, but every
 * method uses plain TypeScript types so alternate adapters (LanceDB is the
 * primary forward-compatible candidate) can slot in behind the same seam.
 */

import type { KnowledgeGraph } from "@opencodehub/core-types";

export interface IGraphStore {
  /** Open (or create) the underlying database file. Idempotent. */
  open(): Promise<void>;
  /** Release all native handles. Safe to call more than once. */
  close(): Promise<void>;
  /** Emit all CREATE TABLE / CREATE INDEX DDL. Must be called before bulkLoad. */
  createSchema(): Promise<void>;
  /**
   * Load the provided graph into the store in a single transaction.
   *
   * Modes:
   *   - `"replace"` (default) — drop all existing rows, then insert the graph.
   *     Maintains v1.0 semantics for full reindex runs.
   *   - `"upsert"` — INSERT ... ON CONFLICT DO UPDATE for every row, preserving
   *     rows not present in the incoming graph. Required by the
   *     incremental / content-cache pipeline so touched files can be replaced
   *     without losing unrelated data.
   */
  bulkLoad(graph: KnowledgeGraph, opts?: BulkLoadOptions): Promise<BulkLoadStats>;
  /** Insert/replace embedding rows for the configured vector dimension. */
  upsertEmbeddings(rows: readonly EmbeddingRow[]): Promise<void>;
  /** Run a user-supplied read-only SQL statement with bound parameters. */
  query(
    sql: string,
    params?: readonly SqlParam[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<readonly Record<string, unknown>[]>;
  /** Full-text search over symbol name / signature / description via BM25. */
  search(q: SearchQuery): Promise<readonly SearchResult[]>;
  /** Filter-aware HNSW vector search. */
  vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]>;
  /** Depth-bounded graph traversal with optional confidence / relation filters. */
  traverse(q: TraverseQuery): Promise<readonly TraverseResult[]>;
  /** Fetch the last-written store metadata, if any. */
  getMeta(): Promise<StoreMeta | undefined>;
  /** Upsert the store metadata row. */
  setMeta(meta: StoreMeta): Promise<void>;
  /** Minimal connectivity probe. */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

/** JS types that can safely round-trip as DuckDB query parameters at MVP. */
export type SqlParam = string | number | bigint | boolean | null;

export interface BulkLoadStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly durationMs: number;
}

export interface BulkLoadOptions {
  /**
   * `"replace"` (default) clears the existing rows before inserting. `"upsert"`
   * INSERTs with ON CONFLICT DO UPDATE — existing rows for ids not present in
   * the incoming graph are retained. Use `"upsert"` from the incremental
   * indexing pipeline so a partial re-index of changed files does not drop
   * unrelated rows.
   */
  readonly mode?: "replace" | "upsert";
}

export interface EmbeddingRow {
  readonly nodeId: string;
  readonly chunkIndex: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly vector: Float32Array;
  readonly contentHash: string;
}

export interface SearchQuery {
  readonly text: string;
  readonly kinds?: readonly string[];
  readonly limit?: number;
}

export interface SearchResult {
  readonly nodeId: string;
  readonly score: number;
  readonly filePath: string;
  readonly name: string;
  readonly kind: string;
}

export interface VectorQuery {
  readonly vector: Float32Array;
  /**
   * A SQL predicate fragment evaluated against the `embeddings` table joined
   * to `nodes` (aliased `n`). Example: `n.kind = ?`. Use `?` placeholders and
   * supply values via `params`.
   */
  readonly whereClause?: string;
  readonly params?: readonly SqlParam[];
  readonly limit?: number;
}

export interface VectorResult {
  readonly nodeId: string;
  readonly distance: number;
}

export interface TraverseQuery {
  readonly startId: string;
  readonly relationTypes?: readonly string[];
  readonly direction: "up" | "down" | "both";
  readonly maxDepth: number;
  readonly minConfidence?: number;
}

export interface TraverseResult {
  readonly nodeId: string;
  readonly depth: number;
  readonly path: readonly string[];
}

export interface StoreMeta {
  readonly schemaVersion: string;
  readonly lastCommit?: string;
  readonly indexedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly stats?: Record<string, number>;
  /**
   * Fraction in [0, 1] of files that were served from the parse-cache during
   * the last index run. Populated by 's content-cache. Optional so
   * pre-v1.1 stores keep round-tripping.
   */
  readonly cacheHitRatio?: number;
  /** Total size, in bytes, of the `.codehub/parse-cache/` sidecar. */
  readonly cacheSizeBytes?: number;
  /** ISO-8601 timestamp of the last parse-cache compaction pass. */
  readonly lastCompaction?: string;
}
