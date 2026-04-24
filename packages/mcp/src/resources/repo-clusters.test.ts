// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `codehub://repo/{name}/clusters` MCP resource.
 *
 * Surfaces exercised:
 *   - Happy path: Community rows render with label/cohesion/symbolCount
 *     and optional keywords, ranked by symbolCount DESC, cohesion DESC.
 *   - Empty case: a repo with zero Community nodes emits an empty YAML
 *     list rather than an error.
 *   - Cap: only the top 20 clusters are emitted even when more exist.
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
import { registerRepoClustersResource } from "./repo-clusters.js";
import type { ResourceContext } from "./repos.js";

interface FakeCommunityRow {
  id: string;
  name: string;
  inferred_label?: string;
  symbol_count?: number;
  cohesion?: number;
  keywords?: readonly string[];
}

function makeFakeStore(rows: readonly FakeCommunityRow[]): DuckDbStore {
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
          "SELECT id, name, inferred_label, symbol_count, cohesion, keywords FROM nodes WHERE kind = 'Community'",
        )
      ) {
        const limit = Number(params[0] ?? 20);
        const sorted = [...rows].sort((a, b) => {
          const sc = (b.symbol_count ?? 0) - (a.symbol_count ?? 0);
          if (sc !== 0) return sc;
          const coh = (b.cohesion ?? 0) - (a.cohesion ?? 0);
          if (coh !== 0) return coh;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return sorted.slice(0, limit).map((r) => ({
          id: r.id,
          name: r.name,
          inferred_label: r.inferred_label ?? null,
          symbol_count: r.symbol_count ?? null,
          cohesion: r.cohesion ?? null,
          keywords: r.keywords ?? null,
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
  rows: readonly FakeCommunityRow[],
  fn: (server: McpServer, ctx: ResourceContext, repoName: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-clusters-test-"));
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
          lastCommit: "abc123",
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

test("repo-clusters: renders Community rows ranked by size then cohesion", async () => {
  await withHarness(
    [
      {
        id: "C:b",
        name: "community-1",
        inferred_label: "auth-login-session",
        symbol_count: 8,
        cohesion: 1.5,
        keywords: ["auth", "login"],
      },
      {
        id: "C:a",
        name: "community-0",
        inferred_label: "orders-stripe",
        symbol_count: 12,
        cohesion: 2.0,
        keywords: ["order", "stripe"],
      },
      {
        id: "C:c",
        name: "community-2",
        symbol_count: 4,
        cohesion: 0.5,
      },
    ],
    async (server, ctx, repoName) => {
      registerRepoClustersResource(server, ctx);
      const handler = getResourceHandler(server, "repo-clusters");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/clusters`);
      const result = await handler(uri, { name: repoName }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^repo: fakerepo$/m);
      assert.match(text, /clusters:/);
      // orders-stripe (12 symbols) must land above auth-login-session (8).
      const ordersIdx = text.indexOf("orders-stripe");
      const authIdx = text.indexOf("auth-login-session");
      assert.ok(ordersIdx > 0 && authIdx > 0);
      assert.ok(ordersIdx < authIdx, "larger symbolCount must rank first");
      // Field name must be `label` (the banned alias must never appear).
      assert.match(text, /^ {4}label: orders-stripe$/m);
      assert.doesNotMatch(text, new RegExp(`${"heuristic"}${"Label"}`));
      assert.match(text, /^ {4}symbolCount: 12$/m);
      assert.match(text, /^ {4}cohesion: 2$/m);
      assert.match(text, /^ {6}- order$/m);
    },
  );
});

test("repo-clusters: empty repo emits an empty YAML list", async () => {
  await withHarness([], async (server, ctx, repoName) => {
    registerRepoClustersResource(server, ctx);
    const handler = getResourceHandler(server, "repo-clusters");
    const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/clusters`);
    const result = await handler(uri, { name: repoName }, {});
    const text = (result.contents[0] as { text: string }).text;
    assert.match(text, /^clusters:$/m);
    assert.match(text, /^ {2}\[\]$/m);
  });
});

test("repo-clusters: caps results at 20 even when more rows exist", async () => {
  const rows: FakeCommunityRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push({
      id: `C:${i.toString().padStart(3, "0")}`,
      name: `community-${i}`,
      symbol_count: 100 - i,
      cohesion: 1,
    });
  }
  await withHarness(rows, async (server, ctx, repoName) => {
    registerRepoClustersResource(server, ctx);
    const handler = getResourceHandler(server, "repo-clusters");
    const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/clusters`);
    const result = await handler(uri, { name: repoName }, {});
    const text = (result.contents[0] as { text: string }).text;
    const matches = text.match(/^ {2}- id:/gm) ?? [];
    assert.equal(matches.length, 20, "must cap at 20");
    // Highest-ranked (community-0 with symbolCount 100) should be first.
    assert.match(text, /community-0\b[\s\S]*community-19/);
  });
});
