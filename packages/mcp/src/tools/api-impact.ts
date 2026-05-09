/**
 * `api_impact` — score the blast radius of changing a Route's contract.
 *
 * For every Route matching the filter (`route` substring, or `file`
 * substring against Route.filePath) we compute:
 *   - consumers           = files with outgoing FETCHES → this Route.
 *   - middleware          = handlers reached via HANDLES_ROUTE (typically
 *                           File ids; Operation ids when the OpenAPI
 *                           phase linked a spec).
 *   - mismatches          = consumer files whose accessed keys are not a
 *                           subset of Route.responseKeys (delegated to
 *                           `classifyShape` from shape-check).
 *   - affectedProcesses   = Process nodes whose PROCESS_STEP edges walk
 *                           through any of the consumer symbols.
 *
 * Risk banding (deterministic):
 *   LOW      — 0 consumers and 0 mismatches.
 *   MEDIUM   — 1-4 consumers, 0 mismatches.
 *   HIGH     — 5-19 consumers OR any mismatch.
 *   CRITICAL — ≥ 20 consumers.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphNode, RouteNode } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { classifyShape } from "./shape-check.js";
import {
  fromToolResult,
  repoArgShape,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const ApiImpactInput = {
  ...repoArgShape,
  route: z.string().optional().describe("Substring match against Route.url."),
  file: z.string().optional().describe("Substring match against Route.filePath."),
};

export type Risk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ApiImpactRow {
  readonly route: {
    readonly id: string;
    readonly url: string;
    readonly method: string;
    readonly filePath: string;
  };
  readonly risk: Risk;
  readonly consumers: readonly string[];
  readonly middleware: readonly string[];
  readonly mismatches: readonly string[];
  readonly affectedProcesses: readonly string[];
}

interface ApiImpactArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly route?: string | undefined;
  readonly file?: string | undefined;
}

export async function runApiImpact(ctx: ToolContext, args: ApiImpactArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const rows = await analyzeApiImpact(store.graph, args.route, args.file);

      const header = `api_impact — ${rows.length} route(s) for ${resolved.name}${
        args.route ? ` · url~${args.route}` : ""
      }${args.file ? ` · filePath~${args.file}` : ""}:`;
      const body =
        rows.length === 0
          ? "(no routes matched — check the filter or re-index with `codehub analyze`)"
          : rows
              .map(
                (r) =>
                  `- [${r.risk}] ${r.route.method} ${r.route.url} consumers=${r.consumers.length} mismatches=${r.mismatches.length} processes=${r.affectedProcesses.length}`,
              )
              .join("\n");

      const highest = rows.reduce<Risk>((acc, r) => worseRisk(acc, r.risk), "LOW");
      const next =
        rows.length === 0
          ? ["call `route_map` to list available routes"]
          : highest === "CRITICAL" || highest === "HIGH"
            ? [
                `call \`shape_check\` with route="${rows[0]?.route.url ?? ""}" to see per-consumer mismatches`,
                `call \`context\` on a consumer file to plan migration`,
              ]
            : [
                "low blast radius — route change should be safe",
                "still verify with `shape_check` before merging",
              ];

      return withNextSteps(
        `${header}\n${body}`,
        { routes: rows, highestRisk: highest },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerApiImpactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "api_impact",
    {
      title: "Route change blast radius",
      description:
        "Score the blast radius of changing a Route's contract. Returns risk (LOW/MEDIUM/HIGH/CRITICAL) plus the consumer files, middleware handlers, shape mismatches, and affected Process flows for every matching Route. Read-only.",
      inputSchema: ApiImpactInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runApiImpact(ctx, args)),
  );
}

async function analyzeApiImpact(
  graph: IGraphStore,
  routeFilter: string | undefined,
  fileFilter: string | undefined,
): Promise<readonly ApiImpactRow[]> {
  const opts: { pathLike?: string; limit?: number } = { limit: 500 };
  if (routeFilter !== undefined && routeFilter.length > 0) opts.pathLike = routeFilter;
  let routes: readonly RouteNode[] = await graph.listRoutes(opts);
  if (fileFilter !== undefined && fileFilter.length > 0) {
    const sub = fileFilter;
    routes = routes.filter((r) => r.filePath.includes(sub));
  }
  const sorted = [...routes].sort((a, b) => {
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    const am = a.method ?? "";
    const bm = b.method ?? "";
    return am < bm ? -1 : am > bm ? 1 : 0;
  });

  const out: ApiImpactRow[] = [];
  for (const r of sorted) {
    const responseKeys = r.responseKeys ?? [];

    const [consumerSymbolIds, handlers] = await Promise.all([
      fetchFromIds(graph, r.id, "FETCHES"),
      fetchFromIds(graph, r.id, "HANDLES_ROUTE"),
    ]);

    const consumerFiles = await resolveFiles(graph, consumerSymbolIds);

    const mismatches: string[] = [];
    for (const file of consumerFiles) {
      const accessedKeys = await collectAccessedKeys(graph, file);
      const { status } = classifyShape(accessedKeys, responseKeys);
      if (status === "MISMATCH") mismatches.push(file);
    }

    const affectedProcesses = await fetchAffectedProcesses(graph, consumerSymbolIds);

    const risk = scoreRisk(consumerFiles.length, mismatches.length);
    out.push({
      route: { id: r.id, url: r.url, method: r.method ?? "", filePath: r.filePath },
      risk,
      consumers: consumerFiles,
      middleware: handlers,
      mismatches,
      affectedProcesses,
    });
  }
  return out;
}

function scoreRisk(consumers: number, mismatches: number): Risk {
  if (consumers >= 20) return "CRITICAL";
  if (consumers >= 5 || mismatches > 0) return "HIGH";
  if (consumers >= 1) return "MEDIUM";
  return "LOW";
}

function worseRisk(a: Risk, b: Risk): Risk {
  const order: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  return order[a] >= order[b] ? a : b;
}

async function fetchFromIds(
  graph: IGraphStore,
  targetId: string,
  type: "FETCHES" | "HANDLES_ROUTE",
): Promise<readonly string[]> {
  const edges = await graph.listEdgesByType(type, { toIds: [targetId] });
  return edges
    .map((e) => e.from)
    .filter((s) => s.length > 0)
    .sort();
}

async function resolveFiles(
  graph: IGraphStore,
  nodeIds: readonly string[],
): Promise<readonly string[]> {
  if (nodeIds.length === 0) return [];
  const partners = await graph.listNodes({ ids: [...nodeIds] });
  const set = new Set<string>();
  for (const n of partners) {
    if (n.filePath && n.filePath.length > 0) set.add(n.filePath);
  }
  return Array.from(set).sort();
}

async function collectAccessedKeys(graph: IGraphStore, file: string): Promise<readonly string[]> {
  const edges = await graph.listEdgesByType("ACCESSES");
  if (edges.length === 0) return [];
  const allIds = new Set<string>();
  for (const e of edges) {
    allIds.add(e.from);
    allIds.add(e.to);
  }
  const allNodes = await graph.listNodes({ ids: [...allIds] });
  const byId = new Map<string, GraphNode>();
  for (const n of allNodes) byId.set(n.id, n);
  const names = new Set<string>();
  for (const e of edges) {
    const src = byId.get(e.from);
    if (!src || src.filePath !== file) continue;
    const target = byId.get(e.to);
    if (!target || target.kind !== "Property") continue;
    if (target.name && target.name.length > 0) names.add(target.name);
  }
  return Array.from(names).sort();
}

async function fetchAffectedProcesses(
  graph: IGraphStore,
  consumerSymbolIds: readonly string[],
): Promise<readonly string[]> {
  if (consumerSymbolIds.length === 0) return [];
  const targetSet = new Set(consumerSymbolIds);
  const edges = await graph.listEdgesByType("PROCESS_STEP");
  const procIds = new Set<string>();
  for (const e of edges) {
    if (!targetSet.has(e.to)) continue;
    procIds.add(e.from);
  }
  if (procIds.size === 0) return [];
  const partners = await graph.listNodes({ ids: [...procIds] });
  const out: string[] = [];
  for (const n of partners) {
    if (n.kind === "Process") out.push(n.id);
  }
  return out.sort();
}
