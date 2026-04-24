/**
 * HNSW (approximate nearest-neighbour) wrapper over `IGraphStore.vectorSearch`.
 *
 * The path is only reachable when a caller opts in by constructing a store
 * that has persisted vectors (`codehub analyze --embeddings`). The wrapper
 * keeps hybrid callers on a stable API surface and lets tests swap in a
 * fake store.
 */

import type { IGraphStore, SqlParam, VectorQuery as StoreVectorQuery } from "@opencodehub/storage";
import type { VectorHit, VectorQuery } from "./types.js";

export const DEFAULT_ANN_LIMIT = 50;

export async function annSearch(store: IGraphStore, q: VectorQuery): Promise<readonly VectorHit[]> {
  const storeQuery: StoreVectorQuery = {
    vector: q.vector,
    ...(q.whereClause !== undefined ? { whereClause: q.whereClause } : {}),
    ...(q.params !== undefined ? { params: coerceParams(q.params) } : {}),
    limit: q.limit ?? DEFAULT_ANN_LIMIT,
  };
  const rows = await store.vectorSearch(storeQuery);
  return rows.map((r) => ({ nodeId: r.nodeId, distance: r.distance }));
}

/**
 * The search layer takes `readonly unknown[]` so callers don't need to import
 * `SqlParam`; the storage layer is strict. Coerce here; any rejected values
 * surface as the store's own validation error once dispatched.
 */
function coerceParams(params: readonly unknown[]): readonly SqlParam[] {
  const out: SqlParam[] = [];
  for (const p of params) {
    if (
      typeof p === "string" ||
      typeof p === "number" ||
      typeof p === "bigint" ||
      typeof p === "boolean" ||
      p === null
    ) {
      out.push(p);
      continue;
    }
    throw new Error(
      `annSearch: unsupported param type ${typeof p}; string|number|bigint|boolean|null required`,
    );
  }
  return out;
}
