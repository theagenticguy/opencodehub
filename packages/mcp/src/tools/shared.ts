/**
 * Shared scaffolding for MCP tool handlers.
 *
 * Each tool depends on a `ToolContext` that carries the connection pool
 * (for checkout/release) plus the registry home override (to let tests
 * point at a fake `~/.codehub`). The factory functions in `server.ts`
 * construct one `ToolContext` per server and pass it into every
 * `registerXxxTool` call.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FsAbstraction } from "@opencodehub/analysis";
import type { Embedder } from "@opencodehub/embedder";
import { describeArtifacts, type Store } from "@opencodehub/storage";
import { z } from "zod";
import type { ConnectionPool } from "../connection-pool.js";
import { toolAmbiguousRepoError, toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { RepoResolveError, type ResolvedRepo, resolveRepo } from "../repo-resolver.js";

/**
 * Factory for opening an embedder on demand. The default factory imports
 * `@opencodehub/embedder` and calls `openOnnxEmbedder()`; tests inject a
 * fake so they don't need F2LLM-v2-80M weights on disk. The factory
 * must throw on failure — the `query` tool treats any throw as
 * "embedder unavailable, warn + fall back to BM25".
 */
export type EmbedderFactory = () => Promise<Embedder>;

export interface ToolContext {
  readonly pool: ConnectionPool;
  readonly home?: string;
  /**
   * Optional override for how the `query` tool opens an embedder when the
   * `embeddings` table is populated. Production callers leave this unset
   * and the tool lazy-imports `@opencodehub/embedder`.
   */
  readonly openEmbedder?: EmbedderFactory;
  /**
   * Optional factory for the file-reading abstraction used when tools need
   * to slice source files (e.g. `query` snippet extraction,
   * `remove_dead_code` edit planning). Production callers leave this unset
   * and the tools use `createNodeFs()`.
   */
  readonly fsFactory?: () => FsAbstraction;
}

export type RegisteredServer = McpServer;

/**
 * Transport-agnostic tool result shape. The MCP-registered handler
 * adapts this into the SDK's `CallToolResult`. Keep this minimal — `text`
 * is the rendered agent-readable body; `structuredContent` carries the
 * machine-readable payload (with `next_steps`, `error`, `_meta.*` as
 * usual); `isError` mirrors the MCP semantics.
 */
export interface ToolResult {
  readonly structuredContent: unknown;
  readonly text: string;
  readonly isError?: boolean;
}

/**
 * Convert an MCP `CallToolResult` to the transport-agnostic `ToolResult`.
 * The SDK result always carries at least one `{ type: 'text', text }`
 * content entry in our tools, so the extraction is lossless in practice.
 */
export function toToolResult(r: CallToolResult): ToolResult {
  const first = r.content[0];
  const text = first && first.type === "text" ? first.text : "";
  const out: { structuredContent: unknown; text: string; isError?: boolean } = {
    structuredContent: r.structuredContent,
    text,
  };
  if (r.isError) out.isError = true;
  return out;
}

/**
 * Convert a transport-agnostic `ToolResult` back to the MCP SDK shape.
 * The MCP-registered handler uses this so it can return exactly the
 * `CallToolResult` shape the SDK expects.
 */
export function fromToolResult(r: ToolResult): CallToolResult {
  const sc = r.structuredContent as { [key: string]: unknown } | undefined;
  const out: CallToolResult = {
    content: [{ type: "text" as const, text: r.text }],
    ...(sc !== undefined ? { structuredContent: sc } : {}),
  };
  if (r.isError) out.isError = true;
  return out;
}

/**
 * Shared zod shape for `{ repo, repo_uri }` — every per-repo MCP tool
 * spreads this into its `inputSchema` so callers can pass either the
 * registry name (`repo`) or a Sourcegraph-style URI (`repo_uri`). When
 * both are provided, `repo_uri` wins at the resolver.
 */
export const repoArgShape = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is. Prefer `repo_uri` for cross-host portability.",
    ),
  repo_uri: z
    .string()
    .optional()
    .describe(
      "Sourcegraph-style repo URI (e.g. `github.com/org/repo`, or `local:<hash>` for unpublished repos). Accepted as an alias for `repo`; wins when both are provided.",
    ),
} as const;

/**
 * Shape of the `{ repo, repo_uri }` arg pair accepted by tool handlers.
 *
 * Permits explicit `undefined` values so tool-handler arg types (which
 * declare `repo?: string | undefined` under `exactOptionalPropertyTypes`)
 * are structurally assignable without wrapping.
 */
export interface RepoArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
}

/**
 * Acquire a store for the given repo argument, invoke `fn`, and release
 * the handle unconditionally. Errors from repo resolution become
 * structured NO_INDEX/NOT_FOUND envelopes; SQLite errors become DB_ERROR.
 * The inner function always returns a CallToolResult so the surface of
 * this helper is the same type.
 *
 * `arg` accepts either a bare registry name (back-compat with pre-M6
 * callers), an `undefined` (single-repo defaulting), or the full
 * `{ repo?, repo_uri? }` object. The resolver handles the alias logic.
 */
export async function withStore(
  ctx: ToolContext,
  arg: RepoArgs | string | undefined,
  fn: (store: Store, resolved: ResolvedRepo) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  let resolved: ResolvedRepo;
  try {
    const opts = ctx.home !== undefined ? { home: ctx.home } : {};
    resolved = await resolveRepo(arg, opts);
  } catch (err) {
    if (err instanceof RepoResolveError) {
      if (err.code === "AMBIGUOUS_REPO" && err.ambiguous !== undefined) {
        return toolAmbiguousRepoError({
          message: err.message,
          hint: err.hint,
          choices: err.ambiguous.choices,
          totalMatches: err.ambiguous.totalMatches,
        });
      }
      return toolError(err.code, err.message, err.hint);
    }
    return toolErrorFromUnknown(err);
  }

  let store: Store;
  try {
    store = await ctx.pool.acquire(resolved.repoPath, resolved.dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Pull the canonical graph artifact filename from `describeArtifacts`
    // so the hint stays in sync with the storage layer's source of truth.
    const candidate = `.codehub/${describeArtifacts().graphFile}`;
    return toolError(
      "DB_ERROR",
      `Failed to open store at ${resolved.dbPath}: ${msg}`,
      `Ensure the repo was indexed and that the ${candidate} file is readable.`,
    );
  }
  try {
    return await fn(store, resolved);
  } finally {
    await ctx.pool.release(resolved.repoPath);
  }
}
