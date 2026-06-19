/**
 * Stateless per-request protocol-version negotiation (MCP 2026-07-28).
 *
 * The 2026-07-28 spec revision moves protocol negotiation off the
 * `initialize` handshake and onto a per-request, stateless `_meta` model:
 * every request carries `io.modelcontextprotocol/protocolVersion`,
 * `clientInfo`, and `clientCapabilities` under `_meta`, and the server
 * MUST read them per request rather than trusting remembered handshake
 * state (E-C9). A version mismatch MUST return
 * `UnsupportedProtocolVersionError` (`UNSUPPORTED_PROTOCOL_VERSION`).
 *
 * ──────────────────────────────────────────────────────────────────────
 * SDK GATE (AC-C14). The installed `@modelcontextprotocol/sdk@1.29.0` has
 * `LATEST_PROTOCOL_VERSION = '2025-11-25'` and `SUPPORTED_PROTOCOL_VERSIONS`
 * does NOT include `'2026-07-28'` (verified in
 * node_modules/.../@modelcontextprotocol/sdk/dist/esm/types.js:2-4). The
 * SDK therefore does NOT yet negotiate `2026-07-28` at the transport
 * handshake layer.
 *
 * What the SDK *does* already expose — and what makes the per-request read
 * path implementable today WITHOUT touching transport internals — is the
 * `extra._meta` accessor on every request handler
 * (`RequestHandlerExtra._meta: RequestMeta`, an arbitrary-key passthrough
 * `z.looseObject`). So we read the `io.modelcontextprotocol/*` keys from
 * `extra._meta` per request, and reject mismatches with the structured
 * envelope.
 *
 * TODO (SDK-gated, AC-C14): once the upstream SDK ships ≥ the 2026-07-28
 * spec — i.e. `SUPPORTED_PROTOCOL_VERSIONS` in `@modelcontextprotocol/sdk`
 * includes `'2026-07-28'` — drop reliance on the SDK's `2025-11-25`
 * transport-level handshake entirely and let the SDK negotiate `2026-07-28`
 * natively. Until then this module is the application-level stateless
 * contract surface; we do NOT hand-roll `StdioServerTransport` to force the
 * version (anti-goal).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ClientCapabilities,
  Implementation,
  LoggingLevel,
  RequestMeta,
} from "@modelcontextprotocol/sdk/types.js";
import { toolUnsupportedProtocolVersionError } from "./error-envelope.js";

/** The well-known `_meta` keys defined by the 2026-07-28 stateless model. */
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion" as const;
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo" as const;
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities" as const;
/**
 * E-C11: the 2026-07-28 RC removes the stateful `logging/setLevel` request
 * and `logging` capability; a client now declares its desired log level
 * per request under this `_meta` key instead of mutating remembered server
 * state. Stateless, like the protocol-version key above.
 */
export const LOG_LEVEL_META_KEY = "io.modelcontextprotocol/logLevel" as const;

/** The eight syslog-style levels the spec's `logLevel` accepts. */
const LOG_LEVELS: readonly LoggingLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

/**
 * The protocol versions this server supports, lex-sorted (U7). Pinned to
 * `2026-07-28` per AC-C14. The *value* is fixed here; the SDK-gated part is
 * making the transport handshake negotiate it (see file header TODO).
 *
 * Exported for the sibling tasks T-C10-13 (server/discover etc.) to read.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

/**
 * The protocol version, client identity, and client capabilities a request
 * carried in its `_meta`, resolved per-request. Every field is optional:
 * pre-2026-07-28 clients (and the SDK's own current handshake) do not emit
 * these keys, so absence is the back-compat case, not an error.
 */
export interface ClientMeta {
  readonly protocolVersion?: string;
  readonly clientInfo?: Implementation;
  readonly clientCapabilities?: ClientCapabilities;
  /**
   * E-C11: the desired log level for *this* request, read from
   * `io.modelcontextprotocol/logLevel`. Replaces the removed stateful
   * `logging/setLevel` round-trip. Absent for clients that emit no
   * preference (the server then uses its own default verbosity).
   */
  readonly logLevel?: LoggingLevel;
}

/**
 * Read the `io.modelcontextprotocol/*` keys from a request's `_meta`.
 *
 * Stateless: derives everything from the per-request `_meta` argument and
 * remembers nothing. `meta` is the SDK's `RequestHandlerExtra._meta`
 * (`z.looseObject`), so the well-known keys are read by index. Returns an
 * empty object when `_meta` is absent or carries none of the keys.
 */
export function readClientMeta(meta: RequestMeta | undefined): ClientMeta {
  if (meta === undefined) return {};
  const bag = meta as Record<string, unknown>;
  const out: {
    protocolVersion?: string;
    clientInfo?: Implementation;
    clientCapabilities?: ClientCapabilities;
    logLevel?: LoggingLevel;
  } = {};
  const version = bag[PROTOCOL_VERSION_META_KEY];
  if (typeof version === "string") out.protocolVersion = version;
  const info = bag[CLIENT_INFO_META_KEY];
  if (info !== undefined && info !== null && typeof info === "object") {
    out.clientInfo = info as Implementation;
  }
  const caps = bag[CLIENT_CAPABILITIES_META_KEY];
  if (caps !== undefined && caps !== null && typeof caps === "object") {
    out.clientCapabilities = caps as ClientCapabilities;
  }
  const level = bag[LOG_LEVEL_META_KEY];
  if (typeof level === "string" && (LOG_LEVELS as readonly string[]).includes(level)) {
    out.logLevel = level as LoggingLevel;
  }
  return out;
}

/**
 * E-C11: read the per-request log level from a request's `_meta`, the
 * stateless replacement for `logging/setLevel`. Returns `undefined` when
 * the client expressed no preference (or an unrecognised level), in which
 * case the server keeps its own default verbosity.
 */
export function readLogLevel(meta: RequestMeta | undefined): LoggingLevel | undefined {
  return readClientMeta(meta).logLevel;
}

/**
 * Per-request protocol-version gate (E-C9).
 *
 * Reads the asserted protocol version from `_meta` and, when present,
 * requires it to be one of {@link SUPPORTED_PROTOCOL_VERSIONS}. Returns a
 * structured `UNSUPPORTED_PROTOCOL_VERSION` envelope on mismatch, or
 * `undefined` when the request is acceptable.
 *
 * Absent version → acceptable (back-compat: pre-2026-07-28 clients and the
 * current SDK handshake do not emit the key; rejecting them would break
 * every existing client while the SDK is still on 2025-11-25). When the SDK
 * ships native 2026-07-28 negotiation, tighten this to require the key.
 */
export function assertProtocolVersion(meta: RequestMeta | undefined): CallToolResult | undefined {
  const { protocolVersion } = readClientMeta(meta);
  if (protocolVersion === undefined) return undefined;
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
    return undefined;
  }
  return toolUnsupportedProtocolVersionError(protocolVersion, SUPPORTED_PROTOCOL_VERSIONS);
}

/**
 * The SDK `RequestHandlerExtra` shape we depend on: the per-request `_meta`
 * accessor. Kept minimal so the wrapper is decoupled from the rest of the
 * extra surface (auth, sessionId, taskStore, …) which we do not touch.
 */
interface ExtraWithMeta {
  readonly _meta?: RequestMeta;
}

/**
 * Wrap an `McpServer` so every tool registered through it runs the
 * per-request protocol-version gate (E-C9) before its handler.
 *
 * This is the single chokepoint that covers all tools — including the
 * non-repo ones (`list_repos`, `group_list`, `tool_map`) that bypass
 * `withStore` — without editing any handler body. It intercepts
 * `registerTool`, then wraps the final callback (`cb`, always the last
 * registration argument) so the gate runs first; on mismatch it returns the
 * `UNSUPPORTED_PROTOCOL_VERSION` envelope and never invokes the handler. The
 * `extra` argument is always the LAST argument the SDK passes to a tool
 * callback (`(extra)` for zero-arg tools, `(args, extra)` otherwise), so we
 * read `_meta` off the last argument regardless of arity.
 *
 * Everything except `registerTool` is forwarded to the underlying server
 * unchanged (via a `Proxy`), so resources, prompts, `connect`, `close`, and
 * private fields the tests inspect (`_registeredTools`, `_registeredPrompts`)
 * remain identical.
 */
export function withProtocolGate(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (...regArgs: unknown[]): unknown => {
          const last = regArgs.length - 1;
          const cb = regArgs[last];
          if (typeof cb !== "function") {
            // Not the (config, cb) form we expect — pass through untouched.
            return (target.registerTool as (...a: unknown[]) => unknown)(...regArgs);
          }
          const original = cb as (...handlerArgs: unknown[]) => unknown;
          const wrapped = (...handlerArgs: unknown[]): unknown => {
            const extra = handlerArgs[handlerArgs.length - 1] as ExtraWithMeta | undefined;
            const rejection = assertProtocolVersion(extra?._meta);
            if (rejection !== undefined) return rejection;
            return original(...handlerArgs);
          };
          const forwarded = [...regArgs];
          forwarded[last] = wrapped;
          return (target.registerTool as (...a: unknown[]) => unknown)(...forwarded);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
