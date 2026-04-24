/**
 * Shared embedder-resolution helpers for callers that want the MCP `query`
 * tool's smart path (probe → try-open → warn-on-fail → BM25 fallback).
 *
 * Two helpers:
 *   - `embeddingsPopulated(store)` — read-only probe of the `embeddings` table;
 *     any failure (schema mismatch, extension missing, table absent) returns
 *     `false` so the caller transparently collapses to BM25.
 *   - `tryOpenEmbedder(factory)` — invoke the caller's async factory and
 *     return `null` on any throw, logging a single stderr warning. We never
 *     abort a query because the embedder is unavailable; the invariant is
 *     that a fresh-cloned repo still answers `query` before
 *     `codehub setup --embeddings` has been run.
 *
 * The `Embedder` type parameter on `tryOpenEmbedder` is kept generic so the
 * MCP tool (which uses the `@opencodehub/embedder` interface with
 * `modelId`/`close`/etc.) and the CLI (which may use the narrower
 * `@opencodehub/search` `Embedder`) can share the helper without coupling
 * on the richer interface.
 */

import type { IGraphStore } from "@opencodehub/storage";

/**
 * Decide whether the store has any embeddings persisted. Any failure
 * (e.g. schema mismatch, extension missing) returns false so callers
 * transparently fall back to BM25.
 */
export async function embeddingsPopulated(store: IGraphStore): Promise<boolean> {
  try {
    const rows = await store.query("SELECT COUNT(*) AS n FROM embeddings", []);
    const first = rows[0];
    if (!first) return false;
    const n = Number(first["n"] ?? 0);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

/**
 * Open an embedder, or return null if unavailable. Any failure (missing
 * weights, native load error, unreachable HTTP endpoint, unexpected
 * exception) is treated the same way: warn to stderr and return `null` so
 * the caller falls back to BM25. We never abort the query.
 *
 * The `logPrefix` is surfaced at the head of the stderr warning so call
 * sites (`[mcp:query]`, `[cli:query]`) can distinguish each other in logs.
 */
export async function tryOpenEmbedder<E>(
  open: () => Promise<E>,
  logPrefix = "[search]",
): Promise<E | null> {
  try {
    return await open();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // stdout is reserved for JSON-RPC on stdio transports; warn to stderr.
    console.warn(
      `${logPrefix} hybrid search unavailable (embeddings populated but embedder could not open): ${message}. Falling back to BM25.`,
    );
    return null;
  }
}
