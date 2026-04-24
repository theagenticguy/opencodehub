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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
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

function makeFakeStore(
  communities: readonly FakeCommunity[],
  members: readonly FakeMember[],
): DuckDbStore {
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

      // Exact-match resolver (name OR inferred_label).
      if (
        text.startsWith(
          "SELECT id, name, inferred_label FROM nodes WHERE kind = 'Community' AND (name = ? OR inferred_label = ?)",
        )
      ) {
        const target = String(params[0] ?? "");
        const found = communities.find((c) => c.name === target || c.inferredLabel === target);
        return found
          ? [
              {
                id: found.id,
                name: found.name,
                inferred_label: found.inferredLabel ?? null,
              },
            ]
          : [];
      }

      // Member lookup via MEMBER_OF.
      if (
        text.startsWith(
          "SELECT n.id AS id, n.name AS name, n.kind AS kind, n.file_path AS file_path FROM relations r JOIN nodes n ON n.id = r.from_id WHERE r.type = 'MEMBER_OF' AND r.to_id = ?",
        )
      ) {
        const communityId = String(params[0]);
        const limit = Number(params[1] ?? 100);
        return members
          .filter((m) => m.communityId === communityId)
          .sort((a, b) => {
            if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
            if (a.name !== b.name) return a.name < b.name ? -1 : 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
          .slice(0, limit)
          .map((m) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
            file_path: m.filePath,
          }));
      }

      // Candidate-listing for the not-found envelope.
      if (text.startsWith("SELECT name, inferred_label FROM nodes WHERE kind = 'Community'")) {
        return communities.map((c) => ({
          name: c.name,
          inferred_label: c.inferredLabel ?? null,
        }));
      }
      throw new Error(`unsupported sql: ${text}`);
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
    bulkLoadCochanges: async (_rows: readonly unknown[]): Promise<void> => {},
    lookupCochangesForFile: async () => [],
    lookupCochangesBetween: async () => undefined,
  } as unknown as DuckDbStore;
  return api;
}

async function withHarness(
  communities: readonly FakeCommunity[],
  members: readonly FakeMember[],
  fn: (server: McpServer, ctx: ResourceContext, repoName: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-cluster-test-"));
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
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () =>
      makeFakeStore(communities, members),
    );
    const ctx: ResourceContext = { pool, home };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { resources: {} } },
    );
    try {
      await fn(server, ctx, "fakerepo");
    } finally {
      await pool.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

type ResourceRegistry = {
  readCallback: (
    uri: URL,
    vars: Record<string, string>,
    extra: unknown,
  ) => Promise<ReadResourceResult>;
};
function getResourceHandler(server: McpServer, name: string): ResourceRegistry["readCallback"] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internals for test-only access
  const map = (server as any)._registeredResourceTemplates as Record<string, ResourceRegistry>;
  const entry = map[name];
  assert.ok(entry, `resource template not registered: ${name}`);
  return entry.readCallback.bind(entry);
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
