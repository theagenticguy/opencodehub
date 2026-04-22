// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `query` MCP tool auto-detection of hybrid search.
 *
 * The surface we exercise:
 *   1. Zero rows in `embeddings` → BM25-only, embedder factory never invoked.
 *   2. Populated `embeddings` + embedder opens cleanly → hybrid path runs
 *      `vectorSearch` and fuses results; `mode: "hybrid"` surfaced; embedder
 *      is closed after use.
 *   3. Populated `embeddings` + embedder fails to open (EMBEDDER_NOT_SETUP
 *      or native load error) → warn to stderr, BM25 fallback served; no
 *      error envelope.
 *   4. RRF ties resolved deterministically — same inputs produce the same
 *      order across repeat runs.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { KnowledgeGraph } from "@opencodehub/core-types";
import type { Embedder } from "@opencodehub/embedder";
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
import { registerQueryTool } from "./query.js";
import type { EmbedderFactory, ToolContext } from "./shared.js";

interface FakeStoreOptions {
  /**
   * Mutable count of rows in the `embeddings` table — if 0, the query tool
   * takes the BM25 path; if > 0, it tries to open an embedder.
   */
  readonly embeddingRows: number;
  /** Rows the fake's `search()` returns (BM25 run). */
  readonly searchRows: SearchResult[];
  /** Rows the fake's `vectorSearch()` returns (HNSW run). */
  readonly vectorRows: VectorResult[];
  /**
   * Node rows used to hydrate fused ids back into name/kind/filePath,
   * keyed by id.
   */
  readonly nodes: ReadonlyMap<string, { name: string; kind: string; filePath: string }>;
}

interface FakeStoreHandle {
  store: DuckDbStore;
  vectorCalls: number;
  searchCalls: number;
}

function makeFakeStore(opts: FakeStoreOptions): FakeStoreHandle {
  const handle: FakeStoreHandle = {
    store: {} as DuckDbStore,
    vectorCalls: 0,
    searchCalls: 0,
  };
  const impl = {
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
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "SELECT COUNT(*) AS n FROM embeddings") {
        return [{ n: opts.embeddingRows }];
      }
      if (normalized.startsWith("SELECT id, name, file_path, kind FROM nodes WHERE id IN")) {
        const idSet = new Set(params.map((p) => String(p)));
        const out: Record<string, unknown>[] = [];
        for (const id of idSet) {
          const meta = opts.nodes.get(id);
          if (meta) {
            out.push({
              id,
              name: meta.name,
              file_path: meta.filePath,
              kind: meta.kind,
            });
          }
        }
        return out;
      }
      throw new Error(`unsupported sql in fake store: ${normalized}`);
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => {
      handle.searchCalls += 1;
      return opts.searchRows;
    },
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => {
      handle.vectorCalls += 1;
      return opts.vectorRows;
    },
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
  } as unknown as DuckDbStore;
  handle.store = impl;
  return handle;
}

class FakeEmbedder implements Embedder {
  readonly dim = 4;
  readonly modelId = "fake-embedder/test";
  closeCount = 0;
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array([0.1, 0.2, 0.3, 0.4]);
  }
  async embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

interface HarnessContext {
  readonly ctx: ToolContext;
  readonly server: McpServer;
  readonly handle: FakeStoreHandle;
}

async function withHarness(
  opts: FakeStoreOptions,
  openEmbedder: EmbedderFactory | undefined,
  fn: (h: HarnessContext) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-query-test-"));
  const handle = makeFakeStore(opts);
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
          nodeCount: opts.nodes.size,
          edgeCount: 0,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => handle.store);
    const ctx: ToolContext =
      openEmbedder === undefined ? { pool, home } : { pool, home, openEmbedder };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    try {
      await fn({ ctx, server, handle });
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
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

const NODES_FOO_BAR: ReadonlyMap<string, { name: string; kind: string; filePath: string }> =
  new Map([
    ["F:foo", { name: "foo", kind: "Function", filePath: "src/foo.ts" }],
    ["F:bar", { name: "bar", kind: "Function", filePath: "src/bar.ts" }],
    ["F:baz", { name: "baz", kind: "Function", filePath: "src/baz.ts" }],
  ]);

test("query: 0 embeddings → BM25 only, embedder factory never invoked, mode=bm25", async () => {
  let openerCalled = false;
  const opener: EmbedderFactory = async () => {
    openerCalled = true;
    throw new Error("opener must not be called on the BM25 path");
  };
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
    },
    opener,
    async ({ ctx, server, handle }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ name: string; sources?: string[] }>;
        mode: "bm25" | "hybrid";
      };
      assert.equal(openerCalled, false, "opener must not be called when embeddings=0");
      assert.equal(handle.vectorCalls, 0, "vectorSearch must not be called");
      assert.equal(sc.mode, "bm25");
      assert.equal(sc.results.length, 1);
      assert.deepEqual(sc.results[0]?.sources, ["bm25"]);
    },
  );
});

test("query: populated embeddings + embedder ok → hybrid path runs, mode=hybrid", async () => {
  const fake = new FakeEmbedder();
  const opener: EmbedderFactory = async () => fake;
  await withHarness(
    {
      embeddingRows: 10,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
        { nodeId: "F:bar", score: 1, filePath: "src/bar.ts", name: "bar", kind: "Function" },
      ],
      vectorRows: [
        { nodeId: "F:bar", distance: 0.1 },
        { nodeId: "F:baz", distance: 0.2 },
      ],
      nodes: NODES_FOO_BAR,
    },
    opener,
    async ({ ctx, server, handle }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ nodeId: string; name: string; sources?: string[] }>;
        mode: "bm25" | "hybrid";
      };
      assert.equal(sc.mode, "hybrid");
      assert.equal(handle.vectorCalls, 1, "vectorSearch must run exactly once");
      assert.equal(fake.closeCount, 1, "embedder.close() must be called after use");
      // Fused output contains foo, bar, baz.
      const ids = sc.results.map((r) => r.nodeId).sort();
      assert.deepEqual(ids, ["F:bar", "F:baz", "F:foo"]);
      // bar appears in both runs, so its sources must carry both tags.
      const bar = sc.results.find((r) => r.nodeId === "F:bar");
      assert.ok(bar !== undefined);
      assert.deepEqual([...(bar.sources ?? [])].sort(), ["bm25", "vector"]);
    },
  );
});

test("query: populated embeddings + EMBEDDER_NOT_SETUP → warn + BM25 fallback", async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const opener: EmbedderFactory = async () => {
      const err = new Error("Arctic Embed XS weights not found. Run `codehub setup --embeddings`.");
      // Shape matches EmbedderNotSetupError.code.
      (err as unknown as { code: string }).code = "EMBEDDER_NOT_SETUP";
      throw err;
    };
    await withHarness(
      {
        embeddingRows: 5,
        searchRows: [
          { nodeId: "F:foo", score: 3, filePath: "src/foo.ts", name: "foo", kind: "Function" },
        ],
        vectorRows: [
          // vector rows are set but must not be consumed because the embedder
          // fails to open — if the fallback leaked to vectorSearch we'd see
          // the call count rise in `handle.vectorCalls`.
          { nodeId: "F:bar", distance: 0.1 },
        ],
        nodes: NODES_FOO_BAR,
      },
      opener,
      async ({ ctx, server, handle }) => {
        registerQueryTool(server, ctx);
        const handler = getHandler(server, "query");
        const result = await handler({ query: "foo", repo: "fakerepo" }, {});
        const sc = result.structuredContent as {
          results: Array<{ name: string; sources?: string[] }>;
          mode: "bm25" | "hybrid";
          error?: unknown;
        };
        assert.equal(result.isError, undefined, "fallback must not raise an error envelope");
        assert.equal(sc.error, undefined);
        assert.equal(sc.mode, "bm25", "fallback must report BM25 mode");
        assert.equal(handle.vectorCalls, 0, "vectorSearch must not be called on fallback");
        assert.equal(sc.results.length, 1);
        assert.deepEqual(sc.results[0]?.sources, ["bm25"]);
        assert.ok(
          warnings.some((w) => w.includes("hybrid search unavailable")),
          "a warning must be emitted when the embedder fails to open",
        );
      },
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("query: RRF ties are resolved deterministically across repeat runs", async () => {
  // Both runs produce candidates at rank 1 and 2 with no shared ids; the
  // fused order depends on first-run / first-rank / lexical tie-breaking.
  // Running the handler twice must yield byte-identical result ordering.
  const nodes: ReadonlyMap<string, { name: string; kind: string; filePath: string }> = new Map([
    ["F:a", { name: "a", kind: "Function", filePath: "src/a.ts" }],
    ["F:b", { name: "b", kind: "Function", filePath: "src/b.ts" }],
    ["F:c", { name: "c", kind: "Function", filePath: "src/c.ts" }],
    ["F:d", { name: "d", kind: "Function", filePath: "src/d.ts" }],
  ]);
  const run = async (): Promise<string[]> => {
    let nodeIds: string[] = [];
    await withHarness(
      {
        embeddingRows: 10,
        searchRows: [
          { nodeId: "F:a", score: 1, filePath: "src/a.ts", name: "a", kind: "Function" },
          { nodeId: "F:b", score: 1, filePath: "src/b.ts", name: "b", kind: "Function" },
        ],
        vectorRows: [
          { nodeId: "F:c", distance: 0.1 },
          { nodeId: "F:d", distance: 0.2 },
        ],
        nodes,
      },
      async () => new FakeEmbedder(),
      async ({ ctx, server }) => {
        registerQueryTool(server, ctx);
        const handler = getHandler(server, "query");
        const result = await handler({ query: "x", repo: "fakerepo" }, {});
        const sc = result.structuredContent as {
          results: Array<{ nodeId: string }>;
        };
        nodeIds = sc.results.map((r) => r.nodeId);
      },
    );
    return nodeIds;
  };
  const first = await run();
  const second = await run();
  assert.deepEqual(second, first, "repeat runs must produce identical ordering");
  // BM25 run came first: F:a should outrank F:c at rank 1 because RRF
  // awards first-run priority when scores tie.
  assert.equal(first[0], "F:a");
});
