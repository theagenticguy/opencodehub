/**
 * `listRouteMap` — enumerate HTTP `Route` nodes with handlers + consumers.
 *
 * One row per Route, filtered by optional route URL substring / method.
 * For every row we also pull:
 *   - handlers  = ids of nodes pointing at the route via HANDLES_ROUTE
 *                 (typically Files for framework routes, Operations for
 *                 OpenAPI specs).
 *   - consumers = ids of nodes pointing at the route via FETCHES (the
 *                 `from_id` side — the symbol doing the outbound call).
 *   - responseKeys = the TEXT[] response-shape keys populated by the
 *                    `routes` phase when static detection identified the
 *                    response body.
 *
 * Lifted verbatim from the MCP `route_map` tool so the MCP surface and the
 * `codehub route-map` CLI command share one impl. The two-stage method
 * handling (push a typed method into `listRoutes` when it is one of the five
 * known verbs, else a TS post-filter) and the `listRoutes` limit:500 cap are
 * preserved exactly.
 */

import type { IGraphStore } from "@opencodehub/storage";

export interface RouteMapRow {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly filePath: string;
  readonly responseKeys: readonly string[];
  readonly handlers: readonly string[];
  readonly consumers: readonly string[];
}

export interface RouteMapFilter {
  readonly route?: string | undefined;
  readonly method?: string | undefined;
}

export async function listRouteMap(
  graph: IGraphStore,
  filter: RouteMapFilter = {},
): Promise<readonly RouteMapRow[]> {
  const opts: {
    pathLike?: string;
    methods?: readonly ("GET" | "POST" | "PUT" | "DELETE" | "PATCH")[];
    limit?: number;
  } = { limit: 500 };
  if (filter.route !== undefined && filter.route.length > 0) opts.pathLike = filter.route;
  if (
    filter.method !== undefined &&
    ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(filter.method)
  ) {
    opts.methods = [filter.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH"];
  }
  let listed = await graph.listRoutes(opts);
  if (
    filter.method !== undefined &&
    !["GET", "POST", "PUT", "DELETE", "PATCH"].includes(filter.method)
  ) {
    listed = listed.filter((r) => r.method === filter.method);
  }
  const sortedRoutes = [...listed].sort((a, b) => {
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    const am = a.method ?? "";
    const bm = b.method ?? "";
    return am < bm ? -1 : am > bm ? 1 : 0;
  });

  const routes: RouteMapRow[] = [];
  for (const r of sortedRoutes) {
    const [handlers, consumers] = await Promise.all([
      fetchRelationFromIds(graph, r.id, "HANDLES_ROUTE"),
      fetchRelationFromIds(graph, r.id, "FETCHES"),
    ]);
    routes.push({
      id: r.id,
      url: stringOr(r.url, ""),
      method: stringOr(r.method, ""),
      filePath: stringOr(r.filePath, ""),
      responseKeys: r.responseKeys ?? [],
      handlers,
      consumers,
    });
  }
  return routes;
}

async function fetchRelationFromIds(
  graph: IGraphStore,
  routeId: string,
  type: "HANDLES_ROUTE" | "FETCHES",
): Promise<readonly string[]> {
  const edges = await graph.listEdgesByType(type, { toIds: [routeId] });
  return edges
    .map((e) => e.from)
    .filter((s) => s.length > 0)
    .sort();
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
