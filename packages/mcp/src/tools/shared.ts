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
import type { DuckDbStore } from "@opencodehub/storage";
import type { ConnectionPool } from "../connection-pool.js";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { RepoResolveError, type ResolvedRepo, resolveRepo } from "../repo-resolver.js";

/**
 * Factory for opening an embedder on demand. The default factory imports
 * `@opencodehub/embedder` and calls `openOnnxEmbedder()`; tests inject a
 * fake so they don't need Arctic Embed XS weights on disk. The factory
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
 * adapts this into the SDK's `CallToolResult`; the `eval-server` HTTP
 * adapter uses the raw `text` directly. Keep this minimal — `text` is
 * the rendered agent-readable body; `structuredContent` carries the
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
 * Acquire a store for the given repo argument, invoke `fn`, and release
 * the handle unconditionally. Errors from repo resolution become
 * structured NO_INDEX/NOT_FOUND envelopes; DuckDB errors become DB_ERROR.
 * The inner function always returns a CallToolResult so the surface of
 * this helper is the same type.
 */
export async function withStore(
  ctx: ToolContext,
  repoName: string | undefined,
  fn: (store: DuckDbStore, resolved: ResolvedRepo) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  let resolved: ResolvedRepo;
  try {
    const opts = ctx.home !== undefined ? { home: ctx.home } : {};
    resolved = await resolveRepo(repoName, opts);
  } catch (err) {
    if (err instanceof RepoResolveError) {
      return toolError(err.code, err.message, err.hint);
    }
    return toolErrorFromUnknown(err);
  }

  let store: DuckDbStore;
  try {
    store = await ctx.pool.acquire(resolved.repoPath, resolved.dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(
      "DB_ERROR",
      `Failed to open DuckDB at ${resolved.dbPath}: ${msg}`,
      "Ensure the repo was indexed and that the .codehub/graph.duckdb file is readable.",
    );
  }
  try {
    return await fn(store, resolved);
  } finally {
    await ctx.pool.release(resolved.repoPath);
  }
}
