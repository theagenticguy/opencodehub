// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * `list_dead_code` MCP tool tests.
 *
 * Drives the handler end-to-end against a fake in-memory store so we exercise
 * the actual call into {@link classifyDeadness}. The fake dispatcher mirrors
 * the SQL the dead-code phase issues; anything else throws loudly.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CodeRelation,
  GraphNode,
  KnowledgeGraph,
  NodeKind,
  RelationType,
} from "@opencodehub/core-types";
import type {
  BulkLoadStats,
  DuckDbStore,
  EmbeddingRow,
  ListEdgesByTypeOptions,
  ListEdgesOptions,
  ListNodesOptions,
  SearchQuery,
  SearchResult,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { ConnectionPool } from "../connection-pool.js";
import { registerListDeadCodeTool } from "./list-dead-code.js";
import type { ToolContext } from "./shared.js";

/**
 * Wrap an in-memory IGraphStore-shaped fake as the composed `Store`
 * (`OpenStoreResult`) that the connection pool returns. The same
 * instance backs both `graph` and `temporal` because DuckDbStore
 * implements both interfaces over a single connection in production.
 */
function wrapAsStore(fake: unknown): import("@opencodehub/storage").Store {
  return {
    backend: "duck" as const,
    graph: fake as import("@opencodehub/storage").IGraphStore,
    temporal: fake as import("@opencodehub/storage").ITemporalStore,
    graphFile: "/in-memory/graph.duckdb",
    temporalFile: "/in-memory/graph.duckdb",
    close: async () => {
      const closer = (fake as { close?: () => Promise<void> }).close;
      if (typeof closer === "function") await closer.call(fake);
    },
  };
}

interface FakeNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly isExported: boolean;
}

interface FakeEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
}

/**
 * In-memory fake of the typed-finder surface `classifyDeadness` consumes:
 * `listNodes`, `listEdges`, `listEdgesByType`. The fake mirrors the same
 * filtering semantics directly against the seeded `nodes` / `edges`
 * arrays.
 */
function makeFakeStore(nodes: readonly FakeNode[], edges: readonly FakeEdge[]): DuckDbStore {
  const nodeAsGraphNode = (n: FakeNode): GraphNode => n as unknown as GraphNode;
  const edgeAsRelation = (e: FakeEdge): CodeRelation =>
    ({
      id: `${e.fromId}->${e.type}->${e.toId}`,
      from: e.fromId,
      to: e.toId,
      type: e.type as RelationType,
      confidence: 1,
    }) as unknown as CodeRelation;

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
    listNodes: async (opts: ListNodesOptions = {}): Promise<readonly GraphNode[]> => {
      const kinds = opts.kinds;
      if (kinds !== undefined && kinds.length === 0) return [];
      const idsRaw = opts.ids;
      if (idsRaw !== undefined && idsRaw.length === 0) return [];
      const kindSet = kinds !== undefined ? new Set<string>(kinds) : undefined;
      const idSet = idsRaw !== undefined ? new Set(idsRaw) : undefined;
      return nodes
        .filter((n) => {
          if (kindSet !== undefined && !kindSet.has(n.kind)) return false;
          if (idSet !== undefined && !idSet.has(n.id)) return false;
          return true;
        })
        .map(nodeAsGraphNode);
    },
    listEdges: async (opts: ListEdgesOptions = {}): Promise<readonly CodeRelation[]> => {
      const types = opts.types !== undefined ? new Set<string>(opts.types) : undefined;
      const fromIds = opts.fromIds !== undefined ? new Set(opts.fromIds) : undefined;
      const toIds = opts.toIds !== undefined ? new Set(opts.toIds) : undefined;
      return edges
        .filter((e) => {
          if (types !== undefined && !types.has(e.type)) return false;
          if (fromIds !== undefined && !fromIds.has(e.fromId)) return false;
          if (toIds !== undefined && !toIds.has(e.toId)) return false;
          return true;
        })
        .map(edgeAsRelation);
    },
    listEdgesByType: async (
      type: RelationType,
      opts: ListEdgesByTypeOptions = {},
    ): Promise<readonly CodeRelation[]> => {
      const fromIds = opts.fromIds !== undefined ? new Set(opts.fromIds) : undefined;
      const toIds = opts.toIds !== undefined ? new Set(opts.toIds) : undefined;
      return edges
        .filter((e) => {
          if (e.type !== type) return false;
          if (fromIds !== undefined && !fromIds.has(e.fromId)) return false;
          if (toIds !== undefined && !toIds.has(e.toId)) return false;
          return true;
        })
        .map(edgeAsRelation);
    },
    listNodesByKind: async (kind: NodeKind): Promise<readonly GraphNode[]> => {
      return nodes.filter((n) => n.kind === kind).map(nodeAsGraphNode);
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
  nodes: FakeNode[],
  edges: FakeEdge[],
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-list-dead-"));
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
          nodeCount: nodes.length,
          edgeCount: edges.length,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () =>
      wrapAsStore(makeFakeStore(nodes, edges)),
    );
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

function getHandler(server: McpServer, name: string): RegisteredTool["handler"] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

test("list_dead_code reports dead symbols and summary counts", async () => {
  const nodes: FakeNode[] = [
    // Dead: non-exported, no referrers.
    {
      id: "Function:src/a.ts:lonely",
      name: "lonely",
      kind: "Function",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 3,
      isExported: false,
    },
    // Unreachable export: exported, no cross-module referrer.
    {
      id: "Function:src/b.ts:exportedAlone",
      name: "exportedAlone",
      kind: "Function",
      filePath: "src/b.ts",
      startLine: 10,
      endLine: 12,
      isExported: true,
    },
    // Live: exported, has cross-module caller.
    {
      id: "Function:src/c.ts:helper",
      name: "helper",
      kind: "Function",
      filePath: "src/c.ts",
      startLine: 1,
      endLine: 3,
      isExported: true,
    },
    {
      id: "Function:src/d.ts:caller",
      name: "caller",
      kind: "Function",
      filePath: "src/d.ts",
      startLine: 1,
      endLine: 5,
      isExported: true,
    },
  ];
  const edges: FakeEdge[] = [
    { fromId: "Function:src/d.ts:caller", toId: "Function:src/c.ts:helper", type: "CALLS" },
  ];

  await withHarness(nodes, edges, async (ctx, server) => {
    registerListDeadCodeTool(server, ctx);
    const handler = getHandler(server, "list_dead_code");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      summary: { dead: number; unreachableExports: number; ghostCommunities: number };
      symbols: Array<{ id: string; deadness: string }>;
      ghostCommunities: string[];
    };
    assert.equal(sc.summary.dead, 1);
    // `caller` is exported but nothing references d.ts — also unreachable-export.
    assert.equal(sc.summary.unreachableExports, 2);
    // By default we only include the `dead` bucket.
    assert.equal(sc.symbols.length, 1);
    assert.equal(sc.symbols[0]?.id, "Function:src/a.ts:lonely");
    assert.equal(sc.symbols[0]?.deadness, "dead");
  });
});

test("list_dead_code filters by file-path pattern and honors the limit", async () => {
  const nodes: FakeNode[] = [
    {
      id: "Function:pkg/keep.ts:kept",
      name: "kept",
      kind: "Function",
      filePath: "pkg/keep.ts",
      startLine: 1,
      endLine: 2,
      isExported: false,
    },
    {
      id: "Function:pkg/drop.ts:dropA",
      name: "dropA",
      kind: "Function",
      filePath: "pkg/drop.ts",
      startLine: 1,
      endLine: 2,
      isExported: false,
    },
    {
      id: "Function:pkg/drop.ts:dropB",
      name: "dropB",
      kind: "Function",
      filePath: "pkg/drop.ts",
      startLine: 3,
      endLine: 4,
      isExported: false,
    },
  ];

  await withHarness(nodes, [], async (ctx, server) => {
    registerListDeadCodeTool(server, ctx);
    const handler = getHandler(server, "list_dead_code");
    const withFilter = await handler({ repo: "fakerepo", filePathPattern: "keep" }, {});
    const filtered = withFilter.structuredContent as {
      summary: { dead: number };
      symbols: Array<{ filePath: string }>;
    };
    // Summary stays at the underlying graph count (3 dead), but the returned
    // symbol list only contains the filtered match.
    assert.equal(filtered.summary.dead, 3);
    assert.equal(filtered.symbols.length, 1);
    assert.equal(filtered.symbols[0]?.filePath, "pkg/keep.ts");

    // Limit truncation.
    const limited = await handler({ repo: "fakerepo", limit: 2 }, {});
    const lim = limited.structuredContent as {
      symbols: unknown[];
    };
    assert.equal(lim.symbols.length, 2);
  });
});
