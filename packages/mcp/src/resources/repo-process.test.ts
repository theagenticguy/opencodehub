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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { KnowledgeGraph } from "@opencodehub/core-types";
import type {
  BulkLoadStats,
  DuckDbStore,
  EmbeddingRow,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { ConnectionPool } from "../connection-pool.js";
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

function makeFakeStore(
  processes: readonly FakeProcessNode[],
  symbols: readonly FakeSymbol[],
  steps: readonly FakeProcessStep[],
): DuckDbStore {
  const api = {
    open: async () => {},
    close: async () => {},
    createSchema: async () => {},
    bulkLoad: async (_g: KnowledgeGraph): Promise<BulkLoadStats> => ({
      nodeCount: 0,
      edgeCount: 0,
      durationMs: 0,
    }),
    upsertEmbeddings: async (_r: readonly EmbeddingRow[]): Promise<void> => {},
    query: async (
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      const text = sql.replace(/\s+/g, " ").trim();

      // Process node resolver (name OR inferred_label).
      if (
        text.startsWith(
          "SELECT id, name, inferred_label, entry_point_id, step_count, file_path FROM nodes WHERE kind = 'Process' AND (name = ? OR inferred_label = ?)",
        )
      ) {
        const target = String(params[0] ?? "");
        const found = processes.find((p) => p.name === target || p.inferredLabel === target);
        return found
          ? [
              {
                id: found.id,
                name: found.name,
                inferred_label: found.inferredLabel ?? null,
                entry_point_id: found.entryPointId ?? null,
                step_count: found.stepCount ?? null,
                file_path: found.filePath ?? "",
              },
            ]
          : [];
      }

      // Single-node lookup for the entry-point seed.
      if (text.startsWith("SELECT id, name, kind, file_path FROM nodes WHERE id = ?")) {
        const id = String(params[0]);
        const node = symbols.find((s) => s.id === id);
        return node
          ? [
              {
                id: node.id,
                name: node.name,
                kind: node.kind,
                file_path: node.filePath,
              },
            ]
          : [];
      }

      // PROCESS_STEP walk.
      if (
        text.startsWith(
          "SELECT r.to_id AS to_id, r.step AS step, n.name AS name, n.kind AS kind, n.file_path AS file_path FROM relations r JOIN nodes n ON n.id = r.to_id WHERE r.type = 'PROCESS_STEP' AND r.from_id = ?",
        )
      ) {
        const fromId = String(params[0]);
        return steps
          .filter((s) => s.fromId === fromId)
          .sort((a, b) => {
            if (a.step !== b.step) return a.step - b.step;
            return a.toId < b.toId ? -1 : 1;
          })
          .map((s) => {
            const sym = symbols.find((x) => x.id === s.toId);
            return {
              to_id: s.toId,
              step: s.step,
              name: sym?.name ?? "",
              kind: sym?.kind ?? "",
              file_path: sym?.filePath ?? "",
            };
          });
      }

      // Candidates list.
      if (text.startsWith("SELECT name, inferred_label FROM nodes WHERE kind = 'Process'")) {
        return processes.map((p) => ({
          name: p.name,
          inferred_label: p.inferredLabel ?? null,
        }));
      }
      throw new Error(`unsupported sql: ${text}`);
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
    bulkLoadCochanges: async (_rows: readonly unknown[]): Promise<void> => {},
    lookupCochangesForFile: async () => [],
    lookupCochangesBetween: async () => undefined,
  } as unknown as DuckDbStore;
  return api;
}

async function withHarness(
  processes: readonly FakeProcessNode[],
  symbols: readonly FakeSymbol[],
  steps: readonly FakeProcessStep[],
  fn: (server: McpServer, ctx: ResourceContext, repoName: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-process-test-"));
  try {
    const repoPath = resolve(home, "fakerepo");
    await mkdir(repoPath, { recursive: true });
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(
      resolve(regDir, "registry.json"),
      JSON.stringify({
        fakerepo: {
          name: "fakerepo",
          path: repoPath,
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () =>
      makeFakeStore(processes, symbols, steps),
    );
    const ctx: ResourceContext = { pool, home };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { resources: {} } },
    );
    try {
      await fn(server, ctx, "fakerepo");
    } finally {
      await pool.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

type ResourceRegistry = {
  readCallback: (
    uri: URL,
    vars: Record<string, string>,
    extra: unknown,
  ) => Promise<ReadResourceResult>;
};
function getResourceHandler(server: McpServer, name: string): ResourceRegistry["readCallback"] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internals for test-only access
  const map = (server as any)._registeredResourceTemplates as Record<string, ResourceRegistry>;
  const entry = map[name];
  assert.ok(entry, `resource template not registered: ${name}`);
  return entry.readCallback.bind(entry);
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
