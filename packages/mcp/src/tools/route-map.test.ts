// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeEdgeLike,
  type FakeRoute,
  getToolHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import { registerRouteMapTool } from "./route-map.js";
import type { ToolContext } from "./shared.js";

interface RouteFixture {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly filePath: string;
  readonly responseKeys: readonly string[];
}

interface RelFixture {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
}

interface Fixture {
  readonly routes: readonly RouteFixture[];
  readonly relations: readonly RelFixture[];
}

function toRouteNodes(routes: readonly RouteFixture[]): FakeRoute[] {
  return routes.map((r) => ({
    id: r.id,
    kind: "Route" as const,
    name: `${r.method} ${r.url}`,
    filePath: r.filePath,
    url: r.url,
    method: r.method,
    responseKeys: [...r.responseKeys],
  }));
}

async function withHarness(
  data: Fixture,
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  const edges: FakeEdgeLike[] = data.relations.map((r) => ({
    type: r.type,
    fromId: r.fromId,
    toId: r.toId,
  }));
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-route-map-",
      storeFactory: () => makeFakeGraphStore({ routes: toRouteNodes(data.routes), edges }),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
}

test("route_map returns routes with joined handlers and consumers", async () => {
  const data: Fixture = {
    routes: [
      {
        id: "Route:src/users.ts:GET:/users",
        url: "/users",
        method: "GET",
        filePath: "src/users.ts",
        responseKeys: ["id", "email"],
      },
    ],
    relations: [
      {
        fromId: "File:src/users.ts:src/users.ts",
        toId: "Route:src/users.ts:GET:/users",
        type: "HANDLES_ROUTE",
      },
      {
        fromId: "Function:src/ui.ts:loadUsers",
        toId: "Route:src/users.ts:GET:/users",
        type: "FETCHES",
      },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerRouteMapTool(server, ctx);
    const handler = getToolHandler(server, "route_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        url: string;
        handlers: string[];
        consumers: string[];
        responseKeys: string[];
      }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.routes[0]?.url, "/users");
    assert.deepEqual(sc.routes[0]?.responseKeys, ["id", "email"]);
    assert.deepEqual(sc.routes[0]?.handlers, ["File:src/users.ts:src/users.ts"]);
    assert.deepEqual(sc.routes[0]?.consumers, ["Function:src/ui.ts:loadUsers"]);
  });
});

test("route_map filters by method", async () => {
  const data: Fixture = {
    routes: [
      {
        id: "Route:r1",
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: [],
      },
      {
        id: "Route:r2",
        url: "/b",
        method: "POST",
        filePath: "b.ts",
        responseKeys: [],
      },
    ],
    relations: [],
  };
  await withHarness(data, async (ctx, server) => {
    registerRouteMapTool(server, ctx);
    const handler = getToolHandler(server, "route_map");
    const result = await handler({ repo: "fakerepo", method: "POST" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ method: string; url: string }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.routes[0]?.method, "POST");
    assert.equal(sc.routes[0]?.url, "/b");
  });
});

test("route_map returns empty list with remediation when no routes match", async () => {
  await withHarness({ routes: [], relations: [] }, async (ctx, server) => {
    registerRouteMapTool(server, ctx);
    const handler = getToolHandler(server, "route_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: unknown[];
      total: number;
      next_steps: string[];
    };
    assert.equal(sc.total, 0);
    assert.ok(sc.next_steps.length > 0);
  });
});
