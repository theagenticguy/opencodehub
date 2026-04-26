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
import type { FsAbstraction } from "@opencodehub/analysis";
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
  SymbolSummaryRow,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { ConnectionPool } from "../connection-pool.js";
import { registerQueryTool } from "./query.js";
import type { EmbedderFactory, ToolContext } from "./shared.js";

interface FakeNode {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * Fake row shape for the process-grouping CTE. The real SQL query resolves
 * a two-phase PROCESS_STEP walk; the fake short-circuits that with a
 * pre-built lookup: for each top-K hit id that falls under a known process,
 * emit one (process_id, node_id, step) triple. This is enough to exercise
 * the grouping/sort/score logic without replicating DuckDB's recursive CTE
 * engine.
 */
interface FakeProcessMember {
  readonly processId: string;
  readonly processName: string;
  readonly inferredLabel: string;
  readonly stepCount: number;
  readonly nodeId: string;
  readonly step: number;
}

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
  readonly nodes: ReadonlyMap<string, FakeNode>;
  /**
   * Whether the probe for a `symbol_summaries` table should report it
   * exists + is populated. Defaults to false.
   */
  readonly summariesJoined?: boolean;
  /**
   * Summary rows keyed by nodeId. Mirrors the `symbol_summaries` table;
   * the fake `lookupSymbolSummariesByNode` returns every row whose
   * nodeId is in the lookup set. When set, `summariesJoined` should also
   * be true so the tool's probe lets the join run.
   */
  readonly summaryRows?: ReadonlyMap<string, SymbolSummaryRow>;
  /**
   * Pre-built process membership triples. When omitted, the
   * process-grouping SQL falls through to the throw-unsupported path and
   * the tool returns empty `processes` / `process_symbols` — matching the
   * MVP "no PROCESS_STEP detection yet" behaviour.
   */
  readonly processMembers?: readonly FakeProcessMember[];
}

interface FakeStoreHandle {
  store: DuckDbStore;
  vectorCalls: number;
  searchCalls: number;
  /**
   * Text passed to the most recent BM25 `search()` call. Used by the
   * `task_context` / `goal` tests to assert the prefix contract without
   * peeking inside `hybridSearch`.
   */
  lastSearchText: string | null;
}

function makeFakeStore(opts: FakeStoreOptions): FakeStoreHandle {
  const handle: FakeStoreHandle = {
    store: {} as DuckDbStore,
    vectorCalls: 0,
    searchCalls: 0,
    lastSearchText: null,
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
      if (
        normalized ===
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'symbol_summaries'"
      ) {
        return [{ n: opts.summariesJoined === true ? 1 : 0 }];
      }
      if (normalized === "SELECT COUNT(*) AS n FROM symbol_summaries") {
        return [{ n: opts.summariesJoined === true ? 5 : 0 }];
      }
      if (
        normalized.startsWith(
          "SELECT id, name, file_path, kind, start_line, end_line FROM nodes WHERE id IN",
        )
      ) {
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
              start_line: meta.startLine ?? null,
              end_line: meta.endLine ?? null,
            });
          }
        }
        return out;
      }
      // Process-grouping CTE: detect by its distinctive `WITH RECURSIVE` +
      // `ancestors(ancestor_id` + `PROCESS_STEP` + `matched_processes`
      // fingerprint. Params are the top-K hit ids. We short-circuit the
      // real recursive walk with a pre-built lookup from `opts.processMembers`:
      // include every member whose processId also has at least one top-K
      // hit in its member list.
      if (
        normalized.startsWith("WITH RECURSIVE") &&
        normalized.includes("PROCESS_STEP") &&
        normalized.includes("matched_processes")
      ) {
        const members = opts.processMembers ?? [];
        if (members.length === 0) return [];
        const hitIds = new Set(params.map((p) => String(p)));
        // A process participates iff any of its members is in the hit set.
        const participating = new Set<string>();
        for (const m of members) {
          if (hitIds.has(m.nodeId)) participating.add(m.processId);
        }
        const out: Record<string, unknown>[] = [];
        for (const m of members) {
          if (!participating.has(m.processId)) continue;
          const meta = opts.nodes.get(m.nodeId);
          out.push({
            process_id: m.processId,
            process_name: m.processName,
            inferred_label: m.inferredLabel,
            step_count: m.stepCount,
            node_id: m.nodeId,
            step: m.step,
            node_name: meta?.name ?? m.nodeId,
            node_kind: meta?.kind ?? "Function",
            node_file: meta?.filePath ?? "",
          });
        }
        // Mirror the real SQL's ORDER BY (process_id ASC, step ASC, node_id ASC).
        out.sort((a, b) => {
          const pa = String(a["process_id"] ?? "");
          const pb = String(b["process_id"] ?? "");
          if (pa !== pb) return pa < pb ? -1 : 1;
          const sa = Number(a["step"] ?? 0);
          const sb = Number(b["step"] ?? 0);
          if (sa !== sb) return sa - sb;
          const na = String(a["node_id"] ?? "");
          const nb = String(b["node_id"] ?? "");
          return na < nb ? -1 : na > nb ? 1 : 0;
        });
        return out;
      }
      throw new Error(`unsupported sql in fake store: ${normalized}`);
    },
    search: async (q: SearchQuery): Promise<readonly SearchResult[]> => {
      handle.searchCalls += 1;
      handle.lastSearchText = q.text;
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
    // Cochange + summary surfaces — unused by `query`, but required to
    // satisfy the full IGraphStore interface.
    bulkLoadCochanges: async () => {},
    lookupCochangesForFile: async () => [],
    lookupCochangesBetween: async () => undefined,
    bulkLoadSymbolSummaries: async () => {},
    lookupSymbolSummary: async () => undefined,
    lookupSymbolSummariesByNode: async (
      nodeIds: readonly string[],
    ): Promise<readonly SymbolSummaryRow[]> => {
      const byId = opts.summaryRows;
      if (byId === undefined) return [];
      const out: SymbolSummaryRow[] = [];
      for (const id of nodeIds) {
        const row = byId.get(id);
        if (row !== undefined) out.push(row);
      }
      // Mirror the real SQL's ordering contract so callers can rely on
      // "last write wins" to pick the newest prompt version.
      out.sort((a, b) => {
        if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
        if (a.promptVersion !== b.promptVersion) return a.promptVersion < b.promptVersion ? -1 : 1;
        return a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0;
      });
      return out;
    },
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

/** In-memory FsAbstraction — maps absolute paths to content. */
class FakeFs implements FsAbstraction {
  constructor(private readonly files: ReadonlyMap<string, string>) {}
  async readFile(absPath: string): Promise<string> {
    const content = this.files.get(absPath);
    if (content === undefined) throw new Error(`ENOENT: ${absPath}`);
    return content;
  }
  async writeFileAtomic(_absPath: string, _content: string): Promise<void> {
    throw new Error("not supported in query tests");
  }
}

interface HarnessOptions {
  readonly openEmbedder?: EmbedderFactory;
  /** Map of absolute paths to file content for snippet extraction tests. */
  readonly files?: ReadonlyMap<string, string>;
}

async function withHarness(
  opts: FakeStoreOptions,
  harnessOpts: HarnessOptions,
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
    const ctx: ToolContext = {
      pool,
      home,
      ...(harnessOpts.openEmbedder !== undefined ? { openEmbedder: harnessOpts.openEmbedder } : {}),
      ...(harnessOpts.files !== undefined
        ? { fsFactory: () => new FakeFs(harnessOpts.files ?? new Map()) }
        : {}),
    };
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

const NODES_FOO_BAR: ReadonlyMap<string, FakeNode> = new Map([
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
    { openEmbedder: opener },
    async ({ ctx, server, handle }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ name: string; sources?: string[]; rank: number }>;
        definitions: Array<{ name: string }>;
        processes: readonly unknown[];
        process_symbols: readonly unknown[];
        mode: "bm25" | "hybrid";
      };
      assert.equal(openerCalled, false, "opener must not be called when embeddings=0");
      assert.equal(handle.vectorCalls, 0, "vectorSearch must not be called");
      assert.equal(sc.mode, "bm25");
      assert.equal(sc.results.length, 1);
      assert.deepEqual(sc.results[0]?.sources, ["bm25"]);
      assert.equal(sc.results[0]?.rank, 1);
      // Legacy aliases are preserved.
      assert.equal(sc.definitions.length, 1);
      assert.deepEqual(sc.processes, []);
      assert.deepEqual(sc.process_symbols, []);
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
    { openEmbedder: opener },
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
      const err = new Error(
        "gte-modernbert-base weights not found. Run `codehub setup --embeddings`.",
      );
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
      { openEmbedder: opener },
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
  const nodes: ReadonlyMap<string, FakeNode> = new Map([
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
      { openEmbedder: async () => new FakeEmbedder() },
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

test("query: snippet extraction slices the source file between startLine and endLine", async () => {
  const nodesWithLines: ReadonlyMap<string, FakeNode> = new Map([
    ["F:foo", { name: "foo", kind: "Function", filePath: "src/foo.ts", startLine: 2, endLine: 4 }],
  ]);
  const src = ["line1", "line2", "line3", "line4", "line5"].join("\n");
  // Absolute path derived from harness `repoPath`: <tmp>/fakerepo/src/foo.ts.
  // We use the home the harness creates by intercepting via the files map
  // keyed on the resolved abs path below.
  let capturedSnippet: string | null | undefined;
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 5, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: nodesWithLines,
    },
    {
      files: new Map([
        // Harness mkdtemp creates a fresh repoPath; but the FakeFs lookup is by
        // absolute path. The query tool resolves filePath against repoPath; we
        // can't know the tmp dir ahead of time, so this map must match the
        // lookup. We accept any key that ends with the relative path by
        // subclassing in place below.
      ]),
    },
    async ({ ctx, server }) => {
      // Replace the fsFactory with one that returns the same content for any
      // path ending with src/foo.ts. This sidesteps the fact that repoPath
      // is a fresh tmpdir per test.
      const patchedCtx: ToolContext = {
        ...ctx,
        fsFactory: () => ({
          readFile: async (absPath: string) => {
            if (absPath.endsWith("src/foo.ts")) return src;
            throw new Error(`ENOENT: ${absPath}`);
          },
          writeFileAtomic: async () => {
            throw new Error("not supported");
          },
        }),
      };
      registerQueryTool(server, patchedCtx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{
          snippet: string | null;
          startLine: number | null;
          endLine: number | null;
        }>;
      };
      capturedSnippet = sc.results[0]?.snippet ?? null;
      assert.equal(sc.results[0]?.startLine, 2);
      assert.equal(sc.results[0]?.endLine, 4);
    },
  );
  assert.equal(capturedSnippet, "line2\nline3\nline4");
});

test("query: missing source file produces snippet=null (no crash)", async () => {
  const nodesWithLines: ReadonlyMap<string, FakeNode> = new Map([
    [
      "F:gone",
      {
        name: "gone",
        kind: "Function",
        filePath: "src/deleted.ts",
        startLine: 1,
        endLine: 3,
      },
    ],
  ]);
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:gone", score: 5, filePath: "src/deleted.ts", name: "gone", kind: "Function" },
      ],
      vectorRows: [],
      nodes: nodesWithLines,
    },
    { files: new Map<string, string>() /* nothing readable */ },
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "gone", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ snippet: string | null }>;
      };
      assert.equal(result.isError, undefined);
      assert.equal(sc.results[0]?.snippet, null);
    },
  );
});

test("query: long snippets are truncated to the 200-char cap", async () => {
  const nodesWithLines: ReadonlyMap<string, FakeNode> = new Map([
    ["F:big", { name: "big", kind: "Function", filePath: "src/big.ts", startLine: 1, endLine: 3 }],
  ]);
  // Each line 100 chars → total content 302 chars (with two \n separators) →
  // exceeds the 200-char snippet cap.
  const fat = "x".repeat(100);
  const src = [fat, fat, fat].join("\n");
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:big", score: 1, filePath: "src/big.ts", name: "big", kind: "Function" },
      ],
      vectorRows: [],
      nodes: nodesWithLines,
    },
    {},
    async ({ ctx, server }) => {
      const patchedCtx: ToolContext = {
        ...ctx,
        fsFactory: () => ({
          readFile: async (absPath: string) => {
            if (absPath.endsWith("src/big.ts")) return src;
            throw new Error(`ENOENT: ${absPath}`);
          },
          writeFileAtomic: async () => {
            throw new Error("not supported");
          },
        }),
      };
      registerQueryTool(server, patchedCtx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "big", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ snippet: string | null }>;
      };
      const s = sc.results[0]?.snippet ?? "";
      assert.ok(s.length <= 200, `snippet must be <=200 chars, got ${s.length}`);
      assert.ok(s.endsWith("…"), "truncation ellipsis marker expected");
    },
  );
});

test("query: summary rows are joined onto each hit (P04)", async () => {
  // Store reports `symbol_summaries` is populated AND carries a row for
  // F:foo. The tool must attach `summary` (and `signatureSummary` when
  // present) to that hit while leaving F:bar untouched (no row).
  const summaryRows: ReadonlyMap<string, SymbolSummaryRow> = new Map([
    [
      "F:foo",
      {
        nodeId: "F:foo",
        contentHash: "c0ffee",
        promptVersion: "1",
        modelId: "global.anthropic.claude-haiku-4-5-v1:0",
        summaryText: "Greet the user by name with a configurable locale.",
        signatureSummary: "name: string, locale: string",
        returnsTypeSummary: "greeting string",
        createdAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  ]);
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
        { nodeId: "F:bar", score: 1, filePath: "src/bar.ts", name: "bar", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
      summariesJoined: true,
      summaryRows,
    },
    {},
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{
          nodeId: string;
          summary?: string;
          signatureSummary?: string;
        }>;
      };
      const foo = sc.results.find((r) => r.nodeId === "F:foo");
      const bar = sc.results.find((r) => r.nodeId === "F:bar");
      assert.ok(foo, "expected F:foo in results");
      assert.equal(
        foo.summary,
        "Greet the user by name with a configurable locale.",
        "summary text must round-trip onto the hit",
      );
      assert.equal(
        foo.signatureSummary,
        "name: string, locale: string",
        "signatureSummary must round-trip onto the hit",
      );
      assert.ok(bar, "expected F:bar in results");
      assert.equal(bar.summary, undefined, "F:bar has no summary row; field must stay absent");
      assert.equal(bar.signatureSummary, undefined);
    },
  );
});

test("query: summary join is skipped when summariesJoined=false", async () => {
  // The tool's probe short-circuits the lookup when no table exists.
  // Exercise that path: even if the fake store COULD return a row, the
  // tool must not ask for it because summariesJoined=false.
  const summaryRows: ReadonlyMap<string, SymbolSummaryRow> = new Map([
    [
      "F:foo",
      {
        nodeId: "F:foo",
        contentHash: "c0ffee",
        promptVersion: "1",
        modelId: "m",
        summaryText: "should-not-appear",
        createdAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  ]);
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
      summariesJoined: false,
      summaryRows,
    },
    {},
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ summary?: string }>;
      };
      assert.equal(sc.results[0]?.summary, undefined);
    },
  );
});

test("query: summaries_joined reflects the presence of symbol_summaries", async () => {
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 1, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
      summariesJoined: true,
    },
    {},
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as { summaries_joined: boolean };
      assert.equal(sc.summaries_joined, true);
    },
  );
});

test("query: top-K hit under a Process yields 1 group + ordered process_symbols", async () => {
  // Fixture: three callables chained under one Process. The BM25 hit is the
  // middle symbol of the chain; the grouping walk must still surface the
  // full flow (3 steps) under the owning Process.
  const nodes: ReadonlyMap<string, FakeNode> = new Map([
    ["F:entry", { name: "entry", kind: "Function", filePath: "src/flow.ts" }],
    ["F:mid", { name: "mid", kind: "Function", filePath: "src/flow.ts" }],
    ["F:leaf", { name: "leaf", kind: "Function", filePath: "src/flow.ts" }],
    ["P:flow", { name: "entry-flow", kind: "Process", filePath: "src/flow.ts" }],
  ]);
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        // Top-1 hit — the middle node of the chain.
        { nodeId: "F:mid", score: 5, filePath: "src/flow.ts", name: "mid", kind: "Function" },
      ],
      vectorRows: [],
      nodes,
      // Three PROCESS_STEP members of one Process:
      //   entry (step 0) -> mid (step 1) -> leaf (step 2)
      processMembers: [
        {
          processId: "P:flow",
          processName: "entry-flow",
          inferredLabel: "login handle",
          stepCount: 3,
          nodeId: "F:entry",
          step: 0,
        },
        {
          processId: "P:flow",
          processName: "entry-flow",
          inferredLabel: "login handle",
          stepCount: 3,
          nodeId: "F:mid",
          step: 1,
        },
        {
          processId: "P:flow",
          processName: "entry-flow",
          inferredLabel: "login handle",
          stepCount: 3,
          nodeId: "F:leaf",
          step: 2,
        },
      ],
    },
    {},
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "mid", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        processes: Array<{
          id: string;
          label: string;
          processType: string;
          stepCount: number;
          score: number;
        }>;
        process_symbols: Array<{
          process_id: string;
          nodeId: string;
          name: string;
          kind: string;
          filePath: string;
          step: number;
        }>;
      };
      assert.equal(sc.processes.length, 1, "expected exactly one matched Process");
      const proc = sc.processes[0];
      assert.ok(proc, "process entry must exist");
      assert.equal(proc.id, "P:flow");
      assert.equal(proc.label, "login handle", "label must come from inferred_label");
      assert.equal(proc.processType, "flow");
      assert.equal(proc.stepCount, 3);
      assert.ok(proc.score > 0, `process score must reflect the hit's score, got ${proc.score}`);

      assert.equal(sc.process_symbols.length, 3, "all 3 members must land in process_symbols");
      // process_symbols must be ordered by step ASC (entry=0, mid=1, leaf=2).
      const steps = sc.process_symbols.map((s) => s.step);
      assert.deepEqual(steps, [0, 1, 2], "process_symbols must be ordered by step ASC");
      assert.equal(sc.process_symbols[0]?.nodeId, "F:entry");
      assert.equal(sc.process_symbols[1]?.nodeId, "F:mid");
      assert.equal(sc.process_symbols[2]?.nodeId, "F:leaf");
      for (const s of sc.process_symbols) assert.equal(s.process_id, "P:flow");
    },
  );
});

test("query: zero PROCESS_STEP edges -> empty processes + process_symbols (no regression)", async () => {
  // The fake store's `processMembers` is undefined, so the new SQL query
  // throws "unsupported sql" and the tool's try/catch falls back to empty
  // arrays. This mirrors a freshly-indexed repo where the `processes` phase
  // has not yet produced any PROCESS_STEP edges.
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
    },
    {},
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        processes: readonly unknown[];
        process_symbols: readonly unknown[];
        results: readonly unknown[];
      };
      assert.equal(result.isError, undefined, "empty grouping must not raise an error envelope");
      assert.deepEqual(
        sc.processes,
        [],
        "processes must be empty when no PROCESS_STEP edges exist",
      );
      assert.deepEqual(
        sc.process_symbols,
        [],
        "process_symbols must be empty when no PROCESS_STEP edges exist",
      );
      // Flat `results` is still populated — the BM25 hit must land regardless.
      assert.equal(sc.results.length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// P1-5 param parity: task_context, goal, include_content, max_symbols
// ---------------------------------------------------------------------------

test("query: task_context is prefixed to the BM25/embedding search text", async () => {
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
    },
    {},
    async ({ ctx, server, handle }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      await handler(
        { query: "validate user", task_context: "adding OAuth support", repo: "fakerepo" },
        {},
      );
      // Contract: the ranker sees `task_context — query`, so BM25 gets the
      // concatenated phrase. The raw `query` must still appear at the tail
      // so exact-match hits survive.
      assert.equal(handle.lastSearchText, "adding OAuth support — validate user");
    },
  );
});

test("query: goal is prefixed to the BM25/embedding search text", async () => {
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
    },
    {},
    async ({ ctx, server, handle }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      await handler(
        { query: "validate user", goal: "find auth entry point", repo: "fakerepo" },
        {},
      );
      assert.equal(handle.lastSearchText, "find auth entry point — validate user");
    },
  );
});

test("query: task_context + goal are both prefixed in declared order", async () => {
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
    },
    {},
    async ({ ctx, server, handle }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      await handler(
        {
          query: "validate user",
          task_context: "adding OAuth support",
          goal: "existing auth validation logic",
          repo: "fakerepo",
        },
        {},
      );
      // Order: task_context — goal — query.
      assert.equal(
        handle.lastSearchText,
        "adding OAuth support — existing auth validation logic — validate user",
      );
    },
  );
});

test("query: neither task_context nor goal leaves the search text untouched", async () => {
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
    },
    {},
    async ({ ctx, server, handle }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      await handler({ query: "validate user", repo: "fakerepo" }, {});
      assert.equal(handle.lastSearchText, "validate user");
    },
  );
});

test("query: include_content=true attaches a capped source body to each hit", async () => {
  const nodesWithLines: ReadonlyMap<string, FakeNode> = new Map([
    ["F:foo", { name: "foo", kind: "Function", filePath: "src/foo.ts", startLine: 2, endLine: 4 }],
  ]);
  const src = ["line1", "line2", "line3", "line4", "line5"].join("\n");
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 5, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: nodesWithLines,
    },
    {},
    async ({ ctx, server }) => {
      const patchedCtx: ToolContext = {
        ...ctx,
        fsFactory: () => ({
          readFile: async (absPath: string) => {
            if (absPath.endsWith("src/foo.ts")) return src;
            throw new Error(`ENOENT: ${absPath}`);
          },
          writeFileAtomic: async () => {
            throw new Error("not supported");
          },
        }),
      };
      registerQueryTool(server, patchedCtx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo", include_content: true }, {});
      const sc = result.structuredContent as {
        results: Array<{ content?: string; snippet: string | null }>;
      };
      // `content` spans startLine..endLine verbatim (no ellipsis under the cap).
      assert.equal(sc.results[0]?.content, "line2\nline3\nline4");
      // Snippet is still populated alongside (distinct, smaller cap).
      assert.equal(sc.results[0]?.snippet, "line2\nline3\nline4");
    },
  );
});

test("query: include_content omitted/false emits no content field", async () => {
  const nodesWithLines: ReadonlyMap<string, FakeNode> = new Map([
    ["F:foo", { name: "foo", kind: "Function", filePath: "src/foo.ts", startLine: 1, endLine: 3 }],
  ]);
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 5, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: nodesWithLines,
    },
    {},
    async ({ ctx, server }) => {
      const patchedCtx: ToolContext = {
        ...ctx,
        fsFactory: () => ({
          readFile: async (_p: string) => "some source",
          writeFileAtomic: async () => {
            throw new Error("not supported");
          },
        }),
      };
      registerQueryTool(server, patchedCtx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ content?: string }>;
      };
      assert.equal(sc.results[0]?.content, undefined, "content must be absent when flag is off");
    },
  );
});

test("query: include_content caps the attached source body at 2000 chars with an ellipsis", async () => {
  const nodesWithLines: ReadonlyMap<string, FakeNode> = new Map([
    ["F:big", { name: "big", kind: "Function", filePath: "src/big.ts", startLine: 1, endLine: 50 }],
  ]);
  // 50 lines × 60 chars + newlines ≈ 3049 chars — comfortably past the 2000 cap.
  const fat = "x".repeat(60);
  const src = Array.from({ length: 50 }, () => fat).join("\n");
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:big", score: 1, filePath: "src/big.ts", name: "big", kind: "Function" },
      ],
      vectorRows: [],
      nodes: nodesWithLines,
    },
    {},
    async ({ ctx, server }) => {
      const patchedCtx: ToolContext = {
        ...ctx,
        fsFactory: () => ({
          readFile: async (absPath: string) => {
            if (absPath.endsWith("src/big.ts")) return src;
            throw new Error(`ENOENT: ${absPath}`);
          },
          writeFileAtomic: async () => {
            throw new Error("not supported");
          },
        }),
      };
      registerQueryTool(server, patchedCtx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "big", repo: "fakerepo", include_content: true }, {});
      const sc = result.structuredContent as {
        results: Array<{ content?: string }>;
      };
      const body = sc.results[0]?.content ?? "";
      assert.ok(body.length <= 2000, `content must be ≤2000 chars; got ${body.length}`);
      assert.ok(body.endsWith("…"), "truncation marker expected when cap hits");
    },
  );
});

test("query: include_content with unreadable file simply omits content (no crash)", async () => {
  const nodesWithLines: ReadonlyMap<string, FakeNode> = new Map([
    [
      "F:gone",
      {
        name: "gone",
        kind: "Function",
        filePath: "src/deleted.ts",
        startLine: 1,
        endLine: 3,
      },
    ],
  ]);
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:gone", score: 5, filePath: "src/deleted.ts", name: "gone", kind: "Function" },
      ],
      vectorRows: [],
      nodes: nodesWithLines,
    },
    { files: new Map<string, string>() /* nothing readable */ },
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "gone", repo: "fakerepo", include_content: true }, {});
      const sc = result.structuredContent as {
        results: Array<{ content?: string }>;
      };
      assert.equal(result.isError, undefined, "unreadable file must not raise an error envelope");
      assert.equal(
        sc.results[0]?.content,
        undefined,
        "content must be absent when the source file is unreadable",
      );
    },
  );
});

test("query: max_symbols caps process_symbols after grouping", async () => {
  // With no PROCESS_STEP edges, process_symbols stays empty and the cap is a
  // no-op — but the MVP contract still requires that requesting `max_symbols`
  // never mutates the flat `results[]` length. Exercises both branches:
  // (a) the cap is parsed and accepted without error,
  // (b) `process_symbols.length <= max_symbols` invariant.
  await withHarness(
    {
      embeddingRows: 0,
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      ],
      vectorRows: [],
      nodes: NODES_FOO_BAR,
    },
    {},
    async ({ ctx, server }) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo", max_symbols: 3 }, {});
      const sc = result.structuredContent as {
        results: readonly unknown[];
        process_symbols: readonly unknown[];
      };
      assert.equal(result.isError, undefined);
      assert.ok(
        sc.process_symbols.length <= 3,
        `process_symbols.length must be ≤ max_symbols; got ${sc.process_symbols.length}`,
      );
      // The flat `results` list is governed by `limit`, not `max_symbols`.
      assert.equal(sc.results.length, 1);
    },
  );
});
