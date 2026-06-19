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
import type { UnsupportedProtocolVersionDetail } from "./error-envelope.js";
import { PROTOCOL_VERSION_META_KEY, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol-version.js";
import { buildServer } from "./server.js";

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
