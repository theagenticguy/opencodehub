// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import { registerRouteMapTool } from "./route-map.js";
import type { ToolContext } from "./shared.js";

interface RouteFixture {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly filePath: string;
  readonly responseKeys: readonly string[];
}

interface RelFixture {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
}

interface Fixture {
  readonly routes: readonly RouteFixture[];
  readonly relations: readonly RelFixture[];
}

function makeFakeStore(data: Fixture): DuckDbStore {
  return {
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
      if (text.includes("kind = 'Route'")) {
        let out = [...data.routes];
        let pi = 0;
        if (text.includes("url LIKE ?")) {
          const v = String(params[pi++] ?? "").replace(/%/g, "");
          out = out.filter((r) => r.url.includes(v));
        }
        if (text.includes("method = ?")) {
          const v = params[pi++];
          out = out.filter((r) => r.method === v);
        }
        return out.map((r) => ({
          id: r.id,
          name: `${r.method} ${r.url}`,
          method: r.method,
          url: r.url,
          file_path: r.filePath,
          response_keys: [...r.responseKeys],
        }));
      }
      if (text.startsWith("SELECT from_id FROM relations")) {
        const to = params[0];
        const type = params[1];
        return data.relations
          .filter((r) => r.toId === to && r.type === type)
          .map((r) => ({ from_id: r.fromId }));
      }
      return [];
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
  } as unknown as DuckDbStore;
}

async function withHarness(
  data: Fixture,
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-route-map-"));
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
          lastCommit: "abc",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore(data));
    const ctx: ToolContext = { pool, home };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    try {
      await fn(ctx, server);
    } finally {
      await pool.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

function getHandler(server: McpServer, name: string) {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

test("route_map returns routes with joined handlers and consumers", async () => {
  const data: Fixture = {
    routes: [
      {
        id: "Route:src/users.ts:GET:/users",
        url: "/users",
        method: "GET",
        filePath: "src/users.ts",
        responseKeys: ["id", "email"],
      },
    ],
    relations: [
      {
        fromId: "File:src/users.ts:src/users.ts",
        toId: "Route:src/users.ts:GET:/users",
        type: "HANDLES_ROUTE",
      },
      {
        fromId: "Function:src/ui.ts:loadUsers",
        toId: "Route:src/users.ts:GET:/users",
        type: "FETCHES",
      },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerRouteMapTool(server, ctx);
    const handler = getHandler(server, "route_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        url: string;
        handlers: string[];
        consumers: string[];
        responseKeys: string[];
      }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.routes[0]?.url, "/users");
    assert.deepEqual(sc.routes[0]?.responseKeys, ["id", "email"]);
    assert.deepEqual(sc.routes[0]?.handlers, ["File:src/users.ts:src/users.ts"]);
    assert.deepEqual(sc.routes[0]?.consumers, ["Function:src/ui.ts:loadUsers"]);
  });
});

test("route_map filters by method", async () => {
  const data: Fixture = {
    routes: [
      {
        id: "Route:r1",
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: [],
      },
      {
        id: "Route:r2",
        url: "/b",
        method: "POST",
        filePath: "b.ts",
        responseKeys: [],
      },
    ],
    relations: [],
  };
  await withHarness(data, async (ctx, server) => {
    registerRouteMapTool(server, ctx);
    const handler = getHandler(server, "route_map");
    const result = await handler({ repo: "fakerepo", method: "POST" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ method: string; url: string }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.routes[0]?.method, "POST");
    assert.equal(sc.routes[0]?.url, "/b");
  });
});

test("route_map returns empty list with remediation when no routes match", async () => {
  await withHarness({ routes: [], relations: [] }, async (ctx, server) => {
    registerRouteMapTool(server, ctx);
    const handler = getHandler(server, "route_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: unknown[];
      total: number;
      next_steps: string[];
    };
    assert.equal(sc.total, 0);
    assert.ok(sc.next_steps.length > 0);
  });
});
