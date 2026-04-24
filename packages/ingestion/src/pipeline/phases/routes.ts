/**
 * Routes phase — materialises HTTP route metadata emitted by the static
 * detectors (Next.js, Express, FastAPI, NestJS, Spring MVC, Rails) as
 * graph nodes and edges.
 *
 * The phase:
 *   1. Feeds the scanned files through every detector that matches the
 *      active {@link ProjectProfileNode.frameworks} list. Next.js +
 *      Express always run when TS/JS files are present. FastAPI runs on
 *      `fastapi`, NestJS on `nestjs`, Spring on any `spring-*` variant,
 *      Rails on `rails`.
 *   2. Creates one `Route` node per unique `(url, method)` pair, keyed
 *      by the handler file so two frameworks declaring the same URL on
 *      the same file reuse the node.
 *   3. Emits `HANDLES_ROUTE` edges from the declaring File node to the
 *      Route node with a fixed confidence of 0.9.
 *   4. Detects cross-file duplicates for the same `(url, method)` and
 *      surfaces them as warnings via the progress callback — but keeps
 *      one edge per handler file (the route *is* re-declared).
 *
 * Depends on `parse` to order the DAG; the profile node is read from
 * the in-memory graph.
 */

import { promises as fs } from "node:fs";
import type { ProjectProfileNode, RouteNode } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import { importsMapFromExtracted } from "../../extract/receiver-resolver.js";
import {
  detectExpressRoutes,
  detectNextJsRoutes,
  populateNextJsResponseKeys,
} from "../../extract/route-detector.js";
import { detectSpringRoutes } from "../../extract/route-detector-java.js";
import { detectNestJsRoutes } from "../../extract/route-detector-nestjs.js";
import { detectFastApiRoutes } from "../../extract/route-detector-python.js";
import { detectRailsRoutes } from "../../extract/route-detector-rails.js";
import type { ExtractedRoute } from "../../extract/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
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

/** Extensions the FastAPI detector scans. */
const PYTHON_EXTS: ReadonlySet<string> = new Set([".py"]);

/** Extensions the Spring detector scans. */
const JAVA_EXTS: ReadonlySet<string> = new Set([".java"]);

export interface RoutesOutput {
  readonly routeCount: number;
  readonly duplicateCount: number;
}

export const ROUTES_PHASE_NAME = "routes";

export const routesPhase: PipelinePhase<RoutesOutput> = {
  name: ROUTES_PHASE_NAME,
  // `profile` is a dependency so the detected-frameworks gating can
  // read the ProjectProfile node out of the graph without a race.
  deps: [PARSE_PHASE_NAME, "profile"],
  async run(ctx, deps) {
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("routes: scan output missing from phase outputs");
    }
    const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;
    if (parse === undefined) {
      throw new Error("routes: parse output missing from dependency map");
    }
    return runRoutes(ctx, scan, parse);
  },
};

async function runRoutes(
  ctx: PipelineContext,
  scan: ScanOutput,
  parse: ParseOutput,
): Promise<RoutesOutput> {
  const frameworks = readDetectedFrameworks(ctx);
  const importsByFile = importsMapFromExtracted(parse.importsByFile);
  const strictDetectors = ctx.options.strictDetectors === true;

  // Bundle files we might hand to TS/JS detectors (Next.js, Express,
  // NestJS). Each entry is read once so all three detectors share the
  // same buffer.
  const jsTsCandidates = scan.files.filter((f) => JS_TS_EXTS.has(extLower(f.relPath)));
  const bundle = await readBundle(ctx, jsTsCandidates);

  // Next.js App Router is filesystem-routed — pass the full bundle.
  const nextRoutesRaw = detectNextJsRoutes(bundle, ctx.repoPath);
  // Walk each verb handler's body for `NextResponse.json({...})` /
  // `Response.json({...})` literals and promote the keys onto `responseKeys`.
  const nextRoutes = populateNextJsResponseKeys(nextRoutesRaw, bundle);

  // Express is file-local.
  const expressRoutes: ExtractedRoute[] = [];
  for (const entry of bundle) {
    for (const r of detectExpressRoutes({
      filePath: entry.filePath,
      content: entry.content,
      importsByFile,
      strictDetectors,
    })) {
      expressRoutes.push(r);
    }
  }

  // NestJS — profile-gated.
  const nestRoutes: ExtractedRoute[] = [];
  if (frameworks.has("nestjs")) {
    for (const entry of bundle) {
      for (const r of detectNestJsRoutes({ filePath: entry.filePath, content: entry.content })) {
        nestRoutes.push(r);
      }
    }
  }

  // FastAPI — profile-gated. Reads `.py` candidates from the scan.
  const fastApiRoutes: ExtractedRoute[] = [];
  if (frameworks.has("fastapi")) {
    const pyFiles = scan.files.filter((f) => PYTHON_EXTS.has(extLower(f.relPath)));
    const pyBundle = await readBundle(ctx, pyFiles);
    for (const entry of pyBundle) {
      for (const r of detectFastApiRoutes({ filePath: entry.filePath, content: entry.content })) {
        fastApiRoutes.push(r);
      }
    }
  }

  // Spring — profile-gated on any `spring-*` detected framework.
  const springRoutes: ExtractedRoute[] = [];
  const hasSpring = [...frameworks].some((f) => f === "spring" || f.startsWith("spring-"));
  if (hasSpring) {
    const javaFiles = scan.files.filter((f) => JAVA_EXTS.has(extLower(f.relPath)));
    const javaBundle = await readBundle(ctx, javaFiles);
    for (const entry of javaBundle) {
      for (const r of detectSpringRoutes({ filePath: entry.filePath, content: entry.content })) {
        springRoutes.push(r);
      }
    }
  }

  // Rails — profile-gated. Only scans `config/routes*.rb`.
  const railsRoutes: ExtractedRoute[] = [];
  if (frameworks.has("rails")) {
    const routeFiles = scan.files.filter((f) =>
      /(^|\/)config\/routes(?:\.[\w-]+)?\.rb$/.test(f.relPath),
    );
    const routesBundle = await readBundle(ctx, routeFiles);
    for (const entry of routesBundle) {
      for (const r of detectRailsRoutes(entry.filePath, entry.content)) {
        railsRoutes.push(r);
      }
    }
  }

  // Stable ordering so edge insertion is deterministic.
  const all = [
    ...nextRoutes,
    ...expressRoutes,
    ...nestRoutes,
    ...fastApiRoutes,
    ...springRoutes,
    ...railsRoutes,
  ]
    .slice()
    .sort(compareRoute);

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

/**
 * Read a list of scan files into a [path, content] bundle for a
 * detector. Errors are logged as warnings; affected files simply don't
 * appear in the returned bundle.
 */
async function readBundle(
  ctx: PipelineContext,
  files: readonly { absPath: string; relPath: string }[],
): Promise<{ filePath: string; content: string }[]> {
  const out: { filePath: string; content: string }[] = [];
  for (const f of files) {
    try {
      const buf = await fs.readFile(f.absPath);
      out.push({ filePath: f.relPath, content: buf.toString("utf8") });
    } catch (err) {
      ctx.onProgress?.({
        phase: ROUTES_PHASE_NAME,
        kind: "warn",
        message: `routes: cannot read ${f.relPath}: ${(err as Error).message}`,
      });
    }
  }
  return out;
}

/**
 * Pull the detected framework set from the in-memory graph's singleton
 * `ProjectProfile` node. Returns an empty set when the profile phase
 * has not yet populated the node — which is also the default when the
 * profile phase is disabled.
 */
function readDetectedFrameworks(ctx: PipelineContext): ReadonlySet<string> {
  const out = new Set<string>();
  for (const n of ctx.graph.nodes()) {
    if (n.kind !== "ProjectProfile") continue;
    const profile = n as ProjectProfileNode;
    for (const name of profile.frameworks ?? []) out.add(name);
    for (const d of profile.frameworksDetected ?? []) out.add(d.name);
    break;
  }
  return out;
}
