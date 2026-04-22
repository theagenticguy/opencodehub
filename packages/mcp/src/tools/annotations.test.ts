/**
 * Annotations coverage test — W4-G.2.
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
  const running = buildServer({ home });
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

test("destructive tools are correctly flagged", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-mcp-destructive-"));
  const running = buildServer({ home });
  try {
    const tools = enumerateTools(running.server);
    // `rename` is the only v1.0 tool that mutates user files.
    assert.equal(
      tools["rename"]?.annotations?.destructiveHint,
      true,
      "rename must declare destructiveHint=true",
    );
    assert.equal(
      tools["rename"]?.annotations?.readOnlyHint,
      false,
      "rename must declare readOnlyHint=false",
    );
    // `scan` writes .codehub/scan.sarif and spawns external scanners.
    assert.equal(
      tools["scan"]?.annotations?.readOnlyHint,
      false,
      "scan must declare readOnlyHint=false",
    );
    assert.equal(
      tools["scan"]?.annotations?.openWorldHint,
      true,
      "scan must declare openWorldHint=true (spawns external binaries)",
    );
    // `remove_dead_code` deletes source ranges when apply=true.
    assert.equal(
      tools["remove_dead_code"]?.annotations?.destructiveHint,
      true,
      "remove_dead_code must declare destructiveHint=true",
    );
    assert.equal(
      tools["remove_dead_code"]?.annotations?.readOnlyHint,
      false,
      "remove_dead_code must declare readOnlyHint=false",
    );
    assert.equal(
      tools["remove_dead_code"]?.annotations?.openWorldHint,
      false,
      "remove_dead_code must declare openWorldHint=false",
    );
  } finally {
    await running.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("read-only tools are all readOnly=true, destructive=false", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-mcp-readonly-"));
  const running = buildServer({ home });
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
