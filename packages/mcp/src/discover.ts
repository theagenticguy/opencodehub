/**
 * MCP 2026-07-28 RC protocol-framing wiring that sits *beside* the SDK's
 * own request handlers (E-C10, E-C11, E-C12).
 *
 * These three concerns all attach to the low-level `McpServer.server`
 * (`Server extends Protocol`) AFTER `buildServer` has registered all 29
 * tools and 7 resources, because they either advertise the live registered
 * set (`server/discover`) or wrap the SDK-installed list/read handlers
 * (cache hints), or de-register an SDK-default handler (`ping`).
 *
 * ──────────────────────────────────────────────────────────────────────
 * SDK GATE. The installed `@modelcontextprotocol/sdk@1.29.0` is on the
 * `2025-11-25` spec and exposes neither a `server/discover` schema nor a
 * capability flag for it (verified by reading dist/esm/types.js and
 * dist/esm/server/index.js — see the task packet). Per the same SDK-gated
 * strategy T-C9 used for the stateless `_meta` path, `server/discover` is
 * implemented application-side as a low-level JSON-RPC request handler
 * keyed on the spec method string `"server/discover"`. `Server`'s
 * `assertRequestHandlerCapability` switch has no default-throw, so an
 * unknown method registers without a capability gate. When the upstream
 * SDK ships native 2026-07-28 discovery, drop this handler and let the SDK
 * negotiate it. We do NOT touch `StdioServerTransport` (anti-goal).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Request, RequestSchema, type Result } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./identity.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol-version.js";

/**
 * E-C12 cache hints. OCH's tool/resource catalog is static within a server
 * version (`listChanged: false`, `server.ts`), so the TTL is generous and
 * the scope is shareable across sessions — two clients of the same server
 * version see byte-identical catalogs. `ttlMs` is a fixed constant (no
 * wall-clock in the value) to preserve determinism (U7). Named in the
 * spec's casing (`ttlMs`, `cacheScope`) per the protocol-framing convention
 * — NOT `etag` (the RC corrected that earlier proposal).
 */
export const CATALOG_TTL_MS = 3_600_000 as const; // 1 hour — the catalog is static within a version.
export const CATALOG_CACHE_SCOPE = "shared" as const;

/** The cache-hint fields stamped onto every list and resource-read result. */
export interface CacheHints {
  readonly ttlMs: number;
  readonly cacheScope: "shared" | "session";
}

/** The frozen cache-hint object reused for every list/read so bodies stay byte-identical (U7). */
const CATALOG_CACHE_HINTS: CacheHints = Object.freeze({
  ttlMs: CATALOG_TTL_MS,
  cacheScope: CATALOG_CACHE_SCOPE,
});

/** The advertised summary of one registered tool. */
export interface DiscoveredTool {
  readonly name: string;
}

/** The `server/discover` response shape (2026-07-28 RC). */
export interface ServerDiscoverResult {
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly protocolVersions: readonly string[];
  readonly tools: readonly DiscoveredTool[];
}

/** JSON-RPC method string for the discovery request (spec-named). */
export const SERVER_DISCOVER_METHOD = "server/discover" as const;

/**
 * Request schema for `server/discover`. The SDK keys its handler map on the
 * `method` literal (`getMethodLiteral`), so a `z.literal` here is all that
 * is needed for `setRequestHandler` to route the method. `params` is
 * optional and unused.
 */
const ServerDiscoverRequestSchema = RequestSchema.extend({
  method: z.literal(SERVER_DISCOVER_METHOD),
});

/**
 * Minimal view of the SDK `Server`'s `Protocol` surface we depend on:
 * read the installed handler out of the private map, replace it, and
 * delete by method string. Typed narrowly so we stay decoupled from the
 * rest of the protocol surface (transport, auth, tasks).
 */
type ProtocolRequestHandler = (request: Request, extra: unknown) => Promise<Result> | Result;
interface ProtocolInternals {
  readonly _requestHandlers: Map<string, ProtocolRequestHandler>;
  setRequestHandler(
    schema: typeof ServerDiscoverRequestSchema,
    handler: ProtocolRequestHandler,
  ): void;
  removeRequestHandler(method: string): void;
}

/**
 * Read the live registered tool names off the McpServer. This is the
 * single source of truth — whatever `buildServer` registered (the real
 * **29**, not a hardcoded count) is advertised. Name-sorted (U7) so two
 * `server/discover` calls produce byte-identical `tools[]`.
 */
function registeredToolNames(server: McpServer): readonly string[] {
  const withPrivate = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(withPrivate._registeredTools ?? {}).sort();
}

/**
 * Build the deterministic `server/discover` body: server identity, the
 * lex-sorted supported protocol versions (from T-C9), and the name-sorted
 * registered tools. Pure + deterministic so two calls are byte-identical
 * (U7).
 */
export function buildDiscoverResult(server: McpServer): ServerDiscoverResult {
  return {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS].sort(),
    tools: registeredToolNames(server).map((name) => ({ name })),
  };
}

/**
 * Wire the 2026-07-28 RC protocol-framing onto a fully-registered server:
 *
 *  - **E-C10** — register the `server/discover` request handler advertising
 *    identity + protocol versions + the live 29 tools.
 *  - **E-C11** — de-register the SDK's auto-installed `ping` handler. (The
 *    `logging/setLevel` request and the `notifications/roots/list_changed`
 *    handler are *already* absent under this SDK's posture — OCH sets no
 *    `logging` capability and the SDK installs no server-side roots-changed
 *    handler — so there is nothing to remove for those two; the log level
 *    is read per-request from `_meta` via `readLogLevel`.)
 *  - **E-C12** — wrap the SDK-installed `tools/list`, `resources/list`,
 *    `prompts/list`, and `resources/read` handlers so every list/read
 *    result carries `ttlMs` + `cacheScope`.
 *
 * Must run AFTER all `register*Tool`/`register*Resource` calls so the list
 * handlers exist to wrap and the discover handler sees the full tool set.
 */
export function wireProtocolFraming(server: McpServer): void {
  const proto = server.server as unknown as ProtocolInternals;

  // E-C10: server/discover. `Result` carries a `[x: string]: unknown` index
  // signature (it's a `z.looseObject`), so the precise interface is widened
  // to it at the handler boundary.
  proto.setRequestHandler(
    ServerDiscoverRequestSchema,
    () => buildDiscoverResult(server) as unknown as Result,
  );

  // E-C11: drop the SDK's default `ping` request handler. `logging/setLevel`
  // and `notifications/roots/list_changed` are never installed under OCH's
  // capability posture, so only `ping` needs removing.
  proto.removeRequestHandler("ping");

  // E-C12: stamp cache hints onto the catalog list + read results.
  for (const method of ["tools/list", "resources/list", "prompts/list", "resources/read"]) {
    wrapWithCacheHints(proto, method);
  }
}

/**
 * Replace an SDK-installed request handler with a wrapper that merges the
 * static-catalog cache hints into its result. No-op when the SDK never
 * installed the handler (e.g. `prompts/list` when zero prompts are
 * registered) so callers do not need to know which lists are reachable.
 */
function wrapWithCacheHints(proto: ProtocolInternals, method: string): void {
  const inner = proto._requestHandlers.get(method);
  if (inner === undefined) return; // handler not installed (e.g. no prompts registered)
  proto._requestHandlers.set(method, async (request, extra) => {
    const result = await inner(request, extra);
    return { ...result, ...CATALOG_CACHE_HINTS };
  });
}
