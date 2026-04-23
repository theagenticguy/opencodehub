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
import { registerListDeadCodeTool } from "./list-dead-code.js";
import type { ToolContext } from "./shared.js";

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

function makeFakeStore(nodes: FakeNode[], edges: FakeEdge[]): DuckDbStore {
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
      // Dead-code: fetch classifiable symbols.
      if (
        /^SELECT id, name, kind, file_path, start_line, is_exported FROM nodes WHERE kind IN/i.test(
          text,
        )
      ) {
        const kinds = new Set(params.map((p) => String(p)));
        return nodes
          .filter((n) => kinds.has(n.kind))
          .map((n) => ({
            id: n.id,
            name: n.name,
            kind: n.kind,
            file_path: n.filePath,
            start_line: n.startLine,
            is_exported: n.isExported,
          }));
      }
      // Dead-code: inbound referrers.
      if (
        /^SELECT r\.to_id AS target_id, n\.file_path AS source_file FROM relations r JOIN nodes n ON n\.id = r\.from_id WHERE r\.to_id IN/i.test(
          text,
        )
      ) {
        const inMatches = [...text.matchAll(/IN \(([?,\s]+)\)/g)];
        const targetCount = (inMatches[0]?.[1] ?? "").split(",").length;
        const targetIds = new Set(params.slice(0, targetCount).map((p) => String(p)));
        const types = new Set(params.slice(targetCount).map((p) => String(p)));
        const fileById = new Map(nodes.map((n) => [n.id, n.filePath]));
        const out: Record<string, unknown>[] = [];
        for (const e of edges) {
          if (!targetIds.has(e.toId)) continue;
          if (!types.has(e.type)) continue;
          out.push({ target_id: e.toId, source_file: fileById.get(e.fromId) ?? "" });
        }
        return out;
      }
      // Dead-code: MEMBER_OF community membership.
      if (
        /^SELECT from_id AS symbol_id, to_id AS community_id FROM relations WHERE type = 'MEMBER_OF' AND from_id IN/i.test(
          text,
        )
      ) {
        const ids = new Set(params.map((p) => String(p)));
        const out: Record<string, unknown>[] = [];
        for (const e of edges) {
          if (e.type !== "MEMBER_OF") continue;
          if (!ids.has(e.fromId)) continue;
          out.push({ symbol_id: e.fromId, community_id: e.toId });
        }
        return out;
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
      makeFakeStore(nodes, edges),
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
