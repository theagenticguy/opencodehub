/**
 * `route_map` — enumerate HTTP `Route` nodes with handlers + consumers.
 *
 * One row per Route, filtered by optional repo / route URL substring /
 * method. For every row we also pull:
 *   - handlers  = ids of nodes pointing at the route via HANDLES_ROUTE
 *                 (typically Files for framework routes, Operations for
 *                 OpenAPI specs).
 *   - consumers = ids of nodes pointing at the route via FETCHES (the
 *                 `from_id` side — the symbol doing the outbound call).
 *   - responseKeys = the TEXT[] response-shape keys populated by the
 *                    `routes` phase when static detection identified the
 *                    response body.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listRouteMap } from "@opencodehub/analysis";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  repoArgShape,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const RouteMapInput = {
  ...repoArgShape,
  route: z.string().optional().describe("Substring match against Route.url (e.g. '/api/users')."),
  method: z.string().optional().describe("Exact match against Route.method (e.g. 'GET')."),
  framework: z
    .string()
    .optional()
    .describe("Reserved for a future framework filter; currently ignored."),
};

interface RouteMapArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly route?: string | undefined;
  readonly method?: string | undefined;
  readonly framework?: string | undefined;
}

export async function runRouteMap(ctx: ToolContext, args: RouteMapArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const routes = await listRouteMap(store.graph, {
        ...(args.route !== undefined ? { route: args.route } : {}),
        ...(args.method !== undefined ? { method: args.method } : {}),
      });

      const header = `Routes (${routes.length}) for ${resolved.name}${
        args.route ? ` · url~${args.route}` : ""
      }${args.method ? ` · method=${args.method}` : ""}:`;
      const body =
        routes.length === 0
          ? "(no routes matched — verify the `routes` phase ran on a supported framework)"
          : routes
              .map(
                (r) =>
                  `- ${r.method} ${r.url}  handlers=${r.handlers.length} consumers=${r.consumers.length} keys=${r.responseKeys.length}`,
              )
              .join("\n");

      const next =
        routes.length === 0
          ? [
              "call `list_repos` to confirm the repo is indexed",
              "re-index with `codehub analyze` to emit Route nodes",
            ]
          : [
              `call \`api_impact\` with route="${routes[0]?.url ?? ""}" to score blast radius`,
              `call \`shape_check\` with route="${routes[0]?.url ?? ""}" to compare responseKeys vs consumer ACCESSES`,
            ];

      return withNextSteps(
        `${header}\n${body}`,
        { routes, total: routes.length },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerRouteMapTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "route_map",
    {
      title: "Map HTTP routes to handlers and consumers",
      description:
        "Enumerate Route nodes filtered by url substring and/or method. For each route returns the static responseKeys (when detected), the HANDLES_ROUTE handlers (Files or Operations pointing at the route), and the FETCHES consumers (caller symbols). Read-only.",
      inputSchema: RouteMapInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runRouteMap(ctx, args)),
  );
}
