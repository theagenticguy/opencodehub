/**
 * Tests for `codehub route-map` CLI command.
 *
 * The command calls the shared `listRouteMap` fn from `@opencodehub/analysis`
 * (the same impl the MCP `route_map` tool uses). The fake graph supplies
 * Route nodes plus HANDLES_ROUTE / FETCHES edges.
 *
 * Covers:
 *   - JSON mode emits a `{ routes, total }` payload with handlers/consumers.
 *   - A non-standard method (not in the five-verb set) is handled by the
 *     two-stage TS post-filter.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeRelation, NodeId, RelationType, RouteNode } from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, ListRoutesOptions, Store } from "@opencodehub/storage";
import { runRouteMap } from "./route-map.js";

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

interface FakeHandle {
  closed: boolean;
  lastRoutesOpts?: ListRoutesOptions;
  store: Store;
}

function makeFakeStore(routes: readonly RouteNode[], edges: readonly CodeRelation[]): FakeHandle {
  const handle: FakeHandle = { closed: false, store: {} as Store };
  const graph: Partial<IGraphStore> = {
    listRoutes: async (opts: ListRoutesOptions = {}) => {
      handle.lastRoutesOpts = opts;
      let out = [...routes];
      if (opts.methods !== undefined) {
        const set = new Set(opts.methods);
        out = out.filter((r) => r.method !== undefined && set.has(r.method as "GET"));
      }
      if (opts.pathLike !== undefined)
        out = out.filter((r) => r.url.includes(opts.pathLike as string));
      return out;
    },
    listEdgesByType: async (type, opts) => {
      const to = opts?.toIds?.[0];
      return edges.filter((e) => e.type === type && (to === undefined || e.to === to));
    },
  };
  handle.store = {
    graph: graph as unknown as IGraphStore,
    temporal: {} as unknown as ITemporalStore,
    graphFile: "/tmp/fake.lbug",
    temporalFile: "/tmp/fake.duckdb",
    close: async () => {
      handle.closed = true;
    },
  } as Store;
  return handle;
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

test("route-map --json emits routes with handlers and consumers", async () => {
  const handle = makeFakeStore(
    [route({ id: "Route:GET:/users", url: "/users", method: "GET" })],
    [
      edge("File:handler.ts", "Route:GET:/users", "HANDLES_ROUTE"),
      edge("Function:caller", "Route:GET:/users", "FETCHES"),
    ],
  );
  const out = await captureStdout(async () => {
    await runRouteMap({
      json: true,
      storeFactory: async () => ({ store: handle.store, repoPath: "/tmp/r" }),
    });
  });
  const parsed = JSON.parse(out) as {
    routes: Array<{ url: string; handlers: string[]; consumers: string[] }>;
    total: number;
  };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.routes[0]?.url, "/users");
  assert.deepEqual(parsed.routes[0]?.handlers, ["File:handler.ts"]);
  assert.deepEqual(parsed.routes[0]?.consumers, ["Function:caller"]);
  assert.ok(handle.closed, "store must be closed");
});

test("route-map non-standard method uses the two-stage TS post-filter", async () => {
  const handle = makeFakeStore(
    [
      route({ id: "Route:HEAD:/ping", url: "/ping", method: "HEAD" }),
      route({ id: "Route:GET:/ping", url: "/ping", method: "GET" }),
    ],
    [],
  );
  const out = await captureStdout(async () => {
    await runRouteMap({
      json: true,
      method: "HEAD",
      storeFactory: async () => ({ store: handle.store, repoPath: "/tmp/r" }),
    });
  });
  // HEAD is not one of the five verbs → must NOT be pushed to listRoutes.methods.
  assert.equal(handle.lastRoutesOpts?.methods, undefined);
  const parsed = JSON.parse(out) as { routes: Array<{ method: string }>; total: number };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.routes[0]?.method, "HEAD");
});
