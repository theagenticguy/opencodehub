/**
 * `listApiImpact` — score the blast radius of changing a Route's contract.
 *
 * For every Route matching the filter (`route` substring, or `file`
 * substring against Route.filePath) we compute:
 *   - consumers           = files with outgoing FETCHES → this Route.
 *   - middleware          = handlers reached via HANDLES_ROUTE (typically
 *                           File ids; Operation ids when the OpenAPI
 *                           phase linked a spec).
 *   - mismatches          = consumer files whose accessed keys are not a
 *                           subset of Route.responseKeys (delegated to
 *                           `classifyShape`).
 *   - affectedProcesses   = Process nodes whose PROCESS_STEP edges walk
 *                           through any of the consumer symbols.
 *
 * Risk banding (deterministic):
 *   LOW      — 0 consumers and 0 mismatches.
 *   MEDIUM   — 1-4 consumers, 0 mismatches.
 *   HIGH     — 5-19 consumers OR any mismatch.
 *   CRITICAL — ≥ 20 consumers.
 *
 * Lifted verbatim from the MCP `api_impact` tool so the MCP surface and the
 * `codehub api-impact` CLI command share one impl. Reuses the
 * already-exported {@link RiskLevel} union rather than introducing a second
 * `Risk` name.
 */

import type { GraphNode, RouteNode } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import { classifyShape } from "./shape.js";
import type { RiskLevel } from "./types.js";

export interface ApiImpactRow {
  readonly route: {
    readonly id: string;
    readonly url: string;
    readonly method: string;
    readonly filePath: string;
  };
  readonly risk: RiskLevel;
  readonly consumers: readonly string[];
  readonly middleware: readonly string[];
  readonly mismatches: readonly string[];
  readonly affectedProcesses: readonly string[];
}

export interface ApiImpactFilter {
  readonly route?: string | undefined;
  readonly file?: string | undefined;
}

export async function listApiImpact(
  graph: IGraphStore,
  filter: ApiImpactFilter = {},
): Promise<readonly ApiImpactRow[]> {
  const opts: { pathLike?: string; limit?: number } = { limit: 500 };
  if (filter.route !== undefined && filter.route.length > 0) opts.pathLike = filter.route;
  let routes: readonly RouteNode[] = await graph.listRoutes(opts);
  if (filter.file !== undefined && filter.file.length > 0) {
    const sub = filter.file;
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

export function scoreRisk(consumers: number, mismatches: number): RiskLevel {
  if (consumers >= 20) return "CRITICAL";
  if (consumers >= 5 || mismatches > 0) return "HIGH";
  if (consumers >= 1) return "MEDIUM";
  return "LOW";
}

export function worseRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
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
