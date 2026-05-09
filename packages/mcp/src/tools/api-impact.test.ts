// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeEdgeLike,
  type FakeNodeLike,
  type FakeRoute,
  getToolHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import { registerApiImpactTool } from "./api-impact.js";
import type { ToolContext } from "./shared.js";

interface RouteFx {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly filePath: string;
  readonly responseKeys: readonly string[];
}
interface NodeFx {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly filePath: string;
}
interface RelFx {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
}

interface Fixture {
  readonly routes: readonly RouteFx[];
  readonly nodes: readonly NodeFx[];
  readonly relations: readonly RelFx[];
}

/**
 * Build the {nodes, edges, routes} bag the typed-finder fake reads.
 * Routes are surfaced as both Route-kind GraphNodes (so `listNodes({ids})`
 * sees the partner data when downstream finders walk consumers) and as
 * `routes` entries that `listRoutes` projects directly.
 */
function toFakeData(data: Fixture): {
  nodes: FakeNodeLike[];
  edges: FakeEdgeLike[];
  routes: FakeRoute[];
} {
  const nodes: FakeNodeLike[] = data.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    filePath: n.filePath,
  }));
  // Surface Route nodes too, so any path that asks listNodes({ ids: [routeId] })
  // gets a partner row back. Not required by the current production code but
  // future-proof.
  for (const r of data.routes) {
    nodes.push({
      id: r.id,
      kind: "Route",
      name: r.url,
      filePath: r.filePath,
      url: r.url,
      method: r.method,
      responseKeys: [...r.responseKeys],
    });
  }
  const edges: FakeEdgeLike[] = data.relations.map((r) => ({
    type: r.type,
    fromId: r.fromId,
    toId: r.toId,
  }));
  const routes = data.routes.map((r) => ({
    id: r.id,
    kind: "Route" as const,
    name: r.url,
    filePath: r.filePath,
    url: r.url,
    method: r.method,
    responseKeys: [...r.responseKeys],
  }));
  return { nodes, edges, routes };
}

async function withHarness(
  data: Fixture,
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  const fake = toFakeData(data);
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-api-impact-",
      storeFactory: () =>
        makeFakeGraphStore({ nodes: fake.nodes, edges: fake.edges, routes: fake.routes }),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
}

test("api_impact scores LOW for route with zero consumers", async () => {
  const data: Fixture = {
    routes: [
      {
        id: "Route:r",
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: [],
    relations: [],
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getToolHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
        consumers: string[];
        mismatches: string[];
      }>;
    };
    assert.equal(sc.routes[0]?.risk, "LOW");
    assert.equal(sc.routes[0]?.consumers.length, 0);
  });
});

test("api_impact scores MEDIUM for 1-4 consumers with no mismatch", async () => {
  const routeId = "Route:r";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: [
      { id: "Function:c1", kind: "Function", name: "c1", filePath: "c1.ts" },
      { id: "Function:c2", kind: "Function", name: "c2", filePath: "c2.ts" },
      { id: "Property:id", kind: "Property", name: "id", filePath: "c1.ts" },
    ],
    relations: [
      { fromId: "Function:c1", toId: routeId, type: "FETCHES" },
      { fromId: "Function:c2", toId: routeId, type: "FETCHES" },
      { fromId: "Function:c1", toId: "Property:id", type: "ACCESSES" },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getToolHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        risk: string;
        consumers: string[];
        mismatches: string[];
      }>;
    };
    assert.equal(sc.routes[0]?.risk, "MEDIUM");
    assert.equal(sc.routes[0]?.consumers.length, 2);
    assert.equal(sc.routes[0]?.mismatches.length, 0);
  });
});

test("api_impact scores HIGH when there is any mismatch", async () => {
  const routeId = "Route:r";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: [
      { id: "Function:c1", kind: "Function", name: "c1", filePath: "c1.ts" },
      { id: "Property:ghost", kind: "Property", name: "ghost", filePath: "c1.ts" },
    ],
    relations: [
      { fromId: "Function:c1", toId: routeId, type: "FETCHES" },
      { fromId: "Function:c1", toId: "Property:ghost", type: "ACCESSES" },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getToolHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ risk: string; mismatches: string[] }>;
    };
    assert.equal(sc.routes[0]?.risk, "HIGH");
    assert.equal(sc.routes[0]?.mismatches.length, 1);
  });
});

test("api_impact scores CRITICAL at 20+ consumers", async () => {
  const routeId = "Route:r";
  const consumers = Array.from({ length: 22 }, (_, i) => ({
    id: `Function:c${i}`,
    kind: "Function",
    name: `c${i}`,
    filePath: `f${i}.ts`,
  }));
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/a",
        method: "GET",
        filePath: "a.ts",
        responseKeys: ["id"],
      },
    ],
    nodes: consumers,
    relations: consumers.map((c) => ({
      fromId: c.id,
      toId: routeId,
      type: "FETCHES",
    })),
  };
  await withHarness(data, async (ctx, server) => {
    registerApiImpactTool(server, ctx);
    const handler = getToolHandler(server, "api_impact");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ risk: string; consumers: string[] }>;
    };
    assert.equal(sc.routes[0]?.risk, "CRITICAL");
    assert.equal(sc.routes[0]?.consumers.length, 22);
  });
});
