/**
 * OpenAPI phase — materialises HTTP operations described by OpenAPI /
 * Swagger specs as `Operation` nodes and links them to existing `Route`
 * nodes whose method + templated path match.
 *
 * Pipeline placement:
 *   - deps: [routes, profile]
 *   - If the ProjectProfile's `apiContracts` list does NOT include
 *     "openapi", the phase is a no-op (skips all spec discovery).
 *
 * What the phase does:
 *   1. Walks scan output for every file whose basename matches
 *      `openapi.{yaml,json}` / `swagger.{yaml,json}`, sorted by relPath.
 *   2. For each spec, invokes `SwaggerParser.dereference(absPath, { resolve: { external: false } })`
 *      which resolves internal `$ref`s inline while refusing any HTTP or
 *      external file lookups (hard offline posture).
 *   3. For each (method, path) pair, emits one `Operation` node with id
 *      `Operation:<specRelPath>:<METHOD>:<path>` plus optional `summary`
 *      and `operationId` properties (W1-CORE shape).
 *   4. Looks up an existing `Route` node whose method + normalised path
 *      matches the operation. Matches exact strings first, then falls
 *      back to path-parameter normalisation:
 *        OpenAPI `{id}` → `:id`
 *        Next.js `[id]` → `:id`
 *        Express `:id`  unchanged
 *      Both sides are normalised before comparison so any combination of
 *      the three notations produces a single canonical key.
 *   5. On a match, emits a `HANDLES_ROUTE` edge Operation → Route with
 *      confidence 0.95 and reason `openapi-spec`. The direction encodes
 *      "this spec describes this route handler".
 *
 * Determinism:
 *   - Spec files are processed in scan-sorted order (same order scan emits).
 *   - Operations are materialised in `(METHOD, path)` lex order so edge
 *     insertion and graphHash byte-stability hold across runs.
 *
 * Error handling:
 *   - Any swagger-parser throw (malformed spec, unresolved $ref, circular
 *     references without handling) is caught and surfaced as a `warn`
 *     progress event. The offending spec is skipped; the phase continues.
 *   - No network calls: `resolve.external = false` disables the HTTP and
 *     file-based external resolvers.
 */

import type {
  KnowledgeGraph,
  NodeId,
  OperationNode,
  ProjectProfileNode,
  RouteNode,
} from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { ROUTES_PHASE_NAME } from "./routes.js";
import { SCAN_PHASE_NAME, type ScannedFile, type ScanOutput } from "./scan.js";

export const OPENAPI_PHASE_NAME = "openapi" as const;

export interface OpenApiOutput {
  readonly operationsEmitted: number;
  readonly routesLinked: number;
  readonly specsProcessed: number;
}

/**
 * HTTP verbs recognised by the OpenAPI spec, upper-cased for the Operation
 * node `method` property. `trace` is in OpenAPI 3.x even though few runtime
 * servers implement it — we surface it anyway so our operations mirror the
 * authored spec.
 */
const HTTP_METHODS: readonly (
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace"
)[] = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

/** Basenames that flag a file as an OpenAPI / Swagger spec unambiguously. */
const SPEC_BASENAME_RE = /^(openapi|swagger)\.(ya?ml|json)$/i;

/**
 * OpenAPI MethodNode type alias — method strings are always upper-case
 * because the storage schema stores them in the `http_method` column and
 * downstream comparisons assume upper-case.
 */
type UpperHttpMethod = OperationNode["method"];

type PathItem = Record<string, unknown>;

interface ParsedOperation {
  readonly method: UpperHttpMethod;
  readonly path: string;
  readonly summary?: string;
  readonly operationId?: string;
}

export const openapiPhase: PipelinePhase<OpenApiOutput> = {
  name: OPENAPI_PHASE_NAME,
  deps: [ROUTES_PHASE_NAME, PROFILE_PHASE_NAME],
  async run(ctx) {
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("openapi: scan output missing from phase outputs");
    }
    return runOpenApi(ctx, scan);
  },
};

async function runOpenApi(ctx: PipelineContext, scan: ScanOutput): Promise<OpenApiOutput> {
  // Skip unless profile phase detected openapi.
  const profile = findProjectProfile(ctx.graph);
  if (!profile || !profile.apiContracts.includes("openapi")) {
    return { operationsEmitted: 0, routesLinked: 0, specsProcessed: 0 };
  }

  const specs = selectSpecFiles(scan.files);
  if (specs.length === 0) {
    return { operationsEmitted: 0, routesLinked: 0, specsProcessed: 0 };
  }

  // Build a method + normalised-path → Route node id lookup once, so per-
  // operation matches stay O(1).
  const routeIndex = indexRoutesByMethodAndPath(ctx.graph);

  let operationsEmitted = 0;
  let routesLinked = 0;
  let specsProcessed = 0;

  for (const spec of specs) {
    const parsedOps = await dereferenceSpec(ctx, spec);
    if (parsedOps === null) {
      // Already warned in dereferenceSpec; skip spec, keep pipeline alive.
      continue;
    }
    specsProcessed += 1;

    // Sort operations deterministically before insertion.
    const sorted = [...parsedOps].sort(compareParsedOperation);
    for (const op of sorted) {
      const opId = operationNodeId(spec.relPath, op.method, op.path);
      const node: OperationNode = {
        id: opId,
        kind: "Operation",
        name: `${op.method} ${op.path}`,
        filePath: spec.relPath,
        method: op.method,
        path: op.path,
        ...(op.summary !== undefined ? { summary: op.summary } : {}),
        ...(op.operationId !== undefined ? { operationId: op.operationId } : {}),
      };
      ctx.graph.addNode(node);
      operationsEmitted += 1;

      const routeKey = routeLookupKey(op.method, op.path);
      const routeId = routeIndex.get(routeKey);
      if (routeId !== undefined) {
        ctx.graph.addEdge({
          from: opId,
          to: routeId,
          type: "HANDLES_ROUTE",
          confidence: 0.95,
          reason: "openapi-spec",
        });
        routesLinked += 1;
      }
    }
  }

  return { operationsEmitted, routesLinked, specsProcessed };
}

/** Look up the singleton ProjectProfile node in the graph, if any. */
function findProjectProfile(graph: KnowledgeGraph): ProjectProfileNode | undefined {
  for (const n of graph.nodes()) {
    if (n.kind === "ProjectProfile") return n as ProjectProfileNode;
  }
  return undefined;
}

function selectSpecFiles(files: readonly ScannedFile[]): readonly ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const f of files) {
    const basename = basenameOf(f.relPath);
    if (SPEC_BASENAME_RE.test(basename)) out.push(f);
  }
  // scan output is already sorted by relPath, but sort defensively so
  // tests that construct ScannedFile[] directly still get a stable order.
  return out.slice().sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/**
 * Invoke swagger-parser's `dereference` with external resolution disabled
 * and walk the resulting paths object. Returns `null` on any parser throw
 * (after emitting a warn event); otherwise returns the list of operations
 * found on the spec.
 */
async function dereferenceSpec(
  ctx: PipelineContext,
  spec: ScannedFile,
): Promise<readonly ParsedOperation[] | null> {
  // Lazy-import swagger-parser inside the function body so the phase
  // module can be loaded in environments where the dep is absent (e.g.
  // isolated typecheck) without blowing up. The real pipeline always has
  // the dep installed via @opencodehub/ingestion's package.json.
  //
  // swagger-parser uses CommonJS `export = SwaggerParser`. ESM dynamic
  // `import()` wraps that into `{ default: SwaggerParser }`, so we must
  // reach through `.default` and cannot import the type directly
  // (`typeof import("@apidevtools/swagger-parser").default` is invalid
  // under `export =`). Use a structural minimal interface instead.
  interface SwaggerParserStatic {
    dereference(path: string, options: { resolve: { external: false } }): Promise<unknown>;
  }
  let SwaggerParser: SwaggerParserStatic;
  try {
    const mod = (await import("@apidevtools/swagger-parser")) as unknown as {
      default: SwaggerParserStatic;
    };
    SwaggerParser = mod.default;
  } catch (err) {
    ctx.onProgress?.({
      phase: OPENAPI_PHASE_NAME,
      kind: "warn",
      message: `openapi: @apidevtools/swagger-parser not available: ${errMessage(err)}`,
    });
    return null;
  }

  let api: unknown;
  try {
    api = await SwaggerParser.dereference(spec.absPath, {
      resolve: { external: false },
    });
  } catch (err) {
    ctx.onProgress?.({
      phase: OPENAPI_PHASE_NAME,
      kind: "warn",
      message: `openapi: failed to parse ${spec.relPath}: ${errMessage(err)}`,
    });
    return null;
  }

  const paths = extractPaths(api);
  if (paths === undefined) {
    ctx.onProgress?.({
      phase: OPENAPI_PHASE_NAME,
      kind: "warn",
      message: `openapi: ${spec.relPath} has no paths object`,
    });
    return [];
  }

  const ops: ParsedOperation[] = [];
  for (const [pathTemplate, pathItemRaw] of Object.entries(paths)) {
    if (!isRecord(pathItemRaw)) continue;
    const pathItem = pathItemRaw as PathItem;
    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      if (!isRecord(opRaw)) continue;
      const opRecord = opRaw as Record<string, unknown>;
      const summary = stringOrUndefined(opRecord["summary"]);
      const operationId = stringOrUndefined(opRecord["operationId"]);
      ops.push({
        method: method.toUpperCase() as UpperHttpMethod,
        path: pathTemplate,
        ...(summary !== undefined ? { summary } : {}),
        ...(operationId !== undefined ? { operationId } : {}),
      });
    }
  }
  return ops;
}

function extractPaths(api: unknown): Record<string, unknown> | undefined {
  if (!isRecord(api)) return undefined;
  const paths = api["paths"];
  if (!isRecord(paths)) return undefined;
  return paths as Record<string, unknown>;
}

/**
 * Walk the graph and build a method+normalisedPath → NodeId index of
 * existing Route nodes. We snapshot the node set at call time; later
 * Operation emissions don't invalidate the map because Route nodes are
 * populated by the routes phase which strictly precedes this one.
 */
function indexRoutesByMethodAndPath(graph: KnowledgeGraph): Map<string, NodeId> {
  const index = new Map<string, NodeId>();
  for (const n of graph.nodes()) {
    if (n.kind !== "Route") continue;
    const route = n as RouteNode;
    // Routes without a method are rare (catch-all `app.use`) — they can't
    // match a method-specific OpenAPI operation.
    const method = route.method;
    if (method === undefined) continue;
    const key = routeLookupKey(method.toUpperCase() as UpperHttpMethod, route.url);
    // First-write wins; routes are emitted in a deterministic order so the
    // winner is stable across runs.
    if (!index.has(key)) {
      index.set(key, route.id);
    }
  }
  return index;
}

function routeLookupKey(method: string, path: string): string {
  return `${method.toUpperCase()}\u0000${normalisePath(path)}`;
}

/**
 * Normalise route path templates so OpenAPI `/users/{id}`, Express
 * `/users/:id`, and Next.js `/users/[id]` all collapse onto the same
 * canonical form (`/users/:id`). The transformation is purely syntactic:
 * we rewrite brace- and bracket-style parameters in place and otherwise
 * leave the path untouched.
 */
function normalisePath(path: string): string {
  if (path.length === 0) return path;
  let out = path;
  // `{param}` → `:param`
  out = out.replace(/\{([^}]+)\}/g, ":$1");
  // `[param]` → `:param`
  out = out.replace(/\[([^\]]+)\]/g, ":$1");
  return out;
}

function operationNodeId(specPath: string, method: UpperHttpMethod, pathTemplate: string): NodeId {
  return makeNodeId("Operation", specPath, `${method}:${pathTemplate}`);
}

function compareParsedOperation(a: ParsedOperation, b: ParsedOperation): number {
  if (a.method !== b.method) return a.method < b.method ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return 0;
}

function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx < 0 ? relPath : relPath.slice(idx + 1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
