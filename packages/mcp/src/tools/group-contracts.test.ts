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
import { registerGroupContractsTool } from "./group-contracts.js";
import type { ToolContext } from "./shared.js";

interface FetchEdge {
  readonly fromId: string;
  readonly toId: string;
}
interface RouteNode {
  readonly id: string;
  readonly method: string;
  readonly url: string;
}

interface FakeRepo {
  readonly name: string;
  readonly fetches: readonly FetchEdge[];
  readonly routes: readonly RouteNode[];
}

function makeFakeStore(data: FakeRepo): DuckDbStore {
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
      _p: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      if (sql.includes("FROM relations") && sql.includes("FETCHES")) {
        return data.fetches.map((f) => ({ from_id: f.fromId, to_id: f.toId }));
      }
      if (sql.includes("FROM nodes") && sql.includes("Route")) {
        return data.routes.map((r) => ({ id: r.id, method: r.method, url: r.url }));
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
  return api;
}

async function withHarness(
  repos: readonly FakeRepo[],
  groupRepos: readonly string[],
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-contracts-"));
  try {
    const registry: Record<string, unknown> = {};
    const repoPaths = new Map<string, string>();
    for (const r of repos) {
      const repoPath = resolve(home, r.name);
      await mkdir(repoPath, { recursive: true });
      repoPaths.set(r.name, repoPath);
      registry[r.name] = {
        name: r.name,
        path: repoPath,
        indexedAt: "2026-04-18T00:00:00Z",
        nodeCount: 0,
        edgeCount: 0,
        lastCommit: "abc",
      };
    }
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(resolve(regDir, "registry.json"), JSON.stringify(registry));

    const groupsDir = resolve(home, ".codehub", "groups");
    await mkdir(groupsDir, { recursive: true });
    const groupContent = {
      name: "stack",
      createdAt: "2026-04-18T00:00:00Z",
      repos: groupRepos.map((n) => ({ name: n, path: repoPaths.get(n) ?? "" })),
    };
    await writeFile(resolve(groupsDir, "stack.json"), JSON.stringify(groupContent));

    const pool = new ConnectionPool({ max: 4, ttlMs: 60_000 }, async (dbPath) => {
      for (const r of repos) {
        const rp = repoPaths.get(r.name);
        if (rp && dbPath.startsWith(rp)) return makeFakeStore(r);
      }
      throw new Error(`no fake store wired for ${dbPath}`);
    });

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

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function getHandler(server: McpServer, name: string): RegisteredTool["handler"] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal access for test-only
  const map = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

test("group_contracts resolves a consumer unresolved FETCHES to a producer Route", async () => {
  const repos: FakeRepo[] = [
    {
      name: "client",
      fetches: [
        {
          fromId: "Function:client/src/api.ts:loadUsers",
          toId: "fetches:unresolved:GET:/api/users",
        },
      ],
      routes: [],
    },
    {
      name: "server",
      fetches: [],
      routes: [
        {
          id: "Route:server/src/server.ts:GET-api-users",
          method: "GET",
          url: "/api/users",
        },
      ],
    },
  ];
  await withHarness(repos, ["client", "server"], async (ctx, server) => {
    registerGroupContractsTool(server, ctx);
    const handler = getHandler(server, "group_contracts");
    const result = await handler({ groupName: "stack" }, {});
    const sc = result.structuredContent as {
      groupName: string;
      contracts: Array<{
        consumerRepo: string;
        consumerSymbol: string;
        producerRepo: string;
        producerRoute: string;
        method: string;
        path: string;
      }>;
    };
    assert.equal(sc.groupName, "stack");
    assert.equal(sc.contracts.length, 1);
    const first = sc.contracts[0];
    assert.ok(first);
    assert.equal(first.consumerRepo, "client");
    assert.equal(first.producerRepo, "server");
    assert.equal(first.method, "GET");
    assert.equal(first.path, "/api/users");
  });
});

test("group_contracts normalises :id and {id} to the same key", async () => {
  const repos: FakeRepo[] = [
    {
      name: "client",
      fetches: [
        {
          fromId: "Function:client/api.ts:getUser",
          toId: "fetches:unresolved:GET:/users/{id}",
        },
      ],
      routes: [],
    },
    {
      name: "server",
      fetches: [],
      routes: [
        {
          id: "Route:server/server.ts:GET-users-id",
          method: "GET",
          url: "/users/:id",
        },
      ],
    },
  ];
  await withHarness(repos, ["client", "server"], async (ctx, server) => {
    registerGroupContractsTool(server, ctx);
    const handler = getHandler(server, "group_contracts");
    const result = await handler({ groupName: "stack" }, {});
    const sc = result.structuredContent as { contracts: unknown[] };
    assert.equal(sc.contracts.length, 1);
  });
});

test("group_contracts returns NOT_FOUND for an unknown group", async () => {
  await withHarness([], [], async (ctx, server) => {
    registerGroupContractsTool(server, ctx);
    const handler = getHandler(server, "group_contracts");
    const result = await handler({ groupName: "ghost" }, {});
    assert.equal(result.isError, true);
    const sc = result.structuredContent as { error: { code: string } };
    assert.equal(sc.error.code, "NOT_FOUND");
  });
});
