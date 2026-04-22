/**
 * Routes phase — materialises HTTP route metadata emitted by the static
 * detectors (Next.js App Router + Express) as graph nodes and edges.
 *
 * The phase:
 *   1. Feeds the scanned TypeScript/JavaScript files through
 *      `detectNextJsRoutes` and `detectExpressRoutes`.
 *   2. Creates one `Route` node per unique `(url, method)` pair, keyed by
 *      the handler file so two frameworks declaring the same URL on the
 *      same file reuse the node.
 *   3. Emits `HANDLES_ROUTE` edges from the declaring File node to the
 *      Route node with a fixed confidence of 0.9.
 *   4. Detects cross-file duplicates for the same `(url, method)` and
 *      surfaces them as warnings via the progress callback — but keeps
 *      one edge per handler file (the route *is* re-declared).
 *
 * Depends on parse only to enforce DAG ordering relative to the file-level
 * providers; route detection itself does not consume parse output at MVP.
 */

import { promises as fs } from "node:fs";
import type { RouteNode } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import {
  detectExpressRoutes,
  detectNextJsRoutes,
  populateNextJsResponseKeys,
} from "../../extract/route-detector.js";
import type { ExtractedRoute } from "../../extract/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

/** Extensions that could plausibly host a Next.js route or Express code. */
const JS_TS_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export interface RoutesOutput {
  readonly routeCount: number;
  readonly duplicateCount: number;
}

export const ROUTES_PHASE_NAME = "routes";

export const routesPhase: PipelinePhase<RoutesOutput> = {
  name: ROUTES_PHASE_NAME,
  deps: [PARSE_PHASE_NAME],
  async run(ctx) {
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("routes: scan output missing from phase outputs");
    }
    return runRoutes(ctx, scan);
  },
};

async function runRoutes(ctx: PipelineContext, scan: ScanOutput): Promise<RoutesOutput> {
  const candidates = scan.files.filter((f) => JS_TS_EXTS.has(extLower(f.relPath)));

  // Read once; both detectors receive the same buffer in memory.
  const bundle: { filePath: string; content: string }[] = [];
  for (const f of candidates) {
    try {
      const buf = await fs.readFile(f.absPath);
      bundle.push({ filePath: f.relPath, content: buf.toString("utf8") });
    } catch (err) {
      ctx.onProgress?.({
        phase: ROUTES_PHASE_NAME,
        kind: "warn",
        message: `routes: cannot read ${f.relPath}: ${(err as Error).message}`,
      });
    }
  }

  // Next.js App Router is filesystem-routed — pass the full bundle.
  const nextRoutesRaw = detectNextJsRoutes(bundle, ctx.repoPath);
  // Walk each verb handler's body for `NextResponse.json({...})` /
  // `Response.json({...})` literals and promote the keys onto `responseKeys`.
  const nextRoutes = populateNextJsResponseKeys(nextRoutesRaw, bundle);

  // Express is file-local.
  const expressRoutes: ExtractedRoute[] = [];
  for (const entry of bundle) {
    for (const r of detectExpressRoutes({ filePath: entry.filePath, content: entry.content })) {
      expressRoutes.push(r);
    }
  }

  // Stable ordering so edge insertion is deterministic.
  const all = [...nextRoutes, ...expressRoutes].slice().sort(compareRoute);

  // Dedupe (url, method) to count duplicates while still emitting one edge
  // per (handlerFile, url, method). Multiple files claiming the same URL
  // is a warning; multiple edges from the same file to the same route
  // collapse in addEdge.
  const globalKeyCounts = new Map<string, number>();
  for (const r of all) {
    const key = globalKey(r);
    globalKeyCounts.set(key, (globalKeyCounts.get(key) ?? 0) + 1);
  }

  let duplicateCount = 0;
  const warnedKeys = new Set<string>();
  const emittedEdgeKeys = new Set<string>();
  let routeCount = 0;

  for (const r of all) {
    const method = r.method ?? "ANY";
    const routeId = makeNodeId("Route", r.handlerFile, `${method}:${r.url}`);
    const routeNode: RouteNode = {
      id: routeId,
      kind: "Route",
      name: `${method} ${r.url}`,
      filePath: r.handlerFile,
      url: r.url,
      ...(r.method !== undefined ? { method: r.method } : {}),
      ...(r.responseKeys !== undefined ? { responseKeys: r.responseKeys } : {}),
    };
    ctx.graph.addNode(routeNode);
    routeCount += 1;

    const fileId = makeNodeId("File", r.handlerFile, r.handlerFile);
    const edgeKey = `${r.handlerFile}\u0000${method}\u0000${r.url}`;
    if (!emittedEdgeKeys.has(edgeKey)) {
      emittedEdgeKeys.add(edgeKey);
      ctx.graph.addEdge({
        from: fileId,
        to: routeId,
        type: "HANDLES_ROUTE",
        confidence: 0.9,
        reason: `${r.framework}-handler`,
      });
    }

    const gKey = globalKey(r);
    if ((globalKeyCounts.get(gKey) ?? 0) > 1 && !warnedKeys.has(gKey)) {
      warnedKeys.add(gKey);
      duplicateCount += 1;
      ctx.onProgress?.({
        phase: ROUTES_PHASE_NAME,
        kind: "warn",
        message: `routes: duplicate registration for ${method} ${r.url}`,
      });
    }
  }

  return { routeCount, duplicateCount };
}

function globalKey(r: ExtractedRoute): string {
  const method = r.method ?? "ANY";
  return `${method}\u0000${r.url}`;
}

function compareRoute(a: ExtractedRoute, b: ExtractedRoute): number {
  if (a.handlerFile !== b.handlerFile) return a.handlerFile < b.handlerFile ? -1 : 1;
  const am = a.method ?? "";
  const bm = b.method ?? "";
  if (am !== bm) return am < bm ? -1 : 1;
  if (a.url !== b.url) return a.url < b.url ? -1 : 1;
  return 0;
}

function extLower(relPath: string): string {
  const idx = relPath.lastIndexOf(".");
  if (idx < 0) return "";
  return relPath.slice(idx).toLowerCase();
}
