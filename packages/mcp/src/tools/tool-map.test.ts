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
import type { ToolContext } from "./shared.js";
import { registerToolMapTool } from "./tool-map.js";

interface ToolFx {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly description: string;
  readonly propertiesBag: string | null;
}

function makeFakeStore(tools: readonly ToolFx[]): DuckDbStore {
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
      if (text.includes("kind = 'Tool'")) {
        let out = [...tools];
        let pi = 0;
        if (text.includes("name LIKE ?")) {
          const v = String(params[pi++] ?? "").replace(/%/g, "");
          out = out.filter((t) => t.name.includes(v));
        }
        return out.map((t) => ({
          id: t.id,
          name: t.name,
          file_path: t.filePath,
          description: t.description,
          properties_bag: t.propertiesBag,
        }));
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
  tools: readonly ToolFx[],
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-tool-map-"));
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
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore(tools));
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

test("tool_map returns every Tool by default and parses inputSchema JSON", async () => {
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const tools: readonly ToolFx[] = [
    {
      id: "Tool:a.ts:hello",
      name: "hello",
      filePath: "a.ts",
      description: "Say hello",
      propertiesBag: JSON.stringify({ inputSchemaJson: JSON.stringify(schema) }),
    },
    {
      id: "Tool:b.ts:raw",
      name: "raw",
      filePath: "b.ts",
      description: "",
      propertiesBag: null,
    },
  ];
  await withHarness(tools, async (ctx, server) => {
    registerToolMapTool(server, ctx);
    const handler = getHandler(server, "tool_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      tools: Array<{
        name: string;
        filePath: string;
        description: string;
        inputSchema: unknown | null;
      }>;
      total: number;
    };
    assert.equal(sc.total, 2);
    const hello = sc.tools.find((t) => t.name === "hello");
    assert.ok(hello);
    assert.deepEqual(hello?.inputSchema, schema);
    const raw = sc.tools.find((t) => t.name === "raw");
    assert.equal(raw?.inputSchema, null);
  });
});

test("tool_map filters by name substring", async () => {
  const tools: readonly ToolFx[] = [
    {
      id: "Tool:a.ts:alpha",
      name: "alpha",
      filePath: "a.ts",
      description: "",
      propertiesBag: null,
    },
    {
      id: "Tool:b.ts:beta",
      name: "beta",
      filePath: "b.ts",
      description: "",
      propertiesBag: null,
    },
  ];
  await withHarness(tools, async (ctx, server) => {
    registerToolMapTool(server, ctx);
    const handler = getHandler(server, "tool_map");
    const result = await handler({ repo: "fakerepo", tool: "alph" }, {});
    const sc = result.structuredContent as {
      tools: Array<{ name: string }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.tools[0]?.name, "alpha");
  });
});

test("tool_map falls back to raw string when inputSchemaJson is unparseable", async () => {
  const tools: readonly ToolFx[] = [
    {
      id: "Tool:x:t",
      name: "t",
      filePath: "x.ts",
      description: "",
      propertiesBag: JSON.stringify({ inputSchemaJson: "not valid json" }),
    },
  ];
  await withHarness(tools, async (ctx, server) => {
    registerToolMapTool(server, ctx);
    const handler = getHandler(server, "tool_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      tools: Array<{ inputSchema: unknown }>;
    };
    assert.equal(sc.tools[0]?.inputSchema, "not valid json");
  });
});
