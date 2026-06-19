/**
 * Server-wide wiring tests.
 *
 * These sit above `tool-handlers.test.ts` (which exercises individual
 * tool handlers against a fake store) and assert ambient guarantees
 * about the shape of the built server itself — specifically, that it
 * advertises the right capability set and registers the right set of
 * prompts.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: private SDK field access in tests

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerDiscoverResult } from "./discover.js";
import { CATALOG_CACHE_SCOPE, CATALOG_TTL_MS, SERVER_DISCOVER_METHOD } from "./discover.js";
import type { UnsupportedProtocolVersionDetail } from "./error-envelope.js";
import { SERVER_NAME, SERVER_VERSION } from "./identity.js";
import { PROTOCOL_VERSION_META_KEY, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol-version.js";
import { buildServer } from "./server.js";

/**
 * Reach into the low-level SDK `Server`'s private `_requestHandlers` map and
 * pull a JSON-RPC method handler so a test can invoke it directly with a
 * fabricated request + extra — the same shape the dispatcher passes. Used
 * for protocol-framing methods (`server/discover`) and the catalog list
 * handlers (`tools/list` etc.) that the SDK installs on `server.server`.
 */
function getRequestHandler(
  running: { server: unknown },
  method: string,
): ((request: unknown, extra: unknown) => Promise<Record<string, unknown>>) | undefined {
  const lowLevel = (running.server as { server?: unknown }).server;
  const handlers = (lowLevel as { _requestHandlers?: Map<string, unknown> })?._requestHandlers;
  const handler = handlers?.get(method);
  return handler as
    | ((request: unknown, extra: unknown) => Promise<Record<string, unknown>>)
    | undefined;
}

/**
 * Reach into the SDK's private `_registeredTools` map and pull a tool's
 * wrapped handler so a test can invoke it with a fabricated `extra`
 * (carrying per-request `_meta`) — the same shape the SDK passes at call
 * time. We target `list_repos` because it is the only zero-arg tool that
 * needs no store: its callback is `(extra)`, so `extra` is the sole arg.
 */
function getToolHandler(
  server: unknown,
  name: string,
): (extra: { _meta?: Record<string, unknown> }) => Promise<CallToolResult> {
  const tools = (server as { _registeredTools?: Record<string, { handler: unknown }> })
    ._registeredTools;
  const entry = tools?.[name];
  assert.ok(entry, `tool ${name} must be registered`);
  return entry.handler as (extra: { _meta?: Record<string, unknown> }) => Promise<CallToolResult>;
}

async function withEmptyHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-server-test-"));
  try {
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(resolve(regDir, "registry.json"), "{}");
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("buildServer registers zero prompts — ListPrompts returns an empty set", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const withPrivate = running.server as unknown as {
        _registeredPrompts?: Record<string, unknown>;
      };
      const prompts = withPrivate._registeredPrompts ?? {};
      assert.deepEqual(Object.keys(prompts), []);
    } finally {
      await running.shutdown();
    }
  });
});

/**
 * The complete set of tool wire-names the server must register. This is the
 * authoritative contract clients depend on — a tool whose `registerXxxTool`
 * call is dropped from `buildServer` silently disappears from the surface
 * even though its module compiles and its handler tests pass. Pinning the
 * exact set here turns that class of regression into a failing assertion.
 */
const EXPECTED_TOOL_NAMES = [
  "api_impact",
  "change_pack",
  "context",
  "dependencies",
  "detect_changes",
  "group_contracts",
  "group_cross_repo_links",
  "group_list",
  "group_query",
  "group_status",
  "group_sync",
  "impact",
  "license_audit",
  "list_dead_code",
  "list_findings",
  "list_findings_delta",
  "list_repos",
  "owners",
  "pack_codebase",
  "project_profile",
  "query",
  "risk_trends",
  "route_map",
  "scan",
  "shape_check",
  "signature",
  "sql",
  "tool_map",
  "verdict",
].sort();

test("buildServer registers exactly the expected read-only tool set", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const withPrivate = running.server as unknown as {
        _registeredTools?: Record<string, unknown>;
      };
      const registered = Object.keys(withPrivate._registeredTools ?? {}).sort();
      assert.deepEqual(registered, EXPECTED_TOOL_NAMES);
      // `signature` was built + tested but historically never wired into the
      // server; this guards against it (or any tool) silently dropping out.
      assert.ok(registered.includes("signature"), "signature tool must be registered");
      // The MCP surface is read-only by rail: the source-mutating `rename`
      // and `remove_dead_code` tools were removed, so no registered tool
      // edits a user's source files.
      assert.ok(
        !registered.includes("rename"),
        "source-mutating rename tool must NOT be registered",
      );
      assert.ok(
        !registered.includes("remove_dead_code"),
        "source-mutating remove_dead_code tool must NOT be registered",
      );
      assert.equal(registered.length, 29);
    } finally {
      await running.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// E-C9: stateless per-request `_meta` protocol-version negotiation.
// ---------------------------------------------------------------------------

test("E-C9: a request asserting the supported protocolVersion in _meta is served", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getToolHandler(running.server, "list_repos");
      const result = await handler({
        _meta: { [PROTOCOL_VERSION_META_KEY]: SUPPORTED_PROTOCOL_VERSIONS[0] },
      });
      // Served normally: the list_repos body comes through, not a reject.
      assert.notEqual(result.isError, true);
      const sc = result.structuredContent as { error?: unknown; repos?: unknown };
      assert.equal(sc.error, undefined);
      assert.ok(Array.isArray(sc.repos));
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C9: a request with no protocolVersion in _meta is served (back-compat)", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getToolHandler(running.server, "list_repos");
      // No _meta at all — current SDK handshake / pre-2026-07-28 clients.
      const result = await handler({});
      assert.notEqual(result.isError, true);
      const sc = result.structuredContent as { error?: unknown };
      assert.equal(sc.error, undefined);
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C9: a request asserting a mismatched protocolVersion is rejected", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getToolHandler(running.server, "list_repos");
      const result = await handler({
        _meta: { [PROTOCOL_VERSION_META_KEY]: "2025-03-26" },
      });
      assert.equal(result.isError, true);
      const detail = (result.structuredContent as { error: UnsupportedProtocolVersionDetail })
        .error;
      assert.equal(detail.code, "UNSUPPORTED_PROTOCOL_VERSION");
      assert.equal(detail.error_code, "UNSUPPORTED_PROTOCOL_VERSION");
      assert.equal(detail.jsonrpc_code, -32602);
      assert.equal(detail.requested, "2025-03-26");
      const supported = [...detail.supported];
      assert.ok(supported.includes("2026-07-28"), "supported must include the pinned version");
      // U7: supported[] is lex-sorted.
      assert.deepEqual(supported, [...supported].sort());
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C9 / U7: two identical mismatched requests produce byte-identical error bodies", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getToolHandler(running.server, "list_repos");
      const meta = { _meta: { [PROTOCOL_VERSION_META_KEY]: "2025-11-25" } };
      const a = await handler(meta);
      const b = await handler(meta);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C9: the protocol gate reaches non-repo tools that bypass withStore", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      // `group_list` and `tool_map` do not funnel through `withStore`, so
      // they prove the chokepoint covers the full surface, not just the
      // per-repo tools.
      for (const name of ["group_list", "tool_map"]) {
        const handler = getToolHandler(running.server, name);
        const result = await handler({
          _meta: { [PROTOCOL_VERSION_META_KEY]: "1999-01-01" },
        });
        assert.equal(result.isError, true, `${name} must reject a bad protocol version`);
        const detail = (result.structuredContent as { error: { code: string } }).error;
        assert.equal(detail.code, "UNSUPPORTED_PROTOCOL_VERSION", `${name} reject envelope`);
      }
    } finally {
      await running.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// E-C10: server/discover advertises identity + protocol versions + the 29 tools.
// ---------------------------------------------------------------------------

test("E-C10: server/discover advertises identity, protocol versions, and the 29 tools", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getRequestHandler(running, SERVER_DISCOVER_METHOD);
      assert.ok(handler, "server/discover must be registered");
      const result = (await handler(
        { method: SERVER_DISCOVER_METHOD },
        {},
      )) as unknown as ServerDiscoverResult;

      // Server identity from the shared SERVER_NAME / SERVER_VERSION constants.
      assert.deepEqual(result.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION });
      assert.equal(result.serverInfo.name, "opencodehub");

      // Supported protocol versions = T-C9's pinned set, lex-sorted (U7).
      assert.deepEqual(result.protocolVersions, [...SUPPORTED_PROTOCOL_VERSIONS].sort());
      assert.ok(result.protocolVersions.includes("2026-07-28"));

      // The advertised tools are the REAL 29 (not the stale 28), name-sorted.
      const names = result.tools.map((t) => t.name);
      assert.equal(names.length, 29, "server/discover must advertise the real 29 tools, not 28");
      assert.deepEqual(names, EXPECTED_TOOL_NAMES);
      assert.deepEqual(names, [...names].sort());
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C10 / U7: two server/discover calls produce byte-identical bodies", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getRequestHandler(running, SERVER_DISCOVER_METHOD);
      assert.ok(handler);
      const a = await handler({ method: SERVER_DISCOVER_METHOD }, {});
      const b = await handler({ method: SERVER_DISCOVER_METHOD }, {});
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await running.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// E-C11: ping / logging/setLevel / notifications/roots/list_changed removed.
// ---------------------------------------------------------------------------

test("E-C11: ping is no longer served (SDK default de-registered)", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      assert.equal(
        getRequestHandler(running, "ping"),
        undefined,
        "the SDK's default `ping` handler must be removed",
      );
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C11: logging/setLevel and roots/list_changed are never served (no capability)", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      // OCH never declares the `logging` capability, so the SDK installs no
      // `logging/setLevel` handler; log level moves to per-request `_meta`.
      assert.equal(getRequestHandler(running, "logging/setLevel"), undefined);
      // The server installs no `notifications/roots/list_changed` handler
      // (it only ever *sends* `roots/list`), so it is absent by posture.
      assert.equal(getRequestHandler(running, "notifications/roots/list_changed"), undefined);
    } finally {
      await running.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// E-C12: tools/list, resources/list, and resource reads carry ttlMs + cacheScope.
// ---------------------------------------------------------------------------

test("E-C12: tools/list carries ttlMs + cacheScope (never etag)", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getRequestHandler(running, "tools/list");
      assert.ok(handler, "tools/list must be installed");
      const result = await handler({ method: "tools/list" }, {});
      assert.equal(result["ttlMs"], CATALOG_TTL_MS);
      assert.equal(result["cacheScope"], CATALOG_CACHE_SCOPE);
      assert.equal(result["cacheScope"], "shared");
      assert.equal(result["etag"], undefined, "etag must NOT be present (corrected to ttlMs)");
      assert.ok(Array.isArray(result["tools"]), "the original list body is preserved");
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C12: resources/list carries ttlMs + cacheScope", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getRequestHandler(running, "resources/list");
      assert.ok(handler, "resources/list must be installed");
      const result = await handler({ method: "resources/list" }, {});
      assert.equal(result["ttlMs"], CATALOG_TTL_MS);
      assert.equal(result["cacheScope"], "shared");
      assert.ok(Array.isArray(result["resources"]));
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C12: a resource read carries ttlMs + cacheScope", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const handler = getRequestHandler(running, "resources/read");
      assert.ok(handler, "resources/read must be installed");
      // `codehub://repos` reads the (empty) registry — no store needed.
      const result = await handler(
        { method: "resources/read", params: { uri: "codehub://repos" } },
        {},
      );
      assert.equal(result["ttlMs"], CATALOG_TTL_MS);
      assert.equal(result["cacheScope"], "shared");
      assert.ok(Array.isArray(result["contents"]), "the original read body is preserved");
    } finally {
      await running.shutdown();
    }
  });
});

test("E-C12: prompts/list is unreachable for OCH (zero prompts) — no cache-hint wrap needed", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      // OCH registers zero prompts, so the SDK never installs prompts/list;
      // the cache-hint wrap is a documented no-op for it. This pins that the
      // method genuinely isn't served (rather than silently serving without
      // hints), matching the "confirm reachability before wiring" note.
      assert.equal(
        getRequestHandler(running, "prompts/list"),
        undefined,
        "prompts/list must not be installed when zero prompts are registered",
      );
    } finally {
      await running.shutdown();
    }
  });
});
