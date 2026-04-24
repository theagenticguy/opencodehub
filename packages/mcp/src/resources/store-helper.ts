/**
 * Shared repo-resolution + store-checkout helper for resource handlers.
 *
 * Mirrors the tool-side `withStore` but returns shape appropriate for
 * resources: instead of `CallToolResult`, resource callbacks return
 * `ReadResourceResult`, which carries a plain text body. Errors
 * (missing pool, repo not found, DuckDB open failure) are surfaced as a
 * YAML error envelope inside the resource body so the agent sees the
 * problem inline rather than receiving a transport-level fault.
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { DuckDbStore } from "@opencodehub/storage";
import type { ConnectionPool } from "../connection-pool.js";
import { RepoResolveError, resolveRepo } from "../repo-resolver.js";

export interface ResourceStoreOptions {
  readonly home?: string;
  readonly pool?: ConnectionPool;
}

export interface ResourceStoreError {
  readonly result: ReadResourceResult;
}

/**
 * Acquire a read-only store handle for `repoName`, invoke `fn`, and
 * release. When resolution fails, return a YAML error envelope the
 * caller should pass straight through. The callback is responsible for
 * building the happy-path result.
 */
export async function withResourceStore(
  uriHref: string,
  repoName: string | undefined,
  opts: ResourceStoreOptions,
  fn: (store: DuckDbStore, repoName: string) => Promise<ReadResourceResult>,
): Promise<ReadResourceResult> {
  if (!opts.pool) {
    return yamlError(uriHref, "pool unavailable", "Server was built without a connection pool.");
  }
  const resolveOpts = opts.home !== undefined ? { home: opts.home } : {};
  try {
    const resolved = await resolveRepo(repoName, resolveOpts);
    const store = await opts.pool.acquire(resolved.repoPath, resolved.dbPath);
    try {
      return await fn(store, resolved.name);
    } finally {
      await opts.pool.release(resolved.repoPath);
    }
  } catch (err) {
    if (err instanceof RepoResolveError) {
      return yamlError(uriHref, err.code, err.hint);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return yamlError(uriHref, "internal error", msg);
  }
}

function yamlError(uri: string, error: string, hint: string): ReadResourceResult {
  const body = [`error: ${quote(error)}`, `hint: ${quote(hint)}`, ""].join("\n");
  return {
    contents: [
      {
        uri,
        mimeType: "text/yaml",
        text: body,
      },
    ],
  };
}

function quote(value: string): string {
  if (/^[A-Za-z0-9._\-/]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
