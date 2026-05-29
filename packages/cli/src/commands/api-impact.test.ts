/**
 * Tests for `codehub api-impact` CLI command.
 *
 * The command calls the shared `listApiImpact` fn from
 * `@opencodehub/analysis` (the same impl the MCP `api_impact` tool uses). The
 * fake graph supplies a Route, a FETCHES consumer symbol, and that symbol's
 * file so the consumer count + risk band are exercised end-to-end.
 *
 * Covers:
 *   - A single consumer with no shape mismatch → risk=MEDIUM in JSON.
 *   - The `highestRisk` aggregate reflects the worst route.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CodeRelation,
  GraphNode,
  NodeId,
  RelationType,
  RouteNode,
} from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, ListNodesOptions, Store } from "@opencodehub/storage";
import { runApiImpact } from "./api-impact.js";

function route(
  over: Omit<Partial<RouteNode>, "id" | "url"> & { id: string; url: string },
): RouteNode {
  return {
    kind: "Route",
    method: "GET",
    filePath: "src/routes.ts",
    responseKeys: [],
    ...over,
  } as unknown as RouteNode;
}

function edge(from: string, to: string, type: RelationType): CodeRelation {
  return { from: from as NodeId, to: to as NodeId, type, confidence: 1 } as CodeRelation;
}

function node(id: string, kind: string, filePath: string, name = ""): GraphNode {
  return { id: id as NodeId, kind, name, filePath } as unknown as GraphNode;
}

function makeFakeStore(
  routes: readonly RouteNode[],
  edges: readonly CodeRelation[],
  nodes: readonly GraphNode[],
): { store: Store; closed: () => boolean } {
  let closed = false;
  const graph: Partial<IGraphStore> = {
    listRoutes: async (opts) => {
      let out = [...routes];
      if (opts?.pathLike !== undefined)
        out = out.filter((r) => r.url.includes(opts.pathLike as string));
      return out;
    },
    listEdgesByType: async (type, opts) => {
      const to = opts?.toIds?.[0];
      return edges.filter((e) => e.type === type && (to === undefined || e.to === to));
    },
    listNodes: async (opts: ListNodesOptions = {}) => {
      if (opts.ids === undefined) return nodes;
      const ids = new Set(opts.ids.map(String));
      return nodes.filter((n) => ids.has(n.id));
    },
  };
  const store = {
    graph: graph as unknown as IGraphStore,
    temporal: {} as unknown as ITemporalStore,
    graphFile: "/tmp/fake.lbug",
    temporalFile: "/tmp/fake.duckdb",
    close: async () => {
      closed = true;
    },
  } as Store;
  return { store, closed: () => closed };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

test("api-impact --json scores a single-consumer route as MEDIUM", async () => {
  const { store, closed } = makeFakeStore(
    [route({ id: "Route:GET:/users", url: "/users" })],
    [edge("Function:caller", "Route:GET:/users", "FETCHES")],
    [node("Function:caller", "Function", "src/caller.ts", "caller")],
  );
  const out = await captureStdout(async () => {
    await runApiImpact({
      json: true,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as {
    routes: Array<{ risk: string; consumers: string[] }>;
    highestRisk: string;
  };
  assert.equal(parsed.routes.length, 1);
  assert.equal(parsed.routes[0]?.risk, "MEDIUM");
  assert.deepEqual(parsed.routes[0]?.consumers, ["src/caller.ts"]);
  assert.equal(parsed.highestRisk, "MEDIUM");
  assert.ok(closed(), "store must be closed");
});

test("api-impact --json reports LOW for a route with no consumers", async () => {
  const { store } = makeFakeStore([route({ id: "Route:GET:/health", url: "/health" })], [], []);
  const out = await captureStdout(async () => {
    await runApiImpact({
      json: true,
      storeFactory: async () => ({ store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as { routes: Array<{ risk: string }>; highestRisk: string };
  assert.equal(parsed.routes[0]?.risk, "LOW");
  assert.equal(parsed.highestRisk, "LOW");
});
