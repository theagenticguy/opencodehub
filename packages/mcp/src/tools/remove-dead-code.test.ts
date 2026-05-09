// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * `remove_dead_code` MCP tool tests.
 *
 * Covers three load-bearing contracts:
 *   1. `dryRun=true` (default) returns the edit plan without touching disk.
 *   2. `dryRun=false + apply=true` writes the deletions through the injected
 *      `FsAbstraction`.
 *   3. `dryRun=false` without `apply=true` is refused with INVALID_INPUT.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FsAbstraction } from "@opencodehub/analysis";
import type {
  CodeRelation,
  GraphNode,
  KnowledgeGraph,
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
import { type RemoveDeadCodeContext, registerRemoveDeadCodeTool } from "./remove-dead-code.js";

/**
 * Wrap an in-memory IGraphStore-shaped fake as the composed `Store`
 * (`OpenStoreResult`) that the connection pool returns post AC-A-6c.
 * The same instance backs both `graph` and `temporal` because DuckDbStore
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

/**
 * In-memory fake of the typed-finder surface that `classifyDeadness` and
 * `enrichWithEndLines` consume post AC-A-6c: `listNodes`, `listEdges`,
 * `listEdgesByType`. Edges are absent from these tests (the dead-code path
 * looks for inbound referrers but we only seed isolated dead candidates).
 */
function makeFakeStore(nodes: readonly FakeNode[]): DuckDbStore {
  const nodeAsGraphNode = (n: FakeNode): GraphNode => n as unknown as GraphNode;

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
    listEdges: async (_opts: ListEdgesOptions = {}): Promise<readonly CodeRelation[]> => [],
    listEdgesByType: async (
      _type: RelationType,
      _opts: ListEdgesByTypeOptions = {},
    ): Promise<readonly CodeRelation[]> => [],
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
  } as unknown as DuckDbStore;
  return api;
}

class FakeFs implements FsAbstraction {
  readonly files: Map<string, string>;

  constructor(seed: Readonly<Record<string, string>> = {}) {
    this.files = new Map(Object.entries(seed));
  }

  readFile(absPath: string): Promise<string> {
    const v = this.files.get(absPath);
    if (v === undefined) return Promise.reject(new Error(`ENOENT: ${absPath}`));
    return Promise.resolve(v);
  }

  writeFileAtomic(absPath: string, content: string): Promise<void> {
    this.files.set(absPath, content);
    return Promise.resolve();
  }
}

interface Harness {
  readonly ctx: RemoveDeadCodeContext;
  readonly server: McpServer;
  readonly repoPath: string;
  readonly fs: FakeFs;
}

async function withHarness(
  nodes: FakeNode[],
  files: Readonly<Record<string, string>>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-rm-dead-"));
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
          edgeCount: 0,
          lastCommit: "abc123",
        },
      }),
    );
    // Seed the fake filesystem with repo-absolute paths so `resolveAbs` in the
    // handler produces keys the FakeFs recognises.
    const seed: Record<string, string> = {};
    for (const [rel, content] of Object.entries(files)) {
      seed[join(repoPath, rel)] = content;
    }
    const fs = new FakeFs(seed);
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () =>
      wrapAsStore(makeFakeStore(nodes)),
    );
    const ctx: RemoveDeadCodeContext = { pool, home, fsFactory: () => fs };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    try {
      await fn({ ctx, server, repoPath, fs });
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

const DEAD_FILE_REL = "src/dead.ts";
const DEAD_FILE_SRC = [
  "function lonely() {", // line 1
  "  return 1;", //       line 2
  "}", //                 line 3
  "", //                  line 4
  "export const alive = 5;", // line 5
  "",
].join("\n");

function deadNodes(): FakeNode[] {
  return [
    {
      id: "Function:src/dead.ts:lonely",
      name: "lonely",
      kind: "Function",
      filePath: DEAD_FILE_REL,
      startLine: 1,
      endLine: 3,
      isExported: false,
    },
  ];
}

test("remove_dead_code dry-run returns the edit plan without writing", async () => {
  await withHarness(
    deadNodes(),
    { [DEAD_FILE_REL]: DEAD_FILE_SRC },
    async ({ ctx, server, repoPath, fs }) => {
      registerRemoveDeadCodeTool(server, ctx);
      const handler = getHandler(server, "remove_dead_code");

      const result = await handler({ repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        filesAffected: number;
        totalDeletions: number;
        edits: Array<{ filePath: string; startLine: number; endLine: number; content: string }>;
        applied: boolean;
      };

      assert.equal(sc.applied, false);
      assert.equal(sc.filesAffected, 1);
      assert.equal(sc.totalDeletions, 1);
      assert.equal(sc.edits.length, 1);
      assert.equal(sc.edits[0]?.filePath, DEAD_FILE_REL);
      assert.equal(sc.edits[0]?.startLine, 1);
      assert.equal(sc.edits[0]?.endLine, 3);
      assert.equal(sc.edits[0]?.content, "function lonely() {\n  return 1;\n}");

      // File on disk (well, in the fake) must still match the original source.
      const absPath = join(repoPath, DEAD_FILE_REL);
      assert.equal(fs.files.get(absPath), DEAD_FILE_SRC);
    },
  );
});

test("remove_dead_code apply=true rewrites the file with the dead range removed", async () => {
  await withHarness(
    deadNodes(),
    { [DEAD_FILE_REL]: DEAD_FILE_SRC },
    async ({ ctx, server, repoPath, fs }) => {
      registerRemoveDeadCodeTool(server, ctx);
      const handler = getHandler(server, "remove_dead_code");

      const result = await handler({ repo: "fakerepo", dryRun: false, apply: true }, {});
      const sc = result.structuredContent as {
        applied: boolean;
        filesAffected: number;
        totalDeletions: number;
      };
      assert.equal(sc.applied, true);
      assert.equal(sc.filesAffected, 1);
      assert.equal(sc.totalDeletions, 1);

      const rewritten = fs.files.get(join(repoPath, DEAD_FILE_REL));
      assert.ok(rewritten !== undefined);
      // Lines 1-3 removed; blank line 4, the export line, and trailing newline remain.
      assert.equal(rewritten, "\nexport const alive = 5;\n");
    },
  );
});

test("remove_dead_code refuses dryRun=false without explicit apply=true", async () => {
  await withHarness(
    deadNodes(),
    { [DEAD_FILE_REL]: DEAD_FILE_SRC },
    async ({ ctx, server, repoPath, fs }) => {
      registerRemoveDeadCodeTool(server, ctx);
      const handler = getHandler(server, "remove_dead_code");

      const result = await handler({ repo: "fakerepo", dryRun: false }, {});
      const sc = result.structuredContent as {
        error?: { code: string; message: string };
      };
      assert.equal(result.isError, true);
      assert.equal(sc.error?.code, "INVALID_INPUT");
      assert.ok(sc.error?.message.includes("apply=true"));

      // Still untouched.
      assert.equal(fs.files.get(join(repoPath, DEAD_FILE_REL)), DEAD_FILE_SRC);
    },
  );
});
