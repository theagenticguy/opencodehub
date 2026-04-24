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
 *
 * `mode: "zoom"` activates the P03 coarse-to-fine dance: (1) retrieve the
 * top `zoomFanout` file-tier embeddings; (2) collect the resulting file
 * paths; (3) run a second symbol-tier retrieval restricted to symbols
 * under those files; (4) fuse with the BM25 run as usual. The two-step
 * flow narrows the HNSW search space to the subsystem the coarse query
 * landed in, trading a small latency hit for better behavioural recall.
 */

import type { IGraphStore, SqlParam, VectorQuery as StoreVectorQuery } from "@opencodehub/storage";
import { annSearch } from "./ann.js";
import { bm25Search, DEFAULT_BM25_LIMIT } from "./bm25.js";
import { DEFAULT_RRF_K, rrf } from "./rrf.js";
import type { BM25Query, Embedder, FusedHit, SymbolHit, VectorGranularity } from "./types.js";

export const DEFAULT_HYBRID_LIMIT = 50;
export const DEFAULT_ZOOM_FANOUT = 10;

/**
 * Hybrid-search caller options. Stacks on top of {@link BM25Query} so
 * callers can toggle zoom + fanout without changing their BM25 path.
 */
export interface HybridQuery extends BM25Query {
  /**
   * Retrieval strategy.
   *   - `"flat"` (default) — single symbol-tier HNSW run fused with BM25.
   *   - `"zoom"` — coarse file-tier run first, then a symbol-tier run
   *     restricted to the shortlisted files. Unlocks architectural
   *     queries without hurting exact-name queries (BM25 still fires).
   */
  readonly mode?: "flat" | "zoom";
  /**
   * Number of file-tier rows retrieved at the coarse step when
   * `mode="zoom"`. Defaults to 10. Each file expands to all its symbols
   * in the narrow HNSW step, so the effective fine-grained candidate set
   * is usually much larger than this fanout.
   */
  readonly zoomFanout?: number;
  /**
   * Optional hard tier filter applied to the HNSW leg even when
   * `mode="flat"`. Set to `"community"` to run community-tier retrieval
   * (used by `codehub query --granularity community ...`).
   */
  readonly granularity?: VectorGranularity | readonly VectorGranularity[];
}

/**
 * Run BM25 (always) and optionally ANN, then fuse with RRF. Returns at most
 * `q.limit ?? DEFAULT_HYBRID_LIMIT` fused hits.
 */
export async function hybridSearch(
  store: IGraphStore,
  q: HybridQuery,
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

  let annHits: readonly { readonly nodeId: string; readonly distance: number }[];
  if (q.mode === "zoom") {
    annHits = await zoomVectorSearch(store, vector, {
      fanout: q.zoomFanout ?? DEFAULT_ZOOM_FANOUT,
      limit,
    });
  } else {
    // Default symbol-tier filter preserves v1.0 retrieval semantics when
    // file/community rows also live in the table. Callers can override
    // by setting `q.granularity` explicitly (e.g. for community queries).
    const granularity = q.granularity ?? "symbol";
    annHits = await annSearch(store, {
      vector,
      limit,
      granularity,
    });
  }

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
 * Two-step zoom retrieval. Runs a coarse file-tier ANN query, collects
 * the file paths, then runs a symbol-tier ANN query restricted to
 * symbols whose `file_path` falls inside the coarse shortlist. Returns
 * the symbol-tier rows in ascending distance order.
 *
 * If the coarse step returns zero rows (the file tier isn't populated, or
 * the extension stripped the filter on a tiny dataset), we fall back to
 * an unrestricted symbol-tier query. This keeps `--zoom` usable even on
 * indexes that never ran `--granularity symbol,file,community`.
 */
async function zoomVectorSearch(
  store: IGraphStore,
  vector: Float32Array,
  opts: { readonly fanout: number; readonly limit: number },
): Promise<readonly { readonly nodeId: string; readonly distance: number }[]> {
  // 1. Coarse file-tier shortlist.
  const coarseQuery: StoreVectorQuery = {
    vector,
    limit: Math.max(1, opts.fanout),
    granularity: "file",
  };
  const coarseRows = await store.vectorSearch(coarseQuery);
  const filePaths = await resolveFilePaths(
    store,
    coarseRows.map((r) => r.nodeId),
  );
  if (filePaths.length === 0) {
    // No file-tier coverage yet — fall through to an unfiltered symbol
    // ANN run. This preserves the v1.0 behaviour on indexes that never
    // emitted file-tier embeddings.
    const fallback: StoreVectorQuery = {
      vector,
      limit: opts.limit,
      granularity: "symbol",
    };
    return store.vectorSearch(fallback);
  }

  // 2. Fine symbol-tier run restricted to the coarse shortlist. `n` is
  // the alias applied to the `nodes` table inside store.vectorSearch's
  // filter-first subquery.
  const placeholders = filePaths.map(() => "?").join(",");
  const params: readonly SqlParam[] = filePaths;
  const fineQuery: StoreVectorQuery = {
    vector,
    whereClause: `n.file_path IN (${placeholders})`,
    params,
    limit: opts.limit,
    granularity: "symbol",
  };
  return store.vectorSearch(fineQuery);
}

/**
 * Resolve a batch of File-node ids to their `file_path` strings. Missing
 * rows are silently dropped; duplicate paths are de-duplicated while
 * preserving order. Any query failure returns `[]` so the caller falls
 * back to an unfiltered symbol query rather than crashing.
 */
async function resolveFilePaths(
  store: IGraphStore,
  fileNodeIds: readonly string[],
): Promise<readonly string[]> {
  if (fileNodeIds.length === 0) return [];
  const placeholders = fileNodeIds.map(() => "?").join(",");
  try {
    const rows = await store.query(
      `SELECT id, file_path FROM nodes WHERE id IN (${placeholders})`,
      fileNodeIds,
    );
    const seen = new Set<string>();
    const out: string[] = [];
    // Preserve the caller's id order so the ann ranking carries over.
    const byId = new Map<string, string>();
    for (const r of rows) {
      const id = String(r["id"] ?? "");
      const fp = String(r["file_path"] ?? "");
      if (id !== "" && fp !== "") byId.set(id, fp);
    }
    for (const id of fileNodeIds) {
      const fp = byId.get(id);
      if (fp === undefined) continue;
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push(fp);
    }
    return out;
  } catch {
    return [];
  }
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
