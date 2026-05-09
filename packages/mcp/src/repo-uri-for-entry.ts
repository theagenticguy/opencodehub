/**
 * `repoUriForEntry` — resolve a `repo_uri` for a registry entry, preferring
 * the graph-backed `RepoNode.repoUri` when the repo has been indexed with
 * AC-M6-1's phase, otherwise falling back to `deriveRepoUri(entry)` from
 * `repo-resolver.ts` (shipped by AC-M6-2).
 *
 * Used by the `group_*` MCP tools (AC-M6-4) so that every repo-identified
 * response row carries a stable `repo_uri` alongside its legacy `name` /
 * `_repo` string. Lookups are best-effort — any DB-open / query failure
 * falls back silently to the derived URI so a single unhealthy repo cannot
 * break the whole response.
 *
 * Determinism: `deriveRepoUri` is pure; `RepoNode.repoUri` is byte-stable
 * after AC-M6-1 lands. Neither path depends on wall-clock.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { resolve } from "node:path";
import { makeNodeId } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import { resolveDbPath } from "@opencodehub/storage";
import type { ConnectionPool } from "./connection-pool.js";
import { deriveRepoUri, type RegistryEntry } from "./repo-resolver.js";

/**
 * Preferred: read `RepoNode.repoUri` from DuckDB. Only repos indexed AFTER
 * AC-M6-1 landed carry this row — earlier indexes fall back to the
 * derived URI.
 */
async function readRepoNodeUri(graph: IGraphStore): Promise<string | undefined> {
  const repoId = makeNodeId("Repo", "", "repo");
  const repo = await graph.getRepoNode(repoId);
  if (repo === undefined) return undefined;
  const uri = repo.repoUri;
  return typeof uri === "string" && uri.length > 0 ? uri : undefined;
}

/**
 * Resolve a `repo_uri` for `entry`. Pass a `pool` when the caller already
 * has one (every group-* tool does). Omit to fall back to the pure-derived
 * URI without any DB access — useful for orphan rows that aren't in the
 * registry.
 */
export async function repoUriForEntry(
  entry: RegistryEntry,
  pool?: ConnectionPool,
): Promise<string> {
  if (pool !== undefined) {
    const repoPath = resolve(entry.path);
    const dbPath = resolveDbPath(repoPath);
    try {
      const store = await pool.acquire(repoPath, dbPath);
      try {
        const uri = await readRepoNodeUri(store.graph);
        if (uri !== undefined) return uri;
      } finally {
        await pool.release(repoPath);
      }
    } catch {
      // Fall through to derived URI — a missing DB file, an unreadable
      // nodes table, or any other transient failure must not break the
      // group response. AC-M6-4 is additive; legacy fields stay correct.
    }
  }
  return deriveRepoUri(entry);
}
