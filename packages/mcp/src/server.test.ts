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
import { buildServer } from "./server.js";

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
