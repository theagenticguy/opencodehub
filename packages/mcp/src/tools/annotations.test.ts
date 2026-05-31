/**
 * Annotations coverage test.
 *
 * Enumerates every tool registered by `buildServer()` and asserts each one
 * carries the five MCP-spec annotation fields plus a human-readable
 * `title`. This is a safety net: adding a new tool without annotations
 * should fail CI immediately.
 *
 * Values are not validated against a lookup table here — the intent is
 * completeness, not correctness of truth. The per-tool unit tests assert
 * semantics (e.g. rename.destructiveHint === true).
 */
// biome-ignore-all lint/complexity/useLiteralKeys: private SDK field access in tests

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../server.js";

interface RegisteredToolShape {
  readonly title?: string;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

function enumerateTools(server: McpServer): Record<string, RegisteredToolShape> {
  // SDK stores tools in `_registeredTools`. Accessing the private field is
  // the only way to introspect names + annotations without connecting a
  // transport and handling tools/list over JSON-RPC.
  const withPrivate = server as unknown as {
    _registeredTools: Record<string, RegisteredToolShape>;
  };
  return withPrivate._registeredTools;
}

test("every registered tool advertises all 5 annotation fields + a title", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-mcp-annotations-"));
  const running = buildServer({ home, silentEmbedderProbe: true });
  try {
    const tools = enumerateTools(running.server);
    const names = Object.keys(tools).sort();
    assert.ok(names.length > 0, "buildServer() should register at least one tool");

    const violations: string[] = [];
    for (const name of names) {
      const def = tools[name];
      if (!def) {
        violations.push(`${name}: missing tool definition`);
        continue;
      }
      const ann = def.annotations;
      if (typeof def.title !== "string" || def.title.length === 0) {
        violations.push(`${name}: missing human-readable title`);
      }
      if (!ann) {
        violations.push(`${name}: missing annotations block`);
        continue;
      }
      if (typeof ann.readOnlyHint !== "boolean") {
        violations.push(`${name}: annotations.readOnlyHint must be boolean`);
      }
      if (typeof ann.destructiveHint !== "boolean") {
        violations.push(`${name}: annotations.destructiveHint must be boolean`);
      }
      if (typeof ann.idempotentHint !== "boolean") {
        violations.push(`${name}: annotations.idempotentHint must be boolean`);
      }
      if (typeof ann.openWorldHint !== "boolean") {
        violations.push(`${name}: annotations.openWorldHint must be boolean`);
      }
    }
    assert.deepEqual(violations, [], `annotation violations:\n${violations.join("\n")}`);
  } finally {
    await running.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("no source-mutating tool is registered; non-read-only tools only write artifacts", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-mcp-destructive-"));
  const running = buildServer({ home, silentEmbedderProbe: true });
  try {
    const tools = enumerateTools(running.server);
    // RAIL: the MCP surface never edits a user's source files. The two tools
    // that did (`rename`, `remove_dead_code`) were removed; assert they are
    // gone so they cannot be re-added without this test failing.
    assert.equal(tools["rename"], undefined, "rename (source mutator) must not be registered");
    assert.equal(
      tools["remove_dead_code"],
      undefined,
      "remove_dead_code (source mutator) must not be registered",
    );
    // No registered tool may declare destructiveHint=true — that flag is
    // reserved for source mutation, which the rail forbids.
    for (const [name, def] of Object.entries(tools)) {
      assert.notEqual(
        def?.annotations?.destructiveHint,
        true,
        `${name} declares destructiveHint=true — no MCP tool may mutate user source`,
      );
    }
    // The surviving non-read-only tools are ARTIFACT writers (SARIF, code
    // packs, contract registries under .codehub/), not source mutators. They
    // are readOnlyHint=false but destructiveHint=false.
    for (const name of ["scan", "pack_codebase", "group_sync"]) {
      assert.equal(
        tools[name]?.annotations?.readOnlyHint,
        false,
        `${name} writes an artifact, so readOnlyHint must be false`,
      );
      assert.notEqual(
        tools[name]?.annotations?.destructiveHint,
        true,
        `${name} writes an artifact (not user source), so destructiveHint must not be true`,
      );
    }
    // `scan` spawns external scanner binaries.
    assert.equal(
      tools["scan"]?.annotations?.openWorldHint,
      true,
      "scan must declare openWorldHint=true (spawns external binaries)",
    );
  } finally {
    await running.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("read-only tools are all readOnly=true, destructive=false", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-mcp-readonly-"));
  const running = buildServer({ home, silentEmbedderProbe: true });
  try {
    const tools = enumerateTools(running.server);
    const readOnlyTools = [
      "list_repos",
      "query",
      "context",
      "impact",
      "detect_changes",
      "sql",
      "group_list",
      "group_query",
      "group_status",
      "group_contracts",
      "project_profile",
      "dependencies",
      "license_audit",
      "owners",
      "list_findings",
      "list_findings_delta",
      "list_dead_code",
      "verdict",
      "risk_trends",
      "route_map",
      "api_impact",
      "shape_check",
      "tool_map",
    ];
    for (const name of readOnlyTools) {
      const ann = tools[name]?.annotations;
      if (ann === undefined) {
        // Optional tool (may not be registered on older builds) — skip.
        continue;
      }
      assert.equal(ann.readOnlyHint, true, `${name}.readOnlyHint must be true`);
      assert.equal(ann.destructiveHint, false, `${name}.destructiveHint must be false`);
    }
  } finally {
    await running.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
