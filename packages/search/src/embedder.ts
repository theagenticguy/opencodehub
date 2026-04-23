/**
 * Embedder seam.
 *
 * OpenCodeHub MVP ships without an embedder; vector search is gated behind a
 * future `--embeddings` flag. The `NullEmbedder` always throws so callers who
 * forget to pass a real implementation trip the guard immediately instead of
 * producing silent BM25-only results when they believed vectors were active.
 */

import type { Embedder } from "./types.js";

export const DEFAULT_EMBEDDER_DIM = 384;

/**
 * Stand-in embedder that refuses to produce vectors. Used as the default
 * argument for hybrid search — callers who want BM25 only should omit the
 * embedder argument entirely; callers who want hybrid must supply a real
 * implementation.
 */
export class NullEmbedder implements Embedder {
  readonly dim = DEFAULT_EMBEDDER_DIM;
  async embed(): Promise<Float32Array> {
    throw new Error("embeddings disabled at MVP; use --embeddings at v1.0");
  }
}
