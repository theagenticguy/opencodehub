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

function makeFakeStore(rows: readonly FakeProcessRow[]): DuckDbStore {
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
      if (
        text.startsWith(
          "SELECT id, name, inferred_label, step_count, entry_point_id, file_path FROM nodes WHERE kind = 'Process'",
        )
      ) {
        const limit = Number(params[0] ?? 20);
        const sorted = [...rows].sort((a, b) => {
          const sc = (b.step_count ?? 0) - (a.step_count ?? 0);
          if (sc !== 0) return sc;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return sorted.slice(0, limit).map((r) => ({
          id: r.id,
          name: r.name,
          inferred_label: r.inferred_label ?? null,
          step_count: r.step_count ?? null,
          entry_point_id: r.entry_point_id ?? null,
          file_path: r.file_path ?? "",
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
  rows: readonly FakeProcessRow[],
  fn: (server: McpServer, ctx: ResourceContext, repoName: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-processes-test-"));
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
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore(rows));
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
