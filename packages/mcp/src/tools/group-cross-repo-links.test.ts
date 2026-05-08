// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContractRegistry, CrossRepoLink } from "@opencodehub/analysis";
import { ConnectionPool } from "../connection-pool.js";
import { registerGroupCrossRepoLinksTool } from "./group-cross-repo-links.js";
import type { ToolContext } from "./shared.js";

/** Minimal harness: materializes a tmp home with a registry.json, a
 *  groups/<name>.json descriptor, and (optionally) a contracts.json. */
interface HarnessOpts {
  readonly groupName: string;
  readonly repos: readonly string[];
  readonly registry?: ContractRegistry;
}

async function withHarness(
  opts: HarnessOpts,
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-cross-repo-"));
  try {
    const registry: Record<string, unknown> = {};
    const repoPaths = new Map<string, string>();
    for (const name of opts.repos) {
      const repoPath = resolve(home, name);
      await mkdir(repoPath, { recursive: true });
      repoPaths.set(name, repoPath);
      registry[name] = {
        name,
        path: repoPath,
        indexedAt: "2026-04-18T00:00:00Z",
        nodeCount: 0,
        edgeCount: 0,
        lastCommit: "abc",
      };
    }
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(resolve(regDir, "registry.json"), JSON.stringify(registry));

    const groupsDir = resolve(home, ".codehub", "groups");
    await mkdir(groupsDir, { recursive: true });
    const groupContent = {
      name: opts.groupName,
      createdAt: "2026-04-18T00:00:00Z",
      repos: opts.repos.map((n) => ({ name: n, path: repoPaths.get(n) ?? "" })),
    };
    await writeFile(resolve(groupsDir, `${opts.groupName}.json`), JSON.stringify(groupContent));

    if (opts.registry) {
      const groupDir = resolve(groupsDir, opts.groupName);
      await mkdir(groupDir, { recursive: true });
      await writeFile(resolve(groupDir, "contracts.json"), JSON.stringify(opts.registry, null, 2));
    }

    const pool = new ConnectionPool({ max: 4, ttlMs: 60_000 }, async () => {
      throw new Error("no store expected in group_cross_repo_links tests");
    });

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

/** Build a minimal ContractRegistry with one HTTP producer↔consumer pair. */
function fixtureRegistry(
  producerRepo: string,
  consumerRepo: string,
  signature: string,
): ContractRegistry {
  return {
    repos: [producerRepo, consumerRepo].sort(),
    contracts: [],
    crossLinks: [
      {
        producer: {
          type: "http_route",
          signature,
          repo: producerRepo,
          file: `${producerRepo}/server.ts`,
          line: 1,
        },
        consumer: {
          type: "http_call",
          signature,
          repo: consumerRepo,
          file: `${consumerRepo}/client.ts`,
          line: 1,
        },
        matchReason: "signature",
      },
    ],
    computedAt: "2026-05-01T00:00:00.000Z",
  };
}

test("group_cross_repo_links returns 2 sorted links (depends_on + consumer_of) per cross-link", async () => {
  await withHarness(
    {
      groupName: "stack",
      repos: ["api", "web"],
      registry: fixtureRegistry("api", "web", "GET /users"),
    },
    async (ctx, server) => {
      registerGroupCrossRepoLinksTool(server, ctx);
      const handler = getHandler(server, "group_cross_repo_links");
      const result = await handler({ groupName: "stack" }, {});
      const sc = result.structuredContent as {
        groupName: string;
        links: readonly CrossRepoLink[];
        registryPath: string;
        registryComputedAt: string;
      };
      assert.equal(sc.groupName, "stack");
      assert.equal(sc.links.length, 2);
      assert.equal(sc.registryComputedAt, "2026-05-01T00:00:00.000Z");
      assert.ok(sc.registryPath.includes("contracts.json"));
      // Alpha-sorted on source_repo_uri.
      // derive URI: names without "/" → local:<hash>. Both will be `local:...`.
      const sources = sc.links.map((l) => l.source_repo_uri);
      const sorted = [...sources].sort();
      assert.deepEqual(sources, sorted);
      const relations = sc.links.map((l) => l.relation).sort();
      assert.deepEqual(relations, ["consumer_of", "depends_on"]);
    },
  );
});

test("group_cross_repo_links determinism — two calls produce deep-equal output", async () => {
  const fixture: ContractRegistry = {
    repos: ["api", "web", "worker"],
    contracts: [],
    crossLinks: [
      {
        producer: {
          type: "http_route",
          signature: "GET /users",
          repo: "api",
          file: "api/s.ts",
          line: 1,
        },
        consumer: {
          type: "http_call",
          signature: "GET /users",
          repo: "web",
          file: "web/c.ts",
          line: 1,
        },
        matchReason: "signature",
      },
      {
        producer: {
          type: "http_route",
          signature: "POST /jobs",
          repo: "api",
          file: "api/s.ts",
          line: 10,
        },
        consumer: {
          type: "http_call",
          signature: "POST /jobs",
          repo: "worker",
          file: "worker/c.ts",
          line: 1,
        },
        matchReason: "signature",
      },
    ],
    computedAt: "2026-05-01T00:00:00.000Z",
  };
  await withHarness(
    { groupName: "stack", repos: ["api", "web", "worker"], registry: fixture },
    async (ctx, server) => {
      registerGroupCrossRepoLinksTool(server, ctx);
      const handler = getHandler(server, "group_cross_repo_links");
      const a = await handler({ groupName: "stack" }, {});
      const b = await handler({ groupName: "stack" }, {});
      assert.deepEqual(a.structuredContent, b.structuredContent);
      const sc = a.structuredContent as { links: readonly CrossRepoLink[] };
      // 2 cross-links × 2 relations = 4 emitted links.
      assert.equal(sc.links.length, 4);
    },
  );
});

test("group_cross_repo_links with no persisted registry emits empty links + hint", async () => {
  await withHarness({ groupName: "stack", repos: ["api", "web"] }, async (ctx, server) => {
    registerGroupCrossRepoLinksTool(server, ctx);
    const handler = getHandler(server, "group_cross_repo_links");
    const result = await handler({ groupName: "stack" }, {});
    const sc = result.structuredContent as {
      groupName: string;
      links: readonly CrossRepoLink[];
      registryPath: null;
      registryComputedAt: null;
      next_steps?: readonly string[];
    };
    assert.equal(sc.groupName, "stack");
    assert.equal(sc.links.length, 0);
    assert.equal(sc.registryPath, null);
    assert.equal(sc.registryComputedAt, null);
    assert.ok(
      sc.next_steps?.some((s) => s.includes("group_sync")),
      "should hint to run group_sync",
    );
  });
});

test("group_cross_repo_links returns NOT_FOUND for an unknown group", async () => {
  await withHarness({ groupName: "stack", repos: [] }, async (ctx, server) => {
    registerGroupCrossRepoLinksTool(server, ctx);
    const handler = getHandler(server, "group_cross_repo_links");
    const result = await handler({ groupName: "ghost" }, {});
    assert.equal(result.isError, true);
    const sc = result.structuredContent as { error: { code: string } };
    assert.equal(sc.error.code, "NOT_FOUND");
  });
});

test("group_cross_repo_links skips repos missing from the registry", async () => {
  // Group has 3 repos but registry only has 2. The 3rd is silently dropped
  // so the link graph stays consistent.
  const fixture: ContractRegistry = {
    repos: ["api", "web", "ghost"],
    contracts: [],
    crossLinks: [
      {
        producer: {
          type: "http_route",
          signature: "GET /a",
          repo: "api",
          file: "api/s.ts",
          line: 1,
        },
        consumer: {
          type: "http_call",
          signature: "GET /a",
          repo: "ghost",
          file: "ghost/c.ts",
          line: 1,
        },
        matchReason: "signature",
      },
      {
        producer: {
          type: "http_route",
          signature: "GET /b",
          repo: "api",
          file: "api/s.ts",
          line: 2,
        },
        consumer: {
          type: "http_call",
          signature: "GET /b",
          repo: "web",
          file: "web/c.ts",
          line: 1,
        },
        matchReason: "signature",
      },
    ],
    computedAt: "2026-05-01T00:00:00.000Z",
  };
  await withHarness(
    // Group descriptor only lists api + web (ghost never registered).
    { groupName: "stack", repos: ["api", "web"], registry: fixture },
    async (ctx, server) => {
      registerGroupCrossRepoLinksTool(server, ctx);
      const handler = getHandler(server, "group_cross_repo_links");
      const result = await handler({ groupName: "stack" }, {});
      const sc = result.structuredContent as { links: readonly CrossRepoLink[] };
      // Only the (api ↔ web) pair survives. 2 relations → 2 links.
      assert.equal(sc.links.length, 2);
    },
  );
});
