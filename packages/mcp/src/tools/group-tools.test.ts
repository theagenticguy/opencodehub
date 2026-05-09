// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SearchQuery, SearchResult, VectorQuery, VectorResult } from "@opencodehub/storage";
import { ConnectionPool } from "../connection-pool.js";
import { deriveRepoUri } from "../repo-resolver.js";
import {
  type FakeEdgeLike,
  type FakeNodeLike,
  type FakeRepo,
  type FakeRoute,
  makeFakeGraphStore,
  wrapAsStore,
} from "../test-utils.js";
import { registerGroupContractsTool } from "./group-contracts.js";
import { registerGroupListTool } from "./group-list.js";
import { registerGroupQueryTool } from "./group-query.js";
import { registerGroupStatusTool } from "./group-status.js";
import { registerGroupSyncTool } from "./group-sync.js";
import { registerQueryTool } from "./query.js";
import type { ToolContext } from "./shared.js";

// --- Per-repo fake assembly ----------------------------------------------

interface FakeRepoData {
  readonly name: string;
  readonly searchResults: readonly SearchResult[];
  /**
   * Optional: the graph-backed `RepoNode.repoUri`. When set, the typed
   * `getRepoNode("Repo::::repo")` finder returns this URI; otherwise
   * `repoUriForEntry` falls back to `deriveRepoUri` (AC-M6-4).
   */
  readonly repoNodeUri?: string;
  /** Optional seed for FETCHES edges returned by group_contracts. */
  readonly fetchesEdges?: readonly {
    readonly fromId: string;
    readonly method: string;
    readonly path: string;
  }[];
  /** Optional seed for Route nodes returned by group_contracts. */
  readonly routes?: readonly {
    readonly id: string;
    readonly method: string;
    readonly url: string;
  }[];
}

function buildRepoStore(data: FakeRepoData): {
  store: import("@opencodehub/storage").Store;
  observe: { kinds?: readonly string[] | undefined };
} {
  const observe: { kinds?: readonly string[] | undefined } = {};
  const repoNodes: FakeRepo[] = [];
  if (data.repoNodeUri !== undefined) {
    // `repo-uri-for-entry.ts` calls `getRepoNode(makeNodeId("Repo", "", "repo"))`
    // which yields the canonical id `Repo::repo` (kind:filePath:qualifiedName,
    // both empty filePath and bare qualifiedName).
    repoNodes.push({
      id: "Repo::repo",
      kind: "Repo",
      name: data.name,
      repoUri: data.repoNodeUri,
      originUrl: null,
      defaultBranch: null,
      group: null,
    });
  }
  // FETCHES edges with `to` = `fetches:unresolved:<METHOD>:<PATH>` are the
  // raw shape group-contracts.ts emits when consumer FETCHES haven't yet
  // resolved to a producer Route.
  const edges: FakeEdgeLike[] = (data.fetchesEdges ?? []).map((e) => ({
    type: "FETCHES",
    fromId: e.fromId,
    toId: `fetches:unresolved:${e.method}:${e.path}`,
  }));
  const routes: FakeRoute[] = (data.routes ?? []).map((r) => ({
    id: r.id,
    kind: "Route" as const,
    name: `${r.method} ${r.url}`,
    filePath: "",
    url: r.url,
    method: r.method,
    responseKeys: [],
  }));
  // Also surface SearchResult nodeIds as nodes so any post-search node
  // hydration finds matching rows.
  const nodes: FakeNodeLike[] = data.searchResults.map((r) => ({
    id: r.nodeId,
    kind: r.kind,
    name: r.name,
    filePath: r.filePath,
  }));
  const store = makeFakeGraphStore(
    { nodes, edges, routes, repoNodes },
    {
      // Capture kinds passed into BM25 so the kinds-threading test can assert.
      search: async (q: SearchQuery): Promise<readonly SearchResult[]> => {
        observe.kinds = q.kinds;
        return data.searchResults
          .filter((r) => r.name.toLowerCase().includes(q.text.toLowerCase()))
          .slice(0, q.limit ?? 50);
      },
      vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    },
  );
  return { store: wrapAsStore(store), observe };
}

// --- Harness --------------------------------------------------------------

interface RepoFixture {
  readonly name: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly searchResults: readonly SearchResult[];
  /**
   * Optional: graph-backed `RepoNode.repoUri` for AC-M6-4 assertions.
   * When set, the typed `getRepoNode` finder surfaces the URI; otherwise
   * the tool falls back to `deriveRepoUri`.
   */
  readonly repoNodeUri?: string;
  readonly fetchesEdges?: readonly {
    readonly fromId: string;
    readonly method: string;
    readonly path: string;
  }[];
  readonly routes?: readonly {
    readonly id: string;
    readonly method: string;
    readonly url: string;
  }[];
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
        if (rp && dbPath.startsWith(rp)) {
          const fakeArgs: FakeRepoData = {
            name: r.name,
            searchResults: r.searchResults,
            ...(r.repoNodeUri !== undefined ? { repoNodeUri: r.repoNodeUri } : {}),
            ...(r.fetchesEdges !== undefined ? { fetchesEdges: r.fetchesEdges } : {}),
            ...(r.routes !== undefined ? { routes: r.routes } : {}),
          };
          return buildRepoStore(fakeArgs).store;
        }
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
      // Capture kinds delivered to BM25 by wrapping the pool factory: the
      // graph fake's `search` records `q.kinds` on `observe`, but the only
      // thing we have direct handle on here is the pool — so wrap the
      // factory to intercept the search the way the original test did.
      // biome-ignore lint/suspicious/noExplicitAny: SDK internal for test wiring
      const anyCtx = ctx as any;
      const originalFactory = anyCtx.pool.factory as (dbPath: string) => Promise<unknown>;
      let observedKinds: readonly string[] | undefined;
      anyCtx.pool.factory = async (dbPath: string) => {
        const store = (await originalFactory(dbPath)) as {
          graph: {
            search: (q: {
              text: string;
              kinds?: readonly string[];
              limit?: number;
            }) => Promise<unknown>;
          };
        };
        const originalSearch = store.graph.search.bind(store.graph);
        store.graph.search = async (q) => {
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
    const sc = result.structuredContent as {
      error: {
        code: string;
        hint?: string;
        // AC-M6-2: structured disambiguation payload.
        error_code?: string;
        jsonrpc_code?: number;
        total_matches?: number;
        choices?: ReadonlyArray<{
          repo_uri: string;
          default_branch: string | null;
          group: string | null;
        }>;
      };
    };
    // Legacy contract — stays green.
    assert.equal(sc.error.code, "AMBIGUOUS_REPO");
    // Hint names both registered repos so the agent can retry.
    assert.ok(sc.error.hint?.includes("alpha"));
    assert.ok(sc.error.hint?.includes("bravo"));
    // New structured contract (AC-M6-2).
    assert.equal(sc.error.error_code, "AMBIGUOUS_REPO");
    assert.equal(sc.error.jsonrpc_code, -32602);
    assert.equal(sc.error.total_matches, 2);
    assert.ok(sc.error.choices && sc.error.choices.length === 2);
    const uris = (sc.error.choices ?? []).map((c) => c.repo_uri).sort();
    // Both fixtures use bare names → derived repo_uri is local:<hash>.
    assert.ok(uris.every((u) => u.startsWith("local:")));
  });

  // Also exercise the `repo_uri` alias — the same query with the right
  // alias should resolve cleanly, asserting no AMBIGUOUS error is raised.
  await withTestHarness(SAME_NAME_REPOS, [], async (ctx, server) => {
    registerQueryTool(server, ctx);
    const handler = getHandler(server, "query");
    // Use the `repo` arg (back-compat); then the `repo_uri` alias should
    // work the same way when the registry name itself is URI-shaped.
    // Here names are bare ("alpha"/"bravo") so passing the name through
    // `repo_uri` would not match the local:<hash> — instead verify the
    // alias is plumbed by having `repo` resolve first.
    const okResult = await handler({ query: "foo", repo: "bravo" }, {});
    assert.notEqual(okResult.isError, true);
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

// ---------------------------------------------------------------------------
// AC-M6-4 — additive `repo_uri` across group_* tool responses.
// Legacy fields (`name`, `_repo`, `consumerRepo`, `producerRepo`) stay
// byte-for-byte; the new fields augment them without altering ordering.
// ---------------------------------------------------------------------------

test("group_list emits repo_uri derived from deriveRepoUri when no RepoNode exists (AC-M6-4)", async () => {
  await withTestHarness(
    [
      { name: "alpha", nodeCount: 1, edgeCount: 0, searchResults: [] },
      { name: "bravo", nodeCount: 1, edgeCount: 0, searchResults: [] },
    ],
    [{ name: "stack", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupListTool(server, ctx);
      const handler = getHandler(server, "group_list");
      const result = await handler({}, {});
      const sc = result.structuredContent as {
        groups: Array<{
          name: string;
          repos: Array<{ name: string; repo_uri: string; path: string }>;
        }>;
      };
      const group = sc.groups[0];
      assert.ok(group);
      assert.equal(group.repos.length, 2);
      // Bare names without `/` → `local:<hash>` per deriveRepoUri.
      for (const r of group.repos) {
        assert.match(
          r.repo_uri,
          /^local:[0-9a-f]{12}$/,
          `expected local:<hash> form, got ${r.repo_uri}`,
        );
      }
      // Legacy `name` stays byte-for-byte.
      assert.deepEqual(
        group.repos.map((r) => r.name),
        ["alpha", "bravo"],
      );
    },
  );
});

test("group_list emits repo_uri from RepoNode.repoUri when the graph has one (AC-M6-4)", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 1,
        edgeCount: 0,
        searchResults: [],
        repoNodeUri: "github.com/acme/alpha",
      },
      {
        name: "bravo",
        nodeCount: 1,
        edgeCount: 0,
        searchResults: [],
        // No repoNodeUri — exercises the fall-back path in the same call.
      },
    ],
    [{ name: "stack", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupListTool(server, ctx);
      const handler = getHandler(server, "group_list");
      const result = await handler({}, {});
      const sc = result.structuredContent as {
        groups: Array<{
          repos: Array<{ name: string; repo_uri: string }>;
        }>;
      };
      const repos = sc.groups[0]?.repos ?? [];
      const alpha = repos.find((r) => r.name === "alpha");
      const bravo = repos.find((r) => r.name === "bravo");
      assert.ok(alpha);
      assert.ok(bravo);
      // Graph-backed: exact URI surfaces.
      assert.equal(alpha.repo_uri, "github.com/acme/alpha");
      // Derived fall-back.
      assert.match(bravo.repo_uri, /^local:[0-9a-f]{12}$/);
    },
  );
});

test("group_status per-member row carries both name and repo_uri (AC-M6-4)", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 10,
        edgeCount: 20,
        searchResults: [],
        repoNodeUri: "github.com/acme/alpha",
      },
      { name: "bravo", nodeCount: 30, edgeCount: 40, searchResults: [] },
    ],
    [{ name: "stack", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupStatusTool(server, ctx);
      const handler = getHandler(server, "group_status");
      const result = await handler({ groupName: "stack" }, {});
      const sc = result.structuredContent as {
        repos: Array<{
          name: string;
          repo_uri: string;
          inRegistry: boolean;
          nodeCount: number | null;
        }>;
      };
      assert.equal(sc.repos.length, 2);
      const alpha = sc.repos.find((r) => r.name === "alpha");
      const bravo = sc.repos.find((r) => r.name === "bravo");
      assert.ok(alpha);
      assert.ok(bravo);
      // Graph-backed preferred.
      assert.equal(alpha.repo_uri, "github.com/acme/alpha");
      // Fall-back to deriveRepoUri → local:<hash>.
      assert.match(bravo.repo_uri, /^local:[0-9a-f]{12}$/);
      // Legacy `name` + other fields stay intact.
      assert.equal(alpha.inRegistry, true);
      assert.equal(alpha.nodeCount, 10);
    },
  );
});

test("group_status emits repo_uri for orphan references (not in registry) (AC-M6-4)", async () => {
  await withTestHarness(
    [{ name: "alpha", nodeCount: 1, edgeCount: 0, searchResults: [] }],
    [{ name: "mixed", repos: ["alpha", "ghost"] }],
    async (ctx, server, home) => {
      // Rewrite the group file to inject an unregistered `ghost` member.
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
      registerGroupStatusTool(server, ctx);
      const handler = getHandler(server, "group_status");
      const result = await handler({ groupName: "mixed" }, {});
      const sc = result.structuredContent as {
        repos: Array<{ name: string; repo_uri: string; inRegistry: boolean }>;
      };
      const ghost = sc.repos.find((r) => r.name === "ghost");
      assert.ok(ghost);
      assert.equal(ghost.inRegistry, false);
      // Orphan still receives a deterministic `local:<hash>` handle.
      assert.match(ghost.repo_uri, /^local:[0-9a-f]{12}$/);
    },
  );
});

test("group_query result row carries both _repo and _repo_uri (AC-M6-4)", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 1,
        edgeCount: 0,
        searchResults: [
          {
            nodeId: "F:alpha:foo",
            name: "foo",
            kind: "Function",
            filePath: "alpha/foo.ts",
            score: 1,
          },
        ],
        repoNodeUri: "github.com/acme/alpha",
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
      const result = await handler({ groupName: "stack", query: "foo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ _repo: string; _repo_uri: string; nodeId: string }>;
      };
      assert.ok(sc.results.length >= 2);
      const alpha = sc.results.find((r) => r._repo === "alpha");
      const bravo = sc.results.find((r) => r._repo === "bravo");
      assert.ok(alpha);
      assert.ok(bravo);
      assert.equal(alpha._repo_uri, "github.com/acme/alpha");
      assert.match(bravo._repo_uri, /^local:[0-9a-f]{12}$/);
    },
  );
});

test("group_contracts ContractRow carries both legacy and *RepoUri fields (AC-M6-4)", async () => {
  await withTestHarness(
    [
      {
        name: "consumer",
        nodeCount: 1,
        edgeCount: 0,
        searchResults: [],
        repoNodeUri: "github.com/acme/consumer",
        // Consumer issues a FETCH to GET /orders/{id}.
        fetchesEdges: [{ fromId: "F:consumer:fetchOrder", method: "GET", path: "/orders/{id}" }],
      },
      {
        name: "producer",
        nodeCount: 1,
        edgeCount: 0,
        searchResults: [],
        // Producer hosts GET /orders/{id}.
        routes: [{ id: "R:producer:getOrder", method: "GET", url: "/orders/{id}" }],
      },
    ],
    [{ name: "stack", repos: ["consumer", "producer"] }],
    async (ctx, server) => {
      registerGroupContractsTool(server, ctx);
      const handler = getHandler(server, "group_contracts");
      const result = await handler({ groupName: "stack" }, {});
      const sc = result.structuredContent as {
        contracts: Array<{
          consumerRepo: string;
          consumerRepoUri: string;
          consumerSymbol: string;
          producerRepo: string;
          producerRepoUri: string;
          producerRoute: string;
          method: string;
          path: string;
        }>;
      };
      assert.equal(sc.contracts.length, 1);
      const c = sc.contracts[0];
      assert.ok(c);
      // Legacy fields preserved.
      assert.equal(c.consumerRepo, "consumer");
      assert.equal(c.producerRepo, "producer");
      assert.equal(c.consumerSymbol, "F:consumer:fetchOrder");
      assert.equal(c.producerRoute, "R:producer:getOrder");
      assert.equal(c.method, "GET");
      assert.equal(c.path, "/orders/{id}");
      // New additive fields.
      assert.equal(c.consumerRepoUri, "github.com/acme/consumer");
      assert.match(c.producerRepoUri, /^local:[0-9a-f]{12}$/);
    },
  );
});

test("group_sync structuredContent carries reposWithUri {name, repo_uri} additively (AC-M6-4)", async () => {
  await withTestHarness(
    [
      {
        name: "alpha",
        nodeCount: 1,
        edgeCount: 0,
        searchResults: [],
        repoNodeUri: "github.com/acme/alpha",
      },
      { name: "bravo", nodeCount: 1, edgeCount: 0, searchResults: [] },
    ],
    [{ name: "stack", repos: ["alpha", "bravo"] }],
    async (ctx, server) => {
      registerGroupSyncTool(server, ctx);
      const handler = getHandler(server, "group_sync");
      const result = await handler({ groupName: "stack" }, {});
      const sc = result.structuredContent as {
        repos: readonly string[];
        reposWithUri: ReadonlyArray<{ name: string; repo_uri: string }>;
      };
      // Legacy string[] preserved.
      assert.deepEqual([...sc.repos].sort(), ["alpha", "bravo"]);
      // New additive field.
      assert.equal(sc.reposWithUri.length, 2);
      const alpha = sc.reposWithUri.find((r) => r.name === "alpha");
      const bravo = sc.reposWithUri.find((r) => r.name === "bravo");
      assert.ok(alpha);
      assert.ok(bravo);
      assert.equal(alpha.repo_uri, "github.com/acme/alpha");
      assert.match(bravo.repo_uri, /^local:[0-9a-f]{12}$/);
    },
  );
});

test("group_list repo_uri for bare names is byte-equal to deriveRepoUri (AC-M6-4)", async () => {
  await withTestHarness(
    [{ name: "solo", nodeCount: 1, edgeCount: 0, searchResults: [] }],
    [{ name: "only", repos: ["solo"] }],
    async (ctx, server, home) => {
      registerGroupListTool(server, ctx);
      const handler = getHandler(server, "group_list");
      const result = await handler({}, {});
      const sc = result.structuredContent as {
        groups: Array<{ repos: Array<{ name: string; repo_uri: string; path: string }> }>;
      };
      const repo = sc.groups[0]?.repos[0];
      assert.ok(repo);
      // Expected URI = deriveRepoUri against the registry entry synthesized
      // inside withTestHarness (path = <home>/solo).
      const expected = deriveRepoUri({
        name: "solo",
        path: resolve(home, "solo"),
        indexedAt: "",
        nodeCount: 0,
        edgeCount: 0,
      });
      assert.equal(repo.repo_uri, expected);
    },
  );
});
