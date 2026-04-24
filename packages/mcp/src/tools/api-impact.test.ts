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
import { registerApiImpactTool } from "./api-impact.js";
import type { ToolContext } from "./shared.js";

interface RouteFx {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly filePath: string;
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

      if (
        text.startsWith("SELECT id, method, url, file_path, response_keys FROM nodes") &&
        text.includes("kind = 'Route'")
      ) {
        let out = [...data.routes];
        let pi = 0;
        if (text.includes("url LIKE ?")) {
          const v = String(params[pi++] ?? "").replace(/%/g, "");
          out = out.filter((r) => r.url.includes(v));
        }
        if (text.includes("file_path LIKE ?")) {
          const v = String(params[pi++] ?? "").replace(/%/g, "");
          out = out.filter((r) => r.filePath.includes(v));
        }
        return out.map((r) => ({
          id: r.id,
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

      if (text.startsWith("SELECT DISTINCT file_path FROM nodes WHERE id IN")) {
        const ids = new Set(params as string[]);
        const files = new Set<string>();
        for (const n of data.nodes) {
          if (ids.has(n.id) && n.filePath.length > 0) files.add(n.filePath);
        }
        return [...files].sort().map((f) => ({ file_path: f }));
      }

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

      if (text.includes("r.type = 'PROCESS_STEP'") && text.includes("r.to_id IN")) {
        const consumers = new Set(params as string[]);
        const processIds = new Set<string>();
        for (const r of data.relations) {
          if (r.type !== "PROCESS_STEP") continue;
          if (!consumers.has(r.toId)) continue;
          const p = data.nodes.find((n) => n.id === r.fromId);
          if (p && p.kind === "Process") processIds.add(p.id);
        }
        return [...processIds].sort().map((id) => ({ id }));
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
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-api-impact-"));
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

test("api_impact scores LOW for route with zero consumers", async () => {
  const data: Fixture = {
    routes: [
      {
        id: "Route:r",
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: [],
    relations: [],
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
        consumers: string[];
        mismatches: string[];
      }>;
    };
    assert.equal(sc.routes[0]?.risk, "LOW");
    assert.equal(sc.routes[0]?.consumers.length, 0);
  });
});

test("api_impact scores MEDIUM for 1-4 consumers with no mismatch", async () => {
  const routeId = "Route:r";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: [
      { id: "Function:c1", kind: "Function", name: "c1", filePath: "c1.ts" },
      { id: "Function:c2", kind: "Function", name: "c2", filePath: "c2.ts" },
      { id: "Property:id", kind: "Property", name: "id", filePath: "c1.ts" },
    ],
    relations: [
      { fromId: "Function:c1", toId: routeId, type: "FETCHES" },
      { fromId: "Function:c2", toId: routeId, type: "FETCHES" },
      { fromId: "Function:c1", toId: "Property:id", type: "ACCESSES" },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        risk: string;
        consumers: string[];
        mismatches: string[];
      }>;
    };
    assert.equal(sc.routes[0]?.risk, "MEDIUM");
    assert.equal(sc.routes[0]?.consumers.length, 2);
    assert.equal(sc.routes[0]?.mismatches.length, 0);
  });
});

test("api_impact scores HIGH when there is any mismatch", async () => {
  const routeId = "Route:r";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: [
      { id: "Function:c1", kind: "Function", name: "c1", filePath: "c1.ts" },
      { id: "Property:ghost", kind: "Property", name: "ghost", filePath: "c1.ts" },
    ],
    relations: [
      { fromId: "Function:c1", toId: routeId, type: "FETCHES" },
      { fromId: "Function:c1", toId: "Property:ghost", type: "ACCESSES" },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ risk: string; mismatches: string[] }>;
    };
    assert.equal(sc.routes[0]?.risk, "HIGH");
    assert.equal(sc.routes[0]?.mismatches.length, 1);
  });
});

test("api_impact scores CRITICAL at 20+ consumers", async () => {
  const routeId = "Route:r";
  const consumers = Array.from({ length: 22 }, (_, i) => ({
    id: `Function:c${i}`,
    kind: "Function",
    name: `c${i}`,
    filePath: `f${i}.ts`,
  }));
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: consumers,
    relations: consumers.map((c) => ({
      fromId: c.id,
      toId: routeId,
      type: "FETCHES",
    })),
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ risk: string; consumers: string[] }>;
    };
    assert.equal(sc.routes[0]?.risk, "CRITICAL");
    assert.equal(sc.routes[0]?.consumers.length, 22);
  });
});
