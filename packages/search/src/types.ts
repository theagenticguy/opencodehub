/**
 * Public types for the @opencodehub/search subsystem.
 *
 * These are the only shapes cross-package callers (CLI, MCP server, evals)
 * should need to build a search integration on top of OpenCodeHub. They
 * deliberately avoid leaking DuckDB or HNSW identifiers.
 */

/** One row returned by a keyword (BM25) or fused hit-list. */
export interface SymbolHit {
  readonly nodeId: string;
  readonly score: number;
  readonly filePath: string;
  readonly name: string;
  readonly kind: string;
}

/** Text-plus-optional-filters query accepted by `bm25Search` / `hybridSearch`. */
export interface BM25Query {
  readonly text: string;
  /** Restrict to a subset of NodeKind values; `undefined` means all kinds. */
  readonly kinds?: readonly string[];
  readonly limit?: number;
}

/** One row returned by the vector (HNSW) path. */
export interface VectorHit {
  readonly nodeId: string;
  readonly distance: number;
}

/**
 * Vector-space query. Callers supply the query vector directly so the
 * search layer stays oblivious to which embedding model produced it.
 */
export interface VectorQuery {
  readonly vector: Float32Array;
  /** SQL predicate fragment with `?` placeholders; see storage.VectorQuery. */
  readonly whereClause?: string;
  readonly params?: readonly unknown[];
  readonly limit?: number;
}

/** One row of a hybrid RRF-fused result list. */
export interface FusedHit {
  readonly nodeId: string;
  readonly score: number;
  /** Which runs (BM25 and/or vector) voted for this node. */
  readonly sources: readonly ("bm25" | "vector")[];
}

/**
 * Text → vector bridge. The default `NullEmbedder` throws — MVP deployments
 * are BM25-only and embeddings ship at v1.0.
 */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  readonly dim: number;
}
