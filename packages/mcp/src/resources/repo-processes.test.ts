// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `codehub://repo/{name}/processes` MCP resource.
 *
 * Surfaces exercised:
 *   - Happy path: Process rows render with label/stepCount/entryPointId,
 *     ranked by stepCount DESC.
 *   - Empty case: no Process nodes → empty YAML list, not an error.
 *   - Cap: only the top 20 processes are emitted.
 *   - processType is always `flow` today (shape-stable).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeNodeLike,
  getResourceHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import { registerRepoProcessesResource } from "./repo-processes.js";
import type { ResourceContext } from "./repos.js";

interface FakeProcessRow {
  id: string;
  name: string;
  inferred_label?: string;
  step_count?: number;
  entry_point_id?: string;
  file_path?: string;
}

function processNodes(rows: readonly FakeProcessRow[]): FakeNodeLike[] {
  return rows.map((r) => ({
    id: r.id,
    kind: "Process",
    name: r.name,
    filePath: r.file_path ?? "",
    inferredLabel: r.inferred_label,
    stepCount: r.step_count ?? 0,
    entryPointId: r.entry_point_id,
  }));
}

async function withHarness(
  rows: readonly FakeProcessRow[],
  fn: (
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    ctx: ResourceContext,
    repoName: string,
  ) => Promise<void>,
): Promise<void> {
  await withMcpHarness(
    {
      tmpPrefix: "codehub-processes-test-",
      serverCapabilities: { resources: {} },
      storeFactory: () => makeFakeGraphStore({ nodes: processNodes(rows) }),
    },
    async ({ server, pool, home, repoName }) => {
      const ctx: ResourceContext = { pool, home };
      await fn(server, ctx, repoName);
    },
  );
}

test("repo-processes: renders Process rows ranked by stepCount DESC", async () => {
  await withHarness(
    [
      {
        id: "P:a",
        name: "handleRequest-flow",
        inferred_label: "auth request session",
        step_count: 7,
        entry_point_id: "F:handleRequest",
        file_path: "src/app.ts",
      },
      {
        id: "P:b",
        name: "main-flow",
        inferred_label: "main boot config",
        step_count: 15,
        entry_point_id: "F:main",
        file_path: "src/index.ts",
      },
      {
        id: "P:c",
        name: "login-flow",
        inferred_label: "login auth",
        step_count: 3,
        entry_point_id: "F:login",
        file_path: "src/auth.ts",
      },
    ],
    async (server, ctx, repoName) => {
      registerRepoProcessesResource(server, ctx);
      const handler = getResourceHandler(server, "repo-processes");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/processes`);
      const result = await handler(uri, { name: repoName }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^repo: fakerepo$/m);
      assert.match(text, /^processes:/m);
      const mainIdx = text.indexOf("main-flow");
      const handleIdx = text.indexOf("handleRequest-flow");
      const loginIdx = text.indexOf("login-flow");
      assert.ok(mainIdx > 0 && handleIdx > 0 && loginIdx > 0);
      assert.ok(mainIdx < handleIdx, "stepCount 15 ranks above stepCount 7");
      assert.ok(handleIdx < loginIdx, "stepCount 7 ranks above stepCount 3");
      assert.match(text, /^ {4}processType: flow$/m);
      assert.match(text, /^ {4}label: "main boot config"$/m);
      // Field name must be `label`, not the banned alias.
      assert.doesNotMatch(text, new RegExp(`${"heuristic"}${"Label"}`));
    },
  );
});

test("repo-processes: empty repo emits empty YAML list", async () => {
  await withHarness([], async (server, ctx, repoName) => {
    registerRepoProcessesResource(server, ctx);
    const handler = getResourceHandler(server, "repo-processes");
    const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/processes`);
    const result = await handler(uri, { name: repoName }, {});
    const text = (result.contents[0] as { text: string }).text;
    assert.match(text, /^processes:$/m);
    assert.match(text, /^ {2}\[\]$/m);
    assert.doesNotMatch(text, /error:/);
  });
});

test("repo-processes: caps results at 20", async () => {
  const rows: FakeProcessRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push({
      id: `P:${i.toString().padStart(3, "0")}`,
      name: `proc-${i}-flow`,
      step_count: 100 - i,
      entry_point_id: `F:entry${i}`,
    });
  }
  await withHarness(rows, async (server, ctx, repoName) => {
    registerRepoProcessesResource(server, ctx);
    const handler = getResourceHandler(server, "repo-processes");
    const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/processes`);
    const result = await handler(uri, { name: repoName }, {});
    const text = (result.contents[0] as { text: string }).text;
    const matches = text.match(/^ {2}- id:/gm) ?? [];
    assert.equal(matches.length, 20);
  });
});
