// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `codehub://repo/{name}/clusters` MCP resource.
 *
 * Surfaces exercised:
 *   - Happy path: Community rows render with label/cohesion/symbolCount
 *     and optional keywords, ranked by symbolCount DESC, cohesion DESC.
 *   - Empty case: a repo with zero Community nodes emits an empty YAML
 *     list rather than an error.
 *   - Cap: only the top 20 clusters are emitted even when more exist.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeNodeLike,
  getResourceHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import { registerRepoClustersResource } from "./repo-clusters.js";
import type { ResourceContext } from "./repos.js";

interface FakeCommunityRow {
  id: string;
  name: string;
  inferred_label?: string;
  symbol_count?: number;
  cohesion?: number;
  keywords?: readonly string[];
}

/**
 * Project the fake row shape — which mirrors the underlying snake_case
 * SQL columns — into a CommunityNode-shaped node the typed `listNodesByKind`
 * fake can return.
 */
function communityNodes(rows: readonly FakeCommunityRow[]): FakeNodeLike[] {
  return rows.map((r) => ({
    id: r.id,
    kind: "Community",
    name: r.name,
    filePath: "",
    inferredLabel: r.inferred_label,
    symbolCount: r.symbol_count ?? 0,
    cohesion: r.cohesion ?? 0,
    keywords: r.keywords ?? [],
  }));
}

async function withHarness(
  rows: readonly FakeCommunityRow[],
  fn: (
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    ctx: ResourceContext,
    repoName: string,
  ) => Promise<void>,
): Promise<void> {
  await withMcpHarness(
    {
      tmpPrefix: "codehub-clusters-test-",
      serverCapabilities: { resources: {} },
      storeFactory: () => makeFakeGraphStore({ nodes: communityNodes(rows) }),
    },
    async ({ server, pool, home, repoName }) => {
      const ctx: ResourceContext = { pool, home };
      await fn(server, ctx, repoName);
    },
  );
}

test("repo-clusters: renders Community rows ranked by size then cohesion", async () => {
  await withHarness(
    [
      {
        id: "C:b",
        name: "community-1",
        inferred_label: "auth-login-session",
        symbol_count: 8,
        cohesion: 1.5,
        keywords: ["auth", "login"],
      },
      {
        id: "C:a",
        name: "community-0",
        inferred_label: "orders-stripe",
        symbol_count: 12,
        cohesion: 2.0,
        keywords: ["order", "stripe"],
      },
      {
        id: "C:c",
        name: "community-2",
        symbol_count: 4,
        cohesion: 0.5,
      },
    ],
    async (server, ctx, repoName) => {
      registerRepoClustersResource(server, ctx);
      const handler = getResourceHandler(server, "repo-clusters");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/clusters`);
      const result = await handler(uri, { name: repoName }, {});
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /^repo: fakerepo$/m);
      assert.match(text, /clusters:/);
      // orders-stripe (12 symbols) must land above auth-login-session (8).
      const ordersIdx = text.indexOf("orders-stripe");
      const authIdx = text.indexOf("auth-login-session");
      assert.ok(ordersIdx > 0 && authIdx > 0);
      assert.ok(ordersIdx < authIdx, "larger symbolCount must rank first");
      // Field name must be `label` (the banned alias must never appear).
      assert.match(text, /^ {4}label: orders-stripe$/m);
      assert.doesNotMatch(text, new RegExp(`${"heuristic"}${"Label"}`));
      assert.match(text, /^ {4}symbolCount: 12$/m);
      assert.match(text, /^ {4}cohesion: 2$/m);
      assert.match(text, /^ {6}- order$/m);
    },
  );
});

test("repo-clusters: empty repo emits an empty YAML list", async () => {
  await withHarness([], async (server, ctx, repoName) => {
    registerRepoClustersResource(server, ctx);
    const handler = getResourceHandler(server, "repo-clusters");
    const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/clusters`);
    const result = await handler(uri, { name: repoName }, {});
    const text = (result.contents[0] as { text: string }).text;
    assert.match(text, /^clusters:$/m);
    assert.match(text, /^ {2}\[\]$/m);
  });
});

test("repo-clusters: caps results at 20 even when more rows exist", async () => {
  const rows: FakeCommunityRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push({
      id: `C:${i.toString().padStart(3, "0")}`,
      name: `community-${i}`,
      symbol_count: 100 - i,
      cohesion: 1,
    });
  }
  await withHarness(rows, async (server, ctx, repoName) => {
    registerRepoClustersResource(server, ctx);
    const handler = getResourceHandler(server, "repo-clusters");
    const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/clusters`);
    const result = await handler(uri, { name: repoName }, {});
    const text = (result.contents[0] as { text: string }).text;
    const matches = text.match(/^ {2}- id:/gm) ?? [];
    assert.equal(matches.length, 20, "must cap at 20");
    // Highest-ranked (community-0 with symbolCount 100) should be first.
    assert.match(text, /community-0\b[\s\S]*community-19/);
  });
});
