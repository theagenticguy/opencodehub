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
import { classifyShape, registerShapeCheckTool } from "./shape-check.js";
import type { ToolContext } from "./shared.js";

interface RouteFx {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly responseKeys: readonly string[];
}
interface NodeFx {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly filePath: string;
}
interface RelFx {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
}

interface Fixture {
  readonly routes: readonly RouteFx[];
  readonly nodes: readonly NodeFx[];
  readonly relations: readonly RelFx[];
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

      // Route selection.
      if (
        text.startsWith("SELECT id, method, url, response_keys FROM nodes") &&
        text.includes("kind = 'Route'")
      ) {
        let out = [...data.routes];
        let pi = 0;
        if (text.includes("url LIKE ?")) {
          const v = String(params[pi++] ?? "").replace(/%/g, "");
          out = out.filter((r) => r.url.includes(v));
        }
        return out.map((r) => ({
          id: r.id,
          method: r.method,
          url: r.url,
          response_keys: [...r.responseKeys],
        }));
      }

      // FETCHES consumers for a route.
      if (text.startsWith("SELECT from_id FROM relations") && text.includes("FETCHES")) {
        const routeId = params[0];
        return data.relations
          .filter((r) => r.type === "FETCHES" && r.toId === routeId)
          .map((r) => ({ from_id: r.fromId }));
      }

      // node lookup by id list to resolve file_path per consumer symbol.
      if (text.startsWith("SELECT id, file_path FROM nodes WHERE id IN")) {
        const ids = new Set(params as string[]);
        return data.nodes
          .filter((n) => ids.has(n.id))
          .map((n) => ({ id: n.id, file_path: n.filePath }));
      }

      // ACCESSES walk: property names reachable from any symbol in a file.
      if (text.includes("r.type = 'ACCESSES'") && text.includes("src.file_path = ?")) {
        const file = params[0];
        const srcIds = new Set(data.nodes.filter((n) => n.filePath === file).map((n) => n.id));
        const names = new Set<string>();
        for (const r of data.relations) {
          if (r.type !== "ACCESSES") continue;
          if (!srcIds.has(r.fromId)) continue;
          const target = data.nodes.find((n) => n.id === r.toId);
          if (target && target.kind === "Property") names.add(target.name);
        }
        return [...names].sort().map((n) => ({ name: n }));
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
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-shape-check-"));
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

test("classifyShape: MATCH, MISMATCH, PARTIAL", () => {
  assert.equal(classifyShape(["id", "email"], ["id", "email", "name"]).status, "MATCH");
  const mis = classifyShape(["id", "ghost"], ["id", "email"]);
  assert.equal(mis.status, "MISMATCH");
  assert.deepEqual(mis.missing, ["ghost"]);
  assert.equal(classifyShape([], ["id"]).status, "PARTIAL");
});

test("shape_check returns MATCH when consumer accesses subset of responseKeys", async () => {
  const routeId = "Route:src/users.ts:GET:/users";
  const consumerSymbol = "Function:src/ui.ts:loadUsers";
  const consumerFile = "src/ui.ts";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/users",
        method: "GET",
        responseKeys: ["id", "email", "name"],
      },
    ],
    nodes: [
      { id: consumerSymbol, kind: "Function", name: "loadUsers", filePath: consumerFile },
      { id: "Property:src/ui.ts:id", kind: "Property", name: "id", filePath: consumerFile },
      { id: "Property:src/ui.ts:email", kind: "Property", name: "email", filePath: consumerFile },
    ],
    relations: [
      { fromId: consumerSymbol, toId: routeId, type: "FETCHES" },
      { fromId: consumerSymbol, toId: "Property:src/ui.ts:id", type: "ACCESSES" },
      {
        fromId: consumerSymbol,
        toId: "Property:src/ui.ts:email",
        type: "ACCESSES",
      },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerShapeCheckTool(server, ctx);
    const handler = getHandler(server, "shape_check");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        url: string;
        responseKeys: string[];
        consumers: Array<{
          file: string;
          accessedKeys: string[];
          status: "MATCH" | "MISMATCH" | "PARTIAL";
          missing: string[];
        }>;
      }>;
    };
    assert.equal(sc.routes.length, 1);
    assert.equal(sc.routes[0]?.consumers.length, 1);
    const consumer = sc.routes[0]?.consumers[0];
    assert.equal(consumer?.file, consumerFile);
    assert.equal(consumer?.status, "MATCH");
    assert.deepEqual(consumer?.accessedKeys, ["email", "id"]);
    assert.deepEqual(consumer?.missing, []);
  });
});

test("shape_check returns MISMATCH when consumer reads an unknown key", async () => {
  const routeId = "Route:r";
  const consumerSymbol = "Function:c";
  const consumerFile = "c.ts";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/x",
        method: "GET",
        responseKeys: ["id"],
      },
    ],
    nodes: [
      { id: consumerSymbol, kind: "Function", name: "fn", filePath: consumerFile },
      { id: "Property:ghost", kind: "Property", name: "ghost", filePath: consumerFile },
    ],
    relations: [
      { fromId: consumerSymbol, toId: routeId, type: "FETCHES" },
      { fromId: consumerSymbol, toId: "Property:ghost", type: "ACCESSES" },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerShapeCheckTool(server, ctx);
    const handler = getHandler(server, "shape_check");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        consumers: Array<{ status: string; missing: string[] }>;
      }>;
    };
    assert.equal(sc.routes[0]?.consumers[0]?.status, "MISMATCH");
    assert.deepEqual(sc.routes[0]?.consumers[0]?.missing, ["ghost"]);
  });
});

test("shape_check returns PARTIAL when no ACCESSES from consumer file", async () => {
  const routeId = "Route:r";
  const consumerSymbol = "Function:c";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/x",
        method: "GET",
        responseKeys: ["id"],
      },
    ],
    nodes: [{ id: consumerSymbol, kind: "Function", name: "fn", filePath: "c.ts" }],
    relations: [{ fromId: consumerSymbol, toId: routeId, type: "FETCHES" }],
  };
  await withHarness(data, async (ctx, server) => {
    registerShapeCheckTool(server, ctx);
    const handler = getHandler(server, "shape_check");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ consumers: Array<{ status: string }> }>;
    };
    assert.equal(sc.routes[0]?.consumers[0]?.status, "PARTIAL");
  });
});
