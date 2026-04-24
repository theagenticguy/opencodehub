/**
 * Hybrid BM25 + HNSW search with Reciprocal Rank Fusion.
 *
 * If no embedder is supplied, hybrid collapses to the BM25 path and returns
 * fused-shaped hits tagged `sources: ["bm25"]`. This keeps callers on a
 * single codepath: `hybridSearch(store, q)` is correct before and after an
 * embedder lands.
 *
 * When both paths run, the two hit lists are fused with RRF (k=60 default).
 * `sources` records which runs contributed to each fused entry so the caller
 * can surface provenance in the UI.
 */

import type { IGraphStore } from "@opencodehub/storage";
import { annSearch } from "./ann.js";
import { bm25Search, DEFAULT_BM25_LIMIT } from "./bm25.js";
import { DEFAULT_RRF_K, rrf } from "./rrf.js";
import type { BM25Query, Embedder, FusedHit, SymbolHit } from "./types.js";

export const DEFAULT_HYBRID_LIMIT = 50;

/**
 * Run BM25 (always) and optionally ANN, then fuse with RRF. Returns at most
 * `q.limit ?? DEFAULT_HYBRID_LIMIT` fused hits.
 */
export async function hybridSearch(
  store: IGraphStore,
  q: BM25Query,
  embedder?: Embedder,
): Promise<readonly FusedHit[]> {
  const limit = q.limit ?? DEFAULT_HYBRID_LIMIT;

  const bmHits = await bm25Search(store, { ...q, limit });

  if (embedder === undefined) {
    // BM25-only path. Preserve ranking order from BM25 unchanged; fuse with
    // a single run so downstream callers get FusedHit-typed output whether
    // or not an embedder is active.
    return bmHits.map((h) => ({
      nodeId: h.nodeId,
      score: h.score,
      sources: ["bm25" as const],
    }));
  }

  const vector = await embedder.embed(q.text);
  const annHits = await annSearch(store, { vector, limit });

  const runs = [bmHits.map((h) => ({ id: h.nodeId })), annHits.map((h) => ({ id: h.nodeId }))];
  const fused = rrf(runs, DEFAULT_RRF_K, limit);

  const bmIds = new Set(bmHits.map((h) => h.nodeId));
  const annIds = new Set(annHits.map((h) => h.nodeId));

  return fused.map((f) => {
    const sources: ("bm25" | "vector")[] = [];
    if (bmIds.has(f.id)) sources.push("bm25");
    if (annIds.has(f.id)) sources.push("vector");
    return { nodeId: f.id, score: f.score, sources };
  });
}

/**
 * Re-export BM25 defaults so CLI callers can read the same constants the
 * hybrid path uses without importing from three separate modules.
 */
export { DEFAULT_BM25_LIMIT };

/** Helper for callers that want the underlying BM25-only rows. */
export async function hybridBm25Only(
  store: IGraphStore,
  q: BM25Query,
): Promise<readonly SymbolHit[]> {
  return bm25Search(store, q);
}
