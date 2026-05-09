// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `codehub://repo/{name}/process/{processName}`
 * MCP resource.
 *
 * Surfaces exercised:
 *   - Resolves processName by Process.name and by inferredLabel fallback.
 *   - Ordered trace: entry point lands at step 0; PROCESS_STEP edges seed
 *     subsequent steps in step-ASC order.
 *   - Empty trace (no PROCESS_STEP edges beyond the entry point) emits an
 *     empty list, not an error.
 *   - Unknown processName returns `{error, candidates}` with up to 5
 *     similar names.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeEdgeLike,
  type FakeNodeLike,
  getResourceHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import { registerRepoProcessResource } from "./repo-process.js";
import type { ResourceContext } from "./repos.js";

interface FakeProcessNode {
  id: string;
  name: string;
  inferredLabel?: string;
  entryPointId?: string;
  stepCount?: number;
  filePath?: string;
}

interface FakeSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
}

interface FakeProcessStep {
  fromId: string;
  toId: string;
  step: number;
}

/**
 * Project test seeds onto the typed-finder data shape: Process nodes
 * and symbol nodes go into `nodes`; PROCESS_STEP edges go into `edges`.
 */
function buildFakeGraph(
  processes: readonly FakeProcessNode[],
  symbols: readonly FakeSymbol[],
  steps: readonly FakeProcessStep[],
): { nodes: FakeNodeLike[]; edges: FakeEdgeLike[] } {
  const nodes: FakeNodeLike[] = [];
  for (const p of processes) {
    nodes.push({
      id: p.id,
      kind: "Process",
      name: p.name,
      filePath: p.filePath ?? "",
      inferredLabel: p.inferredLabel,
      entryPointId: p.entryPointId,
      stepCount: p.stepCount ?? 0,
    });
  }
  for (const s of symbols) {
    nodes.push({ id: s.id, kind: s.kind, name: s.name, filePath: s.filePath });
  }
  const edges: FakeEdgeLike[] = steps.map((s) => ({
    type: "PROCESS_STEP",
    fromId: s.fromId,
    toId: s.toId,
    step: s.step,
  }));
  return { nodes, edges };
}

async function withHarness(
  processes: readonly FakeProcessNode[],
  symbols: readonly FakeSymbol[],
  steps: readonly FakeProcessStep[],
  fn: (
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    ctx: ResourceContext,
    repoName: string,
  ) => Promise<void>,
): Promise<void> {
  const graph = buildFakeGraph(processes, symbols, steps);
  await withMcpHarness(
    {
      tmpPrefix: "codehub-process-test-",
      serverCapabilities: { resources: {} },
      storeFactory: () => makeFakeGraphStore({ nodes: graph.nodes, edges: graph.edges }),
    },
    async ({ server, pool, home, repoName }) => {
      const ctx: ResourceContext = { pool, home };
      await fn(server, ctx, repoName);
    },
  );
}

test("repo-process: renders trace with entry point as step 0 and PROCESS_STEP rows in step ASC", async () => {
  await withHarness(
    [
      {
        id: "P:1",
        name: "handleRequest-flow",
        inferredLabel: "auth session request",
        entryPointId: "F:handleRequest",
        stepCount: 3,
        filePath: "src/app.ts",
      },
    ],
    [
      { id: "F:handleRequest", name: "handleRequest", kind: "Function", filePath: "src/app.ts" },
      { id: "F:auth", name: "auth", kind: "Function", filePath: "src/auth.ts" },
      { id: "F:validate", name: "validate", kind: "Function", filePath: "src/auth.ts" },
      { id: "F:respond", name: "respond", kind: "Function", filePath: "src/app.ts" },
    ],
    [
      { fromId: "F:handleRequest", toId: "F:auth", step: 1 },
      { fromId: "F:auth", toId: "F:validate", step: 2 },
      { fromId: "F:handleRequest", toId: "F:respond", step: 1 },
    ],
    async (server, ctx, repoName) => {
      registerRepoProcessResource(server, ctx);
      const handler = getResourceHandler(server, "repo-process");
      const uri = new URL(
        `codehub://repo/${encodeURIComponent(repoName)}/process/handleRequest-flow`,
      );
      const result = await handler(uri, { name: repoName, processName: "handleRequest-flow" }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^repo: fakerepo$/m);
      assert.match(text, /^process:/m);
      assert.match(text, /^ {2}id: "P:1"$/m);
      assert.match(text, /^ {2}label: "auth session request"$/m);
      assert.match(text, /^ {2}processType: flow$/m);
      assert.match(text, /^trace:/m);

      const entryIdx = text.indexOf("name: handleRequest");
      const authIdx = text.indexOf("name: auth");
      const validateIdx = text.indexOf("name: validate");
      assert.ok(entryIdx > 0);
      assert.ok(authIdx > 0);
      assert.ok(validateIdx > 0);
      assert.ok(entryIdx < authIdx, "step 0 (entry) must precede step 1");
      assert.ok(authIdx < validateIdx, "step 1 must precede step 2");
      // step: 0 for the entry; step: 1 and step: 2 for BFS (as list item prefix).
      assert.match(text, /^ {2}- step: 0$/m);
      assert.match(text, /^ {2}- step: 1$/m);
      assert.match(text, /^ {2}- step: 2$/m);
      // Field name must be `label`, not the banned alias.
      assert.doesNotMatch(text, new RegExp(`${"heuristic"}${"Label"}`));
    },
  );
});

test("repo-process: resolves by inferredLabel fallback", async () => {
  await withHarness(
    [
      {
        id: "P:1",
        name: "handleRequest-flow",
        inferredLabel: "auth session request",
        entryPointId: "F:handleRequest",
        stepCount: 1,
        filePath: "src/app.ts",
      },
    ],
    [{ id: "F:handleRequest", name: "handleRequest", kind: "Function", filePath: "src/app.ts" }],
    [],
    async (server, ctx, repoName) => {
      registerRepoProcessResource(server, ctx);
      const handler = getResourceHandler(server, "repo-process");
      const encoded = encodeURIComponent("auth session request");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/process/${encoded}`);
      const result = await handler(uri, { name: repoName, processName: encoded }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^ {2}id: "P:1"$/m);
      assert.match(text, /handleRequest/);
    },
  );
});

test("repo-process: empty trace (only entry point, no steps) still emits step 0 row", async () => {
  await withHarness(
    [
      {
        id: "P:1",
        name: "main-flow",
        entryPointId: "F:main",
        stepCount: 0,
        filePath: "src/index.ts",
      },
    ],
    [{ id: "F:main", name: "main", kind: "Function", filePath: "src/index.ts" }],
    [],
    async (server, ctx, repoName) => {
      registerRepoProcessResource(server, ctx);
      const handler = getResourceHandler(server, "repo-process");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/process/main-flow`);
      const result = await handler(uri, { name: repoName, processName: "main-flow" }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^trace:/m);
      assert.match(text, /^ {2}- step: 0$/m);
      assert.match(text, /name: main/);
      assert.doesNotMatch(text, /error:/);
    },
  );
});

test("repo-process: unknown processName returns error envelope with candidates", async () => {
  await withHarness(
    [
      {
        id: "P:1",
        name: "handleRequest-flow",
        inferredLabel: "auth request",
        entryPointId: "F:x",
      },
      {
        id: "P:2",
        name: "login-flow",
        inferredLabel: "login auth",
        entryPointId: "F:y",
      },
      {
        id: "P:3",
        name: "orders-flow",
        inferredLabel: "orders stripe",
        entryPointId: "F:z",
      },
    ],
    [],
    [],
    async (server, ctx, repoName) => {
      registerRepoProcessResource(server, ctx);
      const handler = getResourceHandler(server, "repo-process");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/process/auth-missing`);
      const result = await handler(uri, { name: repoName, processName: "auth-missing" }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^error: "not found"$/m);
      assert.match(text, /^candidates:$/m);
      // "auth"-bearing names should outrank "orders-flow".
      const ordersIdx = text.indexOf("orders-flow");
      const authIdx = text.indexOf("auth request");
      assert.ok(authIdx > 0, "candidate with 'auth' token must surface");
      if (ordersIdx > 0) {
        assert.ok(authIdx < ordersIdx, "auth candidate outranks orders");
      }
    },
  );
});
