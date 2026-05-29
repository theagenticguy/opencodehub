/**
 * `codehub route-map` — map HTTP Route nodes to handlers + consumers.
 *
 * CLI sibling of the MCP `route_map` tool. Both surfaces call the shared
 * `listRouteMap` fn from `@opencodehub/analysis`, which lists Route nodes
 * (limit:500 cap, two-stage method handling) and pulls each route's
 * HANDLES_ROUTE handlers and FETCHES consumers.
 *
 * Mirrors `packages/mcp/src/tools/route-map.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 */

import { listRouteMap } from "@opencodehub/analysis";
import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface RouteMapOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly route?: string;
  readonly method?: string;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

export async function runRouteMap(opts: RouteMapOptions = {}): Promise<void> {
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const routes = await listRouteMap(store.graph, {
      ...(opts.route !== undefined ? { route: opts.route } : {}),
      ...(opts.method !== undefined ? { method: opts.method } : {}),
    });

    if (opts.json) {
      console.log(JSON.stringify({ routes, total: routes.length }, null, 2));
      return;
    }

    console.warn(
      `route-map: ${routes.length} route(s)${opts.route ? ` · url~${opts.route}` : ""}${
        opts.method ? ` · method=${opts.method}` : ""
      }:`,
    );
    if (routes.length === 0) {
      console.log("(no routes matched — verify the `routes` phase ran on a supported framework)");
      return;
    }
    for (const r of routes) {
      console.log(
        `${r.method} ${r.url}  handlers=${r.handlers.length} consumers=${r.consumers.length} keys=${r.responseKeys.length}`,
      );
    }
  } finally {
    await store.close();
  }
}
