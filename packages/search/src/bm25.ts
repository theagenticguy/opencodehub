/**
 * BM25 keyword search — thin wrapper around `IGraphStore.search(...)`.
 *
 * The underlying store already exposes a DuckDB FTS-backed ranking function;
 * this module only exists so hybrid callers can depend on `@opencodehub/search`
 * without taking a direct dependency on `@opencodehub/storage` types beyond
 * the store interface they already hold.
 */

import type { IGraphStore } from "@opencodehub/storage";
import type { BM25Query, SymbolHit } from "./types.js";

/** Default row cap for BM25 queries that don't specify one. */
export const DEFAULT_BM25_LIMIT = 50;

/**
 * Run a BM25 query against the configured store. Passes the text, optional
 * kind filter, and limit through unchanged. The store returns SymbolHit-
 * shaped rows directly.
 */
export async function bm25Search(
  store: IGraphStore,
  query: BM25Query,
): Promise<readonly SymbolHit[]> {
  const limit = query.limit ?? DEFAULT_BM25_LIMIT;
  const rows = await store.search({
    text: query.text,
    ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
    limit,
  });
  // The storage.SearchResult shape is already SymbolHit-compatible; we copy
  // defensively so callers can't mutate the store's internal row objects.
  return rows.map((r) => ({
    nodeId: r.nodeId,
    score: r.score,
    filePath: r.filePath,
    name: r.name,
    kind: r.kind,
  }));
}
