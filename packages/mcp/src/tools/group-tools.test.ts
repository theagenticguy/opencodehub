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
import { registerGroupListTool } from "./group-list.js";
import { registerGroupQueryTool } from "./group-query.js";
import { registerGroupStatusTool } from "./group-status.js";
import { registerQueryTool } from "./query.js";
import type { ToolContext } from "./shared.js";

// --- Fake store -----------------------------------------------------------

interface FakeRepoData {
  readonly name: string;
  readonly searchResults: readonly SearchResult[];
}

function makeFakeStore(data: FakeRepoData): DuckDbStore {
  const byId = new Map<string, SearchResult>();
  for (const r of data.searchResults) byId.set(r.nodeId, r);
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
      p: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      // query tool's node hydration — return minimal rows so enrichWithContext
      // can keep fused hits in place. Snippet extraction will be null because
      // the fake filesystem does not serve any source files.
      if (
        normalized.startsWith(
          "SELECT id, name, file_path, kind, start_line, end_line FROM nodes WHERE id IN",
        )
      ) {
        const idSet = new Set(p.map((x) => String(x)));
        const out: Record<string, unknown>[] = [];
        for (const id of idSet) {
          const r = byId.get(id);
          if (!r) continue;
          out.push({
            id: r.nodeId,
            name: r.name,
            kind: r.kind,
            file_path: r.filePath,
            start_line: null,
            end_line: null,
          });
        }
        return out;
      }
      return [];
    },
    search: async (q: SearchQuery): Promise<readonly SearchResult[]> =>
      data.searchResults
        .filter((r) => r.name.toLowerCase().includes(q.text.toLowerCase()))
        .slice(0, q.limit ?? 50),
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
  } as unknown as DuckDbStore;
  return api;
}

// --- Harness --------------------------------------------------------------

interface RepoFixture {
  readonly name: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly searchResults: readonly SearchResult[];
}

interface GroupFixture {
  readonly name: string;
  readonly repos: readonly string[];
  readonly description?: string;
}

async function withTestHarness(
  repos: readonly RepoFixture[],
  groups: readonly GroupFixture[],
  fn: (ctx: ToolContext, server: McpServer, home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-group-"));
  try {
    // Seed per-repo on-disk layout.
    const registryEntries: Record<string, unknown> = {};
    const repoPaths = new Map<string, string>();
    for (const r of repos) {
      const repoPath = resolve(home, r.name);
      await mkdir(repoPath, { recursive: true });
      repoPaths.set(r.name, repoPath);
      registryEntries[r.name] = {
        name: r.name,
        path: repoPath,
        indexedAt: "2026-04-18T00:00:00Z",
        nodeCount: r.nodeCount,
        edgeCount: r.edgeCount,
        lastCommit: "abc123",
      };
    }
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(resolve(regDir, "registry.json"), JSON.stringify(registryEntries));

    // Seed groups on disk.
    const groupsDir = resolve(home, ".codehub", "groups");
    await mkdir(groupsDir, { recursive: true });
    for (const g of groups) {
      const content = {
        name: g.name,
        createdAt: "2026-04-18T00:00:00Z",
        repos: g.repos.map((n) => ({ name: n, path: repoPaths.get(n) ?? "" })),
        ...(g.description !== undefined ? { description: g.description } : {}),
      };
      await writeFile(resolve(groupsDir, `${g.name}.json`), JSON.stringify(content));
    }

    // Fake store pool: hand back a fake for every repo path.
    const pool = new ConnectionPool({ max: 4, ttlMs: 60_000 }, async (dbPath) => {
      // dbPath looks like <repoPath>/.codehub/graph.duckdb — match by repo name.
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
      await fn(ctx, server, home);
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

// --- Tests ----------------------------------------------------------------

test("group_list returns every group sorted by name", async () => {
  await withTestHarness(
    [
      { name: "alpha", nodeCount: 10, edgeCount: 20, searchResults: [] },
      { name: "bravo", nodeCount: 30, edgeCount: 40, searchResults: [] },
    ],
    [
      { name: "stack_two", repos: ["alpha", "bravo"] },
      { name: "stack_one", repos: ["alpha"], description: "Just alpha" },
    ],
    async (ctx, server) => {
      registerGroupListTool(server, ctx);
      const handler = getHandler(server, "group_list");
      const result = await handler({}, {});
      const sc = result.structuredContent as {
        groups: Array<{ name: string; repos: Array<{ name: string }> }>;
      };
      assert.equal(sc.groups.length, 2);
      assert.equal(sc.groups[0]?.name, "stack_one");
      assert.equal(sc.groups[1]?.name, "stack_two");
      // Repos within a group are sorted alphabetically.
      assert.deepEqual(
        sc.groups[1]?.repos.map((r) => r.name),
        ["alpha", "bravo"],
      );
    },
  );
});

test("group_list returns empty array when no groups exist", async () => {
  await withTestHarness(
    [{ name: "solo", nodeCount: 1, edgeCount: 0, searchResults: [] }],
    [],
    async (ctx, server) => {
      registerGroupListTool(server, ctx);
      const handler = getHandler(server, "group_list");
      const result = await handler({}, {});
      const sc = result.structuredContent as { groups: unknown[] };
      assert.equal(sc.groups.length, 0);
    },
  );
});

test("group_status returns NOT_FOUND for unknown group", async () => {
  await withTestHarness([], [], async (ctx, server) => {
    registerGroupStatusTool(server, ctx);
    const handler = getHandler(server, "group_status");
    const result = await handler({ groupName: "ghost" }, {});
    assert.equal(result.isError, true);
    const sc = result.structuredContent as { error: { code: string } };
    assert.equal(sc.error.code, "NOT_FOUND");
  });
});

test("group_status enumerates per-repo status rows", async () => {
  await withTestHarness(
    [
      { name: "alpha", nodeCount: 10, edgeCount: 20, searchResults: [] },
      { name: "bravo", nodeCount: 30, edgeCount: 40, searchResults: [] },
    ],
    [{ name: "stack", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupStatusTool(server, ctx);
      const handler = getHandler(server, "group_status");
      const result = await handler({ groupName: "stack" }, {});
      const sc = result.structuredContent as {
        groupName: string;
        repos: Array<{ name: string; inRegistry: boolean; nodeCount: number | null }>;
      };
      assert.equal(sc.groupName, "stack");
      assert.equal(sc.repos.length, 2);
      assert.equal(sc.repos[0]?.name, "alpha");
      assert.equal(sc.repos[0]?.inRegistry, true);
      assert.equal(sc.repos[0]?.nodeCount, 10);
      assert.equal(sc.repos[1]?.name, "bravo");
    },
  );
});

test("group_query fans out BM25 + RRF withresponse shape", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 10,
        edgeCount: 20,
        searchResults: [
          {
            nodeId: "F:alpha:foo",
            name: "foo",
            kind: "Function",
            filePath: "alpha/foo.ts",
            score: 1,
          },
        ],
      },
      {
        name: "bravo",
        nodeCount: 30,
        edgeCount: 40,
        searchResults: [
          {
            nodeId: "F:bravo:foo",
            name: "foo",
            kind: "Function",
            filePath: "bravo/foo.ts",
            score: 1,
          },
          {
            nodeId: "F:bravo:foobar",
            name: "foobar",
            kind: "Function",
            filePath: "bravo/foobar.ts",
            score: 1,
          },
        ],
      },
    ],
    [{ name: "stack", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupQueryTool(server, ctx);
      const handler = getHandler(server, "group_query");
      const result = await handler({ groupName: "stack", query: "foo" }, {});
      const sc = result.structuredContent as {
        group: string;
        query: string;
        results: Array<{
          _repo: string;
          _rrf_score: number;
          nodeId: string;
          name: string;
          kind: string;
          filePath: string;
          score: number;
        }>;
        per_repo: Array<{ repo: string; count: number; error?: string }>;
        warnings: string[];
      };
      assert.equal(sc.group, "stack");
      assert.equal(sc.query, "foo");
      assert.deepEqual(sc.warnings, []);
      // per_repo[] has one row per attempted member, including counts.
      assert.equal(sc.per_repo.length, 2);
      assert.equal(sc.per_repo[0]?.repo, "alpha");
      assert.equal(sc.per_repo[0]?.count, 1);
      assert.equal(sc.per_repo[1]?.repo, "bravo");
      assert.equal(sc.per_repo[1]?.count, 2);
      assert.ok(sc.results.length >= 2);
      const top = sc.results[0];
      assert.ok(top);
      // Both alpha::foo and bravo::foo tied at RRF score 1/61; lex tiebreak
      // picks alpha::F:alpha:foo before bravo::F:bravo:foo.
      assert.equal(top._repo, "alpha");
      assert.equal(top.name, "foo");
      assert.equal(top.nodeId, "F:alpha:foo");
      assert.ok(top._rrf_score > 0);
    },
  );
});

test("group_query subgroup filter skips non-member repos", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 10,
        edgeCount: 20,
        searchResults: [
          {
            nodeId: "F:alpha:foo",
            name: "foo",
            kind: "Function",
            filePath: "alpha/foo.ts",
            score: 1,
          },
        ],
      },
      {
        name: "bravo",
        nodeCount: 30,
        edgeCount: 40,
        searchResults: [
          {
            nodeId: "F:bravo:foo",
            name: "foo",
            kind: "Function",
            filePath: "bravo/foo.ts",
            score: 1,
          },
        ],
      },
    ],
    [{ name: "stack", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupQueryTool(server, ctx);
      const handler = getHandler(server, "group_query");
      const result = await handler({ groupName: "stack", query: "foo", subgroup: ["bravo"] }, {});
      const sc = result.structuredContent as {
        per_repo: Array<{ repo: string; count: number }>;
        results: Array<{ _repo: string }>;
      };
      assert.equal(sc.per_repo.length, 1);
      assert.equal(sc.per_repo[0]?.repo, "bravo");
      // Every result is from the subgroup.
      for (const r of sc.results) assert.equal(r._repo, "bravo");
    },
  );
});

test("group_query kinds filter is threaded into per-repo BM25", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 10,
        edgeCount: 20,
        searchResults: [
          {
            nodeId: "F:alpha:foo",
            name: "foo",
            kind: "Function",
            filePath: "alpha/foo.ts",
            score: 1,
          },
          {
            nodeId: "C:alpha:Foo",
            name: "Foo",
            kind: "Class",
            filePath: "alpha/Foo.ts",
            score: 1,
          },
        ],
      },
    ],
    [{ name: "solo", repos: ["alpha"] }],
    async (ctx, server) => {
      // The fake store ignores kinds; we rewire it inline so we can assert
      // the filter is actually delivered.
      // biome-ignore lint/suspicious/noExplicitAny: SDK internal for test wiring
      const anyCtx = ctx as any;
      const originalFactory = anyCtx.pool.factory as (dbPath: string) => Promise<unknown>;
      let observedKinds: readonly string[] | undefined;
      anyCtx.pool.factory = async (dbPath: string) => {
        const store = (await originalFactory(dbPath)) as {
          search: (q: {
            text: string;
            kinds?: readonly string[];
            limit?: number;
          }) => Promise<unknown>;
        };
        const originalSearch = store.search.bind(store);
        store.search = async (q) => {
          observedKinds = q.kinds;
          return originalSearch(q);
        };
        return store;
      };

      registerGroupQueryTool(server, ctx);
      const handler = getHandler(server, "group_query");
      await handler({ groupName: "solo", query: "foo", kinds: ["Function"] }, {});
      assert.deepEqual(observedKinds, ["Function"]);
    },
  );
});

test("group_query flags orphan repo references but still queries the rest", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 10,
        edgeCount: 20,
        searchResults: [
          {
            nodeId: "F:alpha:foo",
            name: "foo",
            kind: "Function",
            filePath: "alpha/foo.ts",
            score: 1,
          },
        ],
      },
    ],
    // The group references "ghost" which is not in the registry.
    [{ name: "mixed", repos: ["alpha", "ghost"] }],
    async (ctx, server, home) => {
      // Rewrite the group file directly to inject a fake orphan repo path.
      const groupsDir = resolve(home, ".codehub", "groups");
      await writeFile(
        resolve(groupsDir, "mixed.json"),
        JSON.stringify({
          name: "mixed",
          createdAt: "2026-04-18T00:00:00Z",
          repos: [
            { name: "alpha", path: resolve(home, "alpha") },
            { name: "ghost", path: resolve(home, "ghost") },
          ],
        }),
      );
      registerGroupQueryTool(server, ctx);
      const handler = getHandler(server, "group_query");
      const result = await handler({ groupName: "mixed", query: "foo" }, {});
      const sc = result.structuredContent as {
        per_repo: Array<{ repo: string; count: number; error?: string }>;
        results: unknown[];
        warnings: string[];
      };
      // per_repo[] has a row per attempted member, including the orphan.
      assert.equal(sc.per_repo.length, 2);
      const alpha = sc.per_repo.find((r) => r.repo === "alpha");
      const ghost = sc.per_repo.find((r) => r.repo === "ghost");
      assert.ok(alpha && alpha.count === 1 && alpha.error === undefined);
      assert.ok(ghost && ghost.count === 0 && ghost.error === "not_in_registry");
      assert.equal(sc.results.length, 1);
      assert.ok(sc.warnings.some((w) => w.includes("ghost")));
      // Markdown body still mentions the orphan for human readers.
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /ghost/);
    },
  );
});

// ---------------------------------------------------------------------------
// Multi-repo acceptance — two-repo same-name isolation + determinism.
// ---------------------------------------------------------------------------

/**
 * Fixture: two repos `alpha` and `bravo` each define a symbol named `foo`
 * at a different path. Exercises the three multi-repo invariants:
 *   (A) `query({repo:"bravo"})` returns only bravo's `foo`.
 *   (B) `query({})` without a `repo` arg returns AMBIGUOUS_REPO.
 *   (C) `group_query` returns both `foo`s tagged with `_repo`, and is
 *       byte-equal across 3 successive runs (RRF determinism).
 */
const SAME_NAME_REPOS = [
  {
    name: "alpha",
    nodeCount: 1,
    edgeCount: 0,
    searchResults: [
      {
        nodeId: "F:alpha:foo",
        name: "foo",
        kind: "Function",
        filePath: "alpha/src/foo.ts",
        score: 1,
      },
    ],
  },
  {
    name: "bravo",
    nodeCount: 1,
    edgeCount: 0,
    searchResults: [
      {
        nodeId: "F:bravo:foo",
        name: "foo",
        kind: "Function",
        filePath: "bravo/src/foo.ts",
        score: 1,
      },
    ],
  },
] as const;

test("query(repo:bravo) returns only bravo's symbol — physical repo isolation", async () => {
  await withTestHarness(
    SAME_NAME_REPOS,
    [{ name: "pair", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "bravo" }, {});
      const sc = result.structuredContent as {
        results?: Array<{ nodeId: string; filePath: string }>;
      };
      // The query tool exposes results under structuredContent.results.
      assert.ok(sc.results && sc.results.length >= 1);
      for (const hit of sc.results) {
        assert.ok(hit.nodeId.startsWith("F:bravo:"));
        assert.ok(hit.filePath.startsWith("bravo/"));
      }
    },
  );
});

test("query without repo arg returns AMBIGUOUS_REPO when >1 repo registered", async () => {
  await withTestHarness(SAME_NAME_REPOS, [], async (ctx, server) => {
    registerQueryTool(server, ctx);
    const handler = getHandler(server, "query");
    const result = await handler({ query: "foo" }, {});
    assert.equal(result.isError, true);
    const sc = result.structuredContent as { error: { code: string; hint?: string } };
    assert.equal(sc.error.code, "AMBIGUOUS_REPO");
    // Hint names both registered repos so the agent can retry.
    assert.ok(sc.error.hint?.includes("alpha"));
    assert.ok(sc.error.hint?.includes("bravo"));
  });
});

test("group_query returns both same-name symbols tagged with _repo", async () => {
  await withTestHarness(
    SAME_NAME_REPOS,
    [{ name: "pair", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupQueryTool(server, ctx);
      const handler = getHandler(server, "group_query");
      const result = await handler({ groupName: "pair", query: "foo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ _repo: string; nodeId: string; name: string }>;
        per_repo: Array<{ repo: string; count: number }>;
      };
      assert.equal(sc.results.length, 2);
      const repos = sc.results.map((r) => r._repo).sort();
      assert.deepEqual(repos, ["alpha", "bravo"]);
      // Every result is the `foo` symbol — the two carry distinct nodeIds.
      const nodeIds = sc.results.map((r) => r.nodeId).sort();
      assert.deepEqual(nodeIds, ["F:alpha:foo", "F:bravo:foo"]);
      // per_repo[] has both members, each with count=1.
      assert.equal(sc.per_repo.length, 2);
      for (const row of sc.per_repo) assert.equal(row.count, 1);
    },
  );
});

test("group_query is deterministic across 3 successive runs (byte-equal structured JSON)", async () => {
  await withTestHarness(
    SAME_NAME_REPOS,
    [{ name: "pair", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupQueryTool(server, ctx);
      const handler = getHandler(server, "group_query");
      const snapshots: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await handler({ groupName: "pair", query: "foo" }, {});
        snapshots.push(JSON.stringify(result.structuredContent));
      }
      assert.equal(snapshots[0], snapshots[1], "run 1 vs run 2 drift");
      assert.equal(snapshots[1], snapshots[2], "run 2 vs run 3 drift");
    },
  );
});
