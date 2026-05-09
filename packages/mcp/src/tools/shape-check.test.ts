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
import { classifyShape, registerShapeCheckTool } from "./shape-check.js";
import type { ToolContext } from "./shared.js";

interface RouteFx {
  readonly id: string;
  readonly url: string;
  readonly method: string;
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

async function withHarness(
  data: Fixture,
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  const nodes: FakeNodeLike[] = data.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    filePath: n.filePath,
  }));
  const edges: FakeEdgeLike[] = data.relations.map((r) => ({
    type: r.type,
    fromId: r.fromId,
    toId: r.toId,
  }));
  const routes: FakeRoute[] = data.routes.map((r) => ({
    id: r.id,
    kind: "Route" as const,
    name: r.url,
    filePath: "",
    url: r.url,
    method: r.method,
    responseKeys: [...r.responseKeys],
  }));
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-shape-check-",
      storeFactory: () => makeFakeGraphStore({ nodes, edges, routes }),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
}

test("classifyShape: MATCH, MISMATCH, PARTIAL", () => {
  assert.equal(classifyShape(["id", "email"], ["id", "email", "name"]).status, "MATCH");
  const mis = classifyShape(["id", "ghost"], ["id", "email"]);
  assert.equal(mis.status, "MISMATCH");
  assert.deepEqual(mis.missing, ["ghost"]);
  assert.equal(classifyShape([], ["id"]).status, "PARTIAL");
});

test("shape_check returns MATCH when consumer accesses subset of responseKeys", async () => {
  const routeId = "Route:src/users.ts:GET:/users";
  const consumerSymbol = "Function:src/ui.ts:loadUsers";
  const consumerFile = "src/ui.ts";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/users",
        method: "GET",
        responseKeys: ["id", "email", "name"],
      },
    ],
    nodes: [
      { id: consumerSymbol, kind: "Function", name: "loadUsers", filePath: consumerFile },
      { id: "Property:src/ui.ts:id", kind: "Property", name: "id", filePath: consumerFile },
      { id: "Property:src/ui.ts:email", kind: "Property", name: "email", filePath: consumerFile },
    ],
    relations: [
      { fromId: consumerSymbol, toId: routeId, type: "FETCHES" },
      { fromId: consumerSymbol, toId: "Property:src/ui.ts:id", type: "ACCESSES" },
      {
        fromId: consumerSymbol,
        toId: "Property:src/ui.ts:email",
        type: "ACCESSES",
      },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerShapeCheckTool(server, ctx);
    const handler = getToolHandler(server, "shape_check");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        url: string;
        responseKeys: string[];
        consumers: Array<{
          file: string;
          accessedKeys: string[];
          status: "MATCH" | "MISMATCH" | "PARTIAL";
          missing: string[];
        }>;
      }>;
    };
    assert.equal(sc.routes.length, 1);
    assert.equal(sc.routes[0]?.consumers.length, 1);
    const consumer = sc.routes[0]?.consumers[0];
    assert.equal(consumer?.file, consumerFile);
    assert.equal(consumer?.status, "MATCH");
    assert.deepEqual(consumer?.accessedKeys, ["email", "id"]);
    assert.deepEqual(consumer?.missing, []);
  });
});

test("shape_check returns MISMATCH when consumer reads an unknown key", async () => {
  const routeId = "Route:r";
  const consumerSymbol = "Function:c";
  const consumerFile = "c.ts";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/x",
        method: "GET",
        responseKeys: ["id"],
      },
    ],
    nodes: [
      { id: consumerSymbol, kind: "Function", name: "fn", filePath: consumerFile },
      { id: "Property:ghost", kind: "Property", name: "ghost", filePath: consumerFile },
    ],
    relations: [
      { fromId: consumerSymbol, toId: routeId, type: "FETCHES" },
      { fromId: consumerSymbol, toId: "Property:ghost", type: "ACCESSES" },
    ],
  };
  await withHarness(data, async (ctx, server) => {
    registerShapeCheckTool(server, ctx);
    const handler = getToolHandler(server, "shape_check");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{
        consumers: Array<{ status: string; missing: string[] }>;
      }>;
    };
    assert.equal(sc.routes[0]?.consumers[0]?.status, "MISMATCH");
    assert.deepEqual(sc.routes[0]?.consumers[0]?.missing, ["ghost"]);
  });
});

test("shape_check returns PARTIAL when no ACCESSES from consumer file", async () => {
  const routeId = "Route:r";
  const consumerSymbol = "Function:c";
  const data: Fixture = {
    routes: [
      {
        id: routeId,
        url: "/x",
        method: "GET",
        responseKeys: ["id"],
      },
    ],
    nodes: [{ id: consumerSymbol, kind: "Function", name: "fn", filePath: "c.ts" }],
    relations: [{ fromId: consumerSymbol, toId: routeId, type: "FETCHES" }],
  };
  await withHarness(data, async (ctx, server) => {
    registerShapeCheckTool(server, ctx);
    const handler = getToolHandler(server, "shape_check");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      routes: Array<{ consumers: Array<{ status: string }> }>;
    };
    assert.equal(sc.routes[0]?.consumers[0]?.status, "PARTIAL");
  });
});
