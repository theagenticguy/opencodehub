/**
 * Embedder seam.
 *
 * OpenCodeHub's hybrid search resolves its embedder lazily: CLI and MCP
 * callers pass a factory to {@link tryOpenEmbedder} which returns `null`
 * (warn + fall back to BM25) when the embedder can't be opened. This
 * `NullEmbedder` is a structural stand-in for callers that accidentally
 * wire up BM25-only search with an `Embedder`-typed slot: instead of
 * hard-throwing in production we emit a one-line deprecation warning and
 * return a zero-vector so the call graph keeps flowing. Tests keep the
 * throw so the mis-wire is caught before shipping.
 */

import type { Embedder } from "./types.js";

export const DEFAULT_EMBEDDER_DIM = 384;

/** Whether the deprecation warning has already fired in this process. */
let warnedOnce = false;

/**
 * Stand-in embedder that produces zero-vectors in production and throws in
 * tests. Callers who want BM25 only should omit the embedder argument
 * entirely; callers who want hybrid must supply a real implementation. The
 * only code paths that legitimately land here are tests and partially
 * mis-wired production call sites — the latter get a one-time stderr
 * warning instead of a process-killing throw.
 */
export class NullEmbedder implements Embedder {
  readonly dim = DEFAULT_EMBEDDER_DIM;
  async embed(_text: string): Promise<Float32Array> {
    if (process.env["NODE_ENV"] === "test") {
      throw new Error(
        "NullEmbedder.embed() invoked; supply a real Embedder to hybridSearch or call bm25Search directly.",
      );
    }
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[search] NullEmbedder.embed() invoked in production; returning zero-vector. " +
          "This is almost certainly a wiring bug — pass a real Embedder to hybridSearch " +
          "or call bm25Search directly.",
      );
    }
    return new Float32Array(this.dim);
  }
}
