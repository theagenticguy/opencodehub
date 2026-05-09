// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `codehub://repo/{name}/cluster/{clusterName}`
 * MCP resource.
 *
 * Surfaces exercised:
 *   - Resolves clusterName by Community.name (stable token).
 *   - Resolves clusterName by Community.inferredLabel (human token) as fallback.
 *   - Lists MEMBER_OF-joined symbols ranked by kind, name; caps at 100.
 *   - Empty membership emits an empty YAML list, not an error.
 *   - Unknown clusterName returns `{error, candidates}` envelope with up to 5
 *     similar names.
 *   - URL-encoded clusterName is decoded before matching.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeEdgeLike,
  type FakeNodeLike,
  getResourceHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import { registerRepoClusterResource } from "./repo-cluster.js";
import type { ResourceContext } from "./repos.js";

interface FakeCommunity {
  id: string;
  name: string;
  inferredLabel?: string;
  symbolCount?: number;
}

interface FakeMember {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  communityId: string;
}

/**
 * Convert FakeCommunity / FakeMember test seeds into typed-finder-friendly
 * nodes + MEMBER_OF edges so `listNodesByKind`, `listEdgesByType`, and
 * `listNodes({ ids })` produce the same data the production tool reads.
 */
function buildFakeGraph(
  communities: readonly FakeCommunity[],
  members: readonly FakeMember[],
): { nodes: FakeNodeLike[]; edges: FakeEdgeLike[] } {
  const nodes: FakeNodeLike[] = [];
  for (const c of communities) {
    nodes.push({
      id: c.id,
      kind: "Community",
      name: c.name,
      filePath: "",
      inferredLabel: c.inferredLabel,
      symbolCount: c.symbolCount ?? 0,
    });
  }
  for (const m of members) {
    nodes.push({
      id: m.id,
      kind: m.kind,
      name: m.name,
      filePath: m.filePath,
    });
  }
  const edges: FakeEdgeLike[] = members.map((m) => ({
    type: "MEMBER_OF",
    fromId: m.id,
    toId: m.communityId,
  }));
  return { nodes, edges };
}

async function withHarness(
  communities: readonly FakeCommunity[],
  members: readonly FakeMember[],
  fn: (
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    ctx: ResourceContext,
    repoName: string,
  ) => Promise<void>,
): Promise<void> {
  const graph = buildFakeGraph(communities, members);
  await withMcpHarness(
    {
      tmpPrefix: "codehub-cluster-test-",
      serverCapabilities: { resources: {} },
      storeFactory: () => makeFakeGraphStore({ nodes: graph.nodes, edges: graph.edges }),
    },
    async ({ server, pool, home, repoName }) => {
      const ctx: ResourceContext = { pool, home };
      await fn(server, ctx, repoName);
    },
  );
}

test("repo-cluster: resolves by Community.name and lists MEMBER_OF symbols", async () => {
  await withHarness(
    [{ id: "C:1", name: "community-0", inferredLabel: "auth-login", symbolCount: 3 }],
    [
      {
        id: "F:login",
        name: "login",
        kind: "Function",
        filePath: "src/auth.ts",
        communityId: "C:1",
      },
      {
        id: "F:logout",
        name: "logout",
        kind: "Function",
        filePath: "src/auth.ts",
        communityId: "C:1",
      },
      { id: "C:User", name: "User", kind: "Class", filePath: "src/user.ts", communityId: "C:1" },
    ],
    async (server, ctx, repoName) => {
      registerRepoClusterResource(server, ctx);
      const handler = getResourceHandler(server, "repo-cluster");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/cluster/community-0`);
      const result = await handler(uri, { name: repoName, clusterName: "community-0" }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^repo: fakerepo$/m);
      assert.match(text, /^cluster:/m);
      assert.match(text, /^ {2}id: "C:1"$/m);
      assert.match(text, /^ {2}label: auth-login$/m);
      assert.match(text, /^members:/m);
      // Class < Function alphabetically, so User appears before login/logout.
      // Anchor the search to the `id:` field so the label's embedded "login"
      // doesn't bleed into the comparison.
      const userIdx = text.indexOf('id: "C:User"');
      const loginIdx = text.indexOf('id: "F:login"');
      assert.ok(userIdx > 0 && loginIdx > 0);
      assert.ok(userIdx < loginIdx, "Class kind sorts before Function");
      // Field name must be `label`, not the banned alias.
      assert.doesNotMatch(text, new RegExp(`${"heuristic"}${"Label"}`));
    },
  );
});

test("repo-cluster: resolves by inferredLabel fallback", async () => {
  await withHarness(
    [{ id: "C:1", name: "community-7", inferredLabel: "orders-stripe", symbolCount: 2 }],
    [
      {
        id: "F:charge",
        name: "charge",
        kind: "Function",
        filePath: "src/pay.ts",
        communityId: "C:1",
      },
      {
        id: "F:refund",
        name: "refund",
        kind: "Function",
        filePath: "src/pay.ts",
        communityId: "C:1",
      },
    ],
    async (server, ctx, repoName) => {
      registerRepoClusterResource(server, ctx);
      const handler = getResourceHandler(server, "repo-cluster");
      // Clients pass the human-readable label; the handler must accept both.
      const encoded = encodeURIComponent("orders-stripe");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/cluster/${encoded}`);
      const result = await handler(uri, { name: repoName, clusterName: encoded }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^ {2}id: "C:1"$/m);
      assert.match(text, /charge/);
      assert.match(text, /refund/);
    },
  );
});

test("repo-cluster: empty members emits empty list (not error)", async () => {
  await withHarness(
    [{ id: "C:1", name: "community-0", symbolCount: 0 }],
    [],
    async (server, ctx, repoName) => {
      registerRepoClusterResource(server, ctx);
      const handler = getResourceHandler(server, "repo-cluster");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/cluster/community-0`);
      const result = await handler(uri, { name: repoName, clusterName: "community-0" }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^members:$/m);
      assert.match(text, /^ {2}\[\]$/m);
      assert.doesNotMatch(text, /error:/);
    },
  );
});

test("repo-cluster: unknown clusterName returns error envelope with candidates", async () => {
  await withHarness(
    [
      { id: "C:1", name: "community-0", inferredLabel: "auth-login", symbolCount: 3 },
      { id: "C:2", name: "community-1", inferredLabel: "auth-token", symbolCount: 2 },
      { id: "C:3", name: "community-2", inferredLabel: "orders-stripe", symbolCount: 1 },
    ],
    [],
    async (server, ctx, repoName) => {
      registerRepoClusterResource(server, ctx);
      const handler = getResourceHandler(server, "repo-cluster");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/cluster/auth-missing`);
      const result = await handler(uri, { name: repoName, clusterName: "auth-missing" }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^error: "not found"$/m);
      assert.match(text, /^candidates:$/m);
      // auth-* clusters (name match) should rank above orders-stripe. The
      // handler caps at 5 candidates; orders-stripe might be elided when
      // all four auth-* tokens rank above it.
      const authTokenIdx = text.indexOf("auth-token");
      const authLoginIdx = text.indexOf("auth-login");
      assert.ok(authTokenIdx > 0, "auth-token should appear in candidates");
      assert.ok(authLoginIdx > 0, "auth-login should appear in candidates");
      // Count emitted candidates (YAML list items under `candidates:`).
      const candidateMatches = text.split("\n").filter((l) => l.startsWith("  - "));
      assert.ok(candidateMatches.length > 0 && candidateMatches.length <= 5);
    },
  );
});
