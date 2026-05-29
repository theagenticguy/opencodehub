/**
 * `shape_check` — compare a Route's static responseKeys against the
 * property names each consumer file actually reads off the response.
 *
 * For every Route matching `route` (URL substring) we:
 *   1. Find FETCHES edges pointing AT the route. Each `from_id` is a
 *      symbol (Function / Method / Constructor) that issued the call.
 *   2. Group those consumer symbols by file.
 *   3. Walk outgoing ACCESSES from every symbol in each consumer file to
 *      its Property target; collect Property.name as the accessed key.
 *   4. Compare that set against Route.responseKeys (populated by the
 *      `routes` phase when the response literal was statically known).
 *
 * Per-consumer status:
 *   - MATCH    — every accessed key is in responseKeys.
 *   - MISMATCH — at least one accessed key is NOT in responseKeys.
 *   - PARTIAL  — no accessed keys found (can't check).
 *
 * `classifyShape` now lives in `@opencodehub/analysis` (so `api_impact` and
 * the CLI surface can reuse it) and is re-exported here for backward compat.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { classifyShape, type ShapeStatus } from "@opencodehub/analysis";
import type { CodeRelation, GraphNode } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
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

export type { ShapeStatus };
// Re-export so callers that imported `classifyShape` / `ShapeStatus` from
// this module keep working after the lift into @opencodehub/analysis.
export { classifyShape };

const ShapeCheckInput = {
  ...repoArgShape,
  route: z.string().optional().describe("Substring match against Route.url."),
};

export interface ConsumerShape {
  readonly file: string;
  readonly accessedKeys: readonly string[];
  readonly status: ShapeStatus;
  readonly missing: readonly string[];
}

export interface RouteShape {
  readonly url: string;
  readonly method: string;
  readonly responseKeys: readonly string[];
  readonly consumers: readonly ConsumerShape[];
}

interface ShapeCheckArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly route?: string | undefined;
}

export async function runShapeCheck(ctx: ToolContext, args: ShapeCheckArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const routes = await loadRouteShapes(store.graph, args.route);

      const header = `shape_check — ${routes.length} route(s) for ${resolved.name}${
        args.route ? ` · url~${args.route}` : ""
      }:`;
      const lines: string[] = [header];
      let mismatchTotal = 0;
      for (const r of routes) {
        lines.push(`${r.method} ${r.url} keys=${r.responseKeys.length}`);
        for (const c of r.consumers) {
          if (c.status === "MISMATCH") mismatchTotal += 1;
          const miss = c.missing.length > 0 ? ` missing=[${c.missing.join(",")}]` : "";
          lines.push(`  [${c.status}] ${c.file} accessed=${c.accessedKeys.length}${miss}`);
        }
      }
      if (routes.length === 0) {
        lines.push("(no routes matched — check the url filter)");
      }

      const next =
        routes.length === 0
          ? ["call `route_map` with the same filter to list available routes"]
          : mismatchTotal > 0
            ? [
                "investigate each MISMATCH — consumer reads a key not in responseKeys",
                "call `context` on the consumer file for upstream callers",
              ]
            : ["no mismatches — consumer shape matches Route.responseKeys"];

      return withNextSteps(lines.join("\n"), { routes }, next, stalenessFromMeta(resolved.meta));
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerShapeCheckTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "shape_check",
    {
      title: "Route response-shape mismatch check",
      description:
        "For each Route matching the filter, walk ACCESSES edges from the consumer files that FETCH this route and compare accessed property names against Route.responseKeys. Returns MATCH / MISMATCH / PARTIAL per consumer. Read-only.",
      inputSchema: ShapeCheckInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runShapeCheck(ctx, args)),
  );
}

/** Load every Route matching the filter and classify each consumer file. */
export async function loadRouteShapes(
  graph: IGraphStore,
  routeFilter: string | undefined,
): Promise<readonly RouteShape[]> {
  const opts: { pathLike?: string; limit?: number } = { limit: 500 };
  if (routeFilter !== undefined && routeFilter.length > 0) opts.pathLike = routeFilter;
  const listed = await graph.listRoutes(opts);
  const sorted = [...listed].sort((a, b) => {
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    const am = a.method ?? "";
    const bm = b.method ?? "";
    return am < bm ? -1 : am > bm ? 1 : 0;
  });
  const accessesEdges = await graph.listEdgesByType("ACCESSES");

  const routes: RouteShape[] = [];
  for (const r of sorted) {
    const responseKeys = r.responseKeys ?? [];
    const consumers = await collectConsumerShapes(graph, accessesEdges, r.id, responseKeys);
    routes.push({ url: r.url, method: r.method ?? "", responseKeys, consumers });
  }
  return routes;
}

async function collectConsumerShapes(
  graph: IGraphStore,
  accessesEdges: readonly CodeRelation[],
  routeId: string,
  responseKeys: readonly string[],
): Promise<readonly ConsumerShape[]> {
  const fetches = await graph.listEdgesByType("FETCHES", { toIds: [routeId] });
  const consumerSymbolIds = fetches
    .map((e) => e.from)
    .filter((s) => s.length > 0)
    .sort();
  if (consumerSymbolIds.length === 0) return [];

  const consumerSymbols = await graph.listNodes({ ids: consumerSymbolIds });
  const consumerById = new Map<string, GraphNode>();
  for (const n of consumerSymbols) consumerById.set(n.id, n);

  const consumerFiles = new Set<string>();
  for (const sid of consumerSymbolIds) {
    const n = consumerById.get(sid);
    if (n && n.filePath.length > 0) consumerFiles.add(n.filePath);
  }

  // Snapshot all nodes referenced by ACCESSES edges so per-file walks
  // don't fan out per-iteration.
  const accessedIds = new Set<string>();
  for (const e of accessesEdges) {
    accessedIds.add(e.from);
    accessedIds.add(e.to);
  }
  const accessedNodes =
    accessedIds.size > 0 ? await graph.listNodes({ ids: [...accessedIds] }) : [];
  const accByID = new Map<string, GraphNode>();
  for (const n of accessedNodes) accByID.set(n.id, n);

  const out: ConsumerShape[] = [];
  const sortedFiles = [...consumerFiles].sort();
  for (const file of sortedFiles) {
    const accessedSet = new Set<string>();
    for (const e of accessesEdges) {
      const src = accByID.get(e.from);
      if (!src || src.filePath !== file) continue;
      const target = accByID.get(e.to);
      if (!target || target.kind !== "Property") continue;
      if (target.name && target.name.length > 0) accessedSet.add(target.name);
    }
    const accessedKeys = Array.from(accessedSet).sort();
    const { status, missing } = classifyShape(accessedKeys, responseKeys);
    out.push({ file, accessedKeys, status, missing });
  }
  return out;
}
