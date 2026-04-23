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
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const RouteMapInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
  route: z.string().optional().describe("Substring match against Route.url (e.g. '/api/users')."),
  method: z.string().optional().describe("Exact match against Route.method (e.g. 'GET')."),
  framework: z
    .string()
    .optional()
    .describe("Reserved for a future framework filter; currently ignored."),
};

interface RouteRow {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly filePath: string;
  readonly responseKeys: readonly string[];
  readonly handlers: readonly string[];
  readonly consumers: readonly string[];
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
    async (args) => {
      return withStore(ctx, args.repo, async (store, resolved) => {
        try {
          const clauses: string[] = ["kind = 'Route'"];
          const params: (string | number)[] = [];
          if (args.route !== undefined && args.route.length > 0) {
            clauses.push("url LIKE ?");
            params.push(`%${args.route}%`);
          }
          if (args.method !== undefined && args.method.length > 0) {
            clauses.push("method = ?");
            params.push(args.method);
          }
          const sql = `SELECT id, name, method, url, file_path, response_keys FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY url, method LIMIT 500`;
          const raw = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;

          const routes: RouteRow[] = [];
          for (const r of raw) {
            const routeId = String(r["id"]);
            const [handlers, consumers] = await Promise.all([
              fetchRelationFromIds(store, routeId, "HANDLES_ROUTE"),
              fetchRelationFromIds(store, routeId, "FETCHES"),
            ]);
            routes.push({
              id: routeId,
              url: stringOr(r["url"], ""),
              method: stringOr(r["method"], ""),
              filePath: stringOr(r["file_path"], ""),
              responseKeys: stringArray(r["response_keys"]),
              handlers,
              consumers,
            });
          }

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
    },
  );
}

async function fetchRelationFromIds(
  store: import("@opencodehub/storage").DuckDbStore,
  routeId: string,
  type: string,
): Promise<readonly string[]> {
  const rows = (await store.query(
    "SELECT from_id FROM relations WHERE to_id = ? AND type = ? ORDER BY from_id",
    [routeId, type],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map((r) => String(r["from_id"] ?? "")).filter((s) => s.length > 0);
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function stringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}
