/**
 * Processes phase — approximate end-to-end request flows by BFS-ing
 * forward along the CALLS graph from scored entry points.
 *
 * Entry-point scoring:
 *   score =
 *     (callees / (callers + 1))     // high fan-out, low fan-in = flow start
 *     + (isExported ? 0.5 : 0)
 *     + (isReExportedFromEntry ? 0.4 : 0)  // re-exported from index/__init__/mod/lib
 *     + filename hint  (+0.3 when the basename stem matches a known entry-file
 *                       hint; e.g. `main.rs`, `routes.py`)
 *     + dir hint       (+0.3 when the file sits under a framework-specific
 *                       handler directory; e.g. app/(star-star)/route.ts,
 *                       controllers/(star-star), app/Http/Controllers/(star-star))
 *     + name hint      (+0.3 for verbs like handle*, *Controller, *Handler,
 *                       *Service, *Middleware, serveXxx, etc.)
 *     − ∞             for files with /test/ or /spec/ segments.
 *
 * We keep the top N entry points where N scales with the symbol count,
 * clamped to [20, 300].
 *
 * BFS:
 *   - Max depth 10
 *   - Max branching 4 per node (neighbours sorted by id; take the first 4)
 *   - Max 30 unique nodes per process
 *   - Only CALLS edges with confidence ≥ 0.5 are traversed
 *
 * Only processes with ≥ 2 PROCESS_STEP edges make it into the graph; trivial
 * one-hop flows are dropped.
 *
 * Route / Tool linkage: when a Route or Tool node's handler file matches
 * the entry point's file, we emit an `ENTRY_POINT_OF` edge from the
 * Route/Tool to the Process.
 *
 * Cohesion label: the process's `inferredLabel` is derived by
 * tokenising every symbol that participates in the flow (camel/snake/kebab
 * splits), dropping stop-verbs, and joining the top-3 tokens by frequency.
 * Fallback to `<entry-name>-flow` when too few informative tokens exist.
 */

import type { NodeId, ProcessNode } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { COMMUNITIES_PHASE_NAME } from "./communities.js";
import { resolveIncrementalView } from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { ROUTES_PHASE_NAME } from "./routes.js";
import { STRUCTURE_PHASE_NAME } from "./structure.js";
import { TOOLS_PHASE_NAME } from "./tools.js";

export const PROCESSES_PHASE_NAME = "processes";

const MAX_DEPTH = 10;
const MAX_BRANCHING = 4;
const MAX_NODES_PER_PROCESS = 30;
const MIN_STEPS_PER_PROCESS = 2;
const MIN_ENTRY_POINTS = 20;
const MAX_ENTRY_POINTS = 300;
const MIN_EDGE_CONFIDENCE = 0.5;

const CALLABLE_KINDS: ReadonlySet<string> = new Set(["Function", "Method", "Constructor"]);

/**
 * Filename stems that hint at an entry point across all 14 supported
 * languages (Python/Django/Flask/FastAPI, Express/Next.js/NestJS, Spring,
 * ASP.NET, Axum/Actix, Rails, Laravel, Kotlin, Swift, PHP, Dart). Matched
 * against the basename stem (before the first `.`).
 */
const FILE_HINTS: readonly string[] = [
  "main",
  "handler",
  "handlers",
  "controller",
  "controllers",
  "route",
  "routes",
  "router",
  "view",
  "views",
  "api",
  "index",
  "mod",
  "lib",
  "app",
  "application",
  "server",
  "entry",
  "urls",
  "endpoints",
  "middleware",
  "service",
  "services",
  "resource",
  "resources",
  "page",
  "pages",
];

/**
 * Directory-path substrings that hint at handler code. Framework-aware:
 *  - Next.js App Router: `app/**\/route.*`, `pages/api/**`
 *  - Express / NestJS:   `controllers/**`, `routes/**`, `handlers/**`
 *  - Gin/Go:              `cmd/**`, `handlers/**`, `api/**`
 *  - Spring Boot:         captured via NAME_SUFFIXES (`*Controller.java`)
 *  - ASP.NET:             captured via NAME_SUFFIXES (`*Controller.cs`)
 *  - Axum/Actix:          `src/handlers/**`, `src/routes/**`
 *  - Rails:               `app/controllers/**`
 *  - Laravel:             `app/http/controllers/**`
 *  - Kotlin:              captured via NAME_SUFFIXES (`*Controller.kt`)
 *  - Swift:               `sources/*\/handlers/**`
 *  - PHP:                 `src/controller/**`, `public/index.php`
 *  - Dart:                `lib/pages/**`
 *
 * All comparisons are lowercase path-substring matches, so subtle variants
 * (e.g. `Controllers/` vs `controllers/`) still hit.
 */
const DIR_HINT_SUBSTRINGS: readonly string[] = [
  "/app/api/",
  "/pages/api/",
  "/app/controllers/",
  "/app/http/controllers/",
  "/controllers/",
  "/handlers/",
  "/routes/",
  "/router/",
  "/views/",
  "/endpoints/",
  "/api/",
  "/cmd/",
  "/src/handlers/",
  "/src/routes/",
  "/src/controller/",
  "/src/controllers/",
  "/lib/pages/",
  "/handlers.",
];

/** Suffix patterns within a full relative path that also count as dir hints. */
const PATH_SUFFIX_HINTS: readonly string[] = [
  "/route.ts",
  "/route.tsx",
  "/route.js",
  "/route.mjs",
  "/handler.ts",
  "/handler.py",
  "/main.go",
  "/main.rs",
  "/mod.rs",
  "/lib.rs",
  "/main.py",
  "/urls.py",
  "/routes.py",
  "/views.py",
  "/public/index.php",
];

/**
 * Identifier prefixes that hint at an entry point. Stored lowercase; we
 * match either `prefixCamel` or `prefix_snake` at the identifier start.
 */
const NAME_PREFIXES: readonly string[] = [
  "handle",
  "on",
  "serve",
  "main",
  "route",
  "dispatch",
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "do",
  "process",
  "index",
  "show",
  "list",
  "create",
  "update",
  "destroy",
  "setup",
  "run",
];

/** Identifier suffixes that hint at an entry-point role. */
const NAME_SUFFIXES: readonly string[] = [
  "Controller",
  "Handler",
  "Middleware",
  "Service",
  "Endpoint",
  "Resource",
  "View",
  "Route",
  "RouteHandler",
  "Action",
];

/** Files that often re-export symbols as a module's public API. */
const REEXPORT_FILE_BASENAMES: ReadonlySet<string> = new Set([
  "index.ts",
  "index.tsx",
  "index.js",
  "index.mjs",
  "index.cjs",
  "index.jsx",
  "mod.rs",
  "lib.rs",
  "__init__.py",
  "main.py",
  "index.php",
  "index.dart",
  "library.dart",
]);

/** Stop-words we exclude when deriving cohesion labels. */
const STOP_TOKENS: ReadonlySet<string> = new Set([
  "get",
  "set",
  "is",
  "has",
  "new",
  "make",
  "do",
  "handle",
  "on",
  "to",
  "from",
  "of",
  "the",
  "a",
  "an",
  "or",
  "and",
  "for",
  "with",
  "fn",
  "func",
  "function",
  "method",
  "impl",
  "cls",
  "self",
  "this",
  "ctx",
  "run",
  "exec",
  "init",
  "start",
  "stop",
  "main",
]);

const MAX_COHESION_TOKENS = 3;
const MIN_TOKEN_LEN = 3;

export interface ProcessesOutput {
  readonly processCount: number;
  readonly avgStepsPerProcess: number;
}

export const processesPhase: PipelinePhase<ProcessesOutput> = {
  name: PROCESSES_PHASE_NAME,
  deps: [
    COMMUNITIES_PHASE_NAME,
    ROUTES_PHASE_NAME,
    TOOLS_PHASE_NAME,
    STRUCTURE_PHASE_NAME,
    INCREMENTAL_SCOPE_PHASE_NAME,
  ],
  async run(ctx) {
    return runProcesses(ctx);
  },
};

interface NodeMeta {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly kind: string;
  readonly isExported: boolean;
  callersCount: number;
  calleesCount: number;
}

function runProcesses(ctx: PipelineContext): ProcessesOutput {
  // ---- Incremental carry-forward short-circuit. -------------------------
  //
  // BFS re-rooting is expensive and its outputs (Process nodes, PROCESS_STEP
  // edges, ENTRY_POINT_OF edges) are deterministic functions of the post-
  // parse call graph + route/tool set. When the incremental view is active
  // the current call graph matches the prior run under no-semantic-change,
  // so the safest byte-identical incremental path is to carry forward every
  // Process node and PROCESS_STEP / ENTRY_POINT_OF edge from the prior
  // graph and skip BFS altogether. The 30% safety valve keeps us honest:
  // whenever the closure balloons past threshold the phase falls through
  // to a fresh BFS that observes any new entry points.
  const view = resolveIncrementalView(ctx);
  if (
    view.active &&
    view.previousGraph?.edges !== undefined &&
    view.previousGraph.nodes !== undefined
  ) {
    let carriedProcesses = 0;
    let carriedSteps = 0;
    for (const n of view.previousGraph.nodes) {
      if (n.kind !== "Process") continue;
      ctx.graph.addNode(n);
      carriedProcesses += 1;
    }
    for (const e of view.previousGraph.edges) {
      if (e.type !== "PROCESS_STEP" && e.type !== "ENTRY_POINT_OF") continue;
      ctx.graph.addEdge({
        from: e.from,
        to: e.to,
        type: e.type,
        confidence: e.confidence,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
        ...(e.step !== undefined ? { step: e.step } : {}),
      });
      if (e.type === "PROCESS_STEP") carriedSteps += 1;
    }
    return {
      processCount: carriedProcesses,
      avgStepsPerProcess: carriedProcesses === 0 ? 0 : carriedSteps / carriedProcesses,
    };
  }

  // ---- Collect candidate nodes + adjacency. -----------------------------
  const metaById = new Map<string, NodeMeta>();
  const nameById = new Map<string, string>();
  for (const n of ctx.graph.nodes()) {
    nameById.set(n.id, n.name);
    if (!CALLABLE_KINDS.has(n.kind)) continue;
    const exported =
      "isExported" in n &&
      typeof (n as unknown as { isExported?: boolean }).isExported === "boolean"
        ? ((n as unknown as { isExported: boolean }).isExported as boolean)
        : false;
    metaById.set(n.id, {
      id: n.id,
      name: n.name,
      filePath: n.filePath,
      kind: n.kind,
      isExported: exported,
      callersCount: 0,
      calleesCount: 0,
    });
  }

  // Directed adjacency: caller → list of callee ids (sorted for determinism).
  const adjacency = new Map<string, string[]>();
  for (const edge of ctx.graph.edges()) {
    if (edge.type !== "CALLS") continue;
    if (edge.confidence < MIN_EDGE_CONFIDENCE) continue;
    const from = edge.from as string;
    const to = edge.to as string;
    const fromMeta = metaById.get(from);
    const toMeta = metaById.get(to);
    if (fromMeta === undefined || toMeta === undefined) continue;
    fromMeta.calleesCount += 1;
    toMeta.callersCount += 1;
    const list = adjacency.get(from);
    if (list === undefined) adjacency.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  }
  for (const list of adjacency.values()) list.sort();

  // ---- Re-export detection. --------------------------------------------
  // Walk IMPORTS edges and flag every File node whose basename matches a
  // known public-API entry (index.ts, __init__.py, mod.rs, ...). Then for
  // each File node so flagged, record every symbol defined in the same
  // package directory that the re-export file exposes. We approximate
  // "re-export" at MVP: a callable defined in a file whose directory is the
  // parent of a REEXPORT_FILE gets a bonus, because languages vary in how
  // they surface names (named re-export in JS, pub use in Rust, `from x
  // import y` in Python). False positives are fine here — the bonus is
  // small and the final cap is bounded.
  const reExportDirs = new Set<string>();
  for (const n of ctx.graph.nodes()) {
    if (n.kind !== "File") continue;
    const base = basenameOf(n.filePath).toLowerCase();
    if (REEXPORT_FILE_BASENAMES.has(base)) {
      reExportDirs.add(parentDir(n.filePath));
    }
  }

  // ---- Score candidates. ------------------------------------------------
  const scored: { id: string; score: number; meta: NodeMeta }[] = [];
  for (const meta of metaById.values()) {
    if (isTestPath(meta.filePath)) continue;
    const callRatio = meta.calleesCount / (meta.callersCount + 1);
    let score = callRatio;
    if (meta.isExported) score += 0.5;
    if (hasFileHint(meta.filePath)) score += 0.3;
    if (hasDirHint(meta.filePath)) score += 0.3;
    if (hasNameHint(meta.name)) score += 0.3;
    if (meta.isExported && reExportDirs.has(parentDir(meta.filePath))) score += 0.4;
    if (meta.calleesCount === 0) continue; // a leaf can't root a flow.
    scored.push({ id: meta.id, score, meta });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tiebreak: lexicographic by id.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const symbolCount = metaById.size;
  // Scale N: ~5% of callables, clamped to [MIN, MAX].
  const targetN = Math.max(
    MIN_ENTRY_POINTS,
    Math.min(MAX_ENTRY_POINTS, Math.floor(symbolCount * 0.05)),
  );
  const entryPoints = scored.slice(0, targetN);

  // ---- Route / Tool index by handler file, for ENTRY_POINT_OF. ----------
  const routesByFile = new Map<string, NodeId[]>();
  const toolsByFile = new Map<string, NodeId[]>();
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "Route") {
      const list = routesByFile.get(n.filePath) ?? [];
      list.push(n.id as NodeId);
      routesByFile.set(n.filePath, list);
    } else if (n.kind === "Tool") {
      const list = toolsByFile.get(n.filePath) ?? [];
      list.push(n.id as NodeId);
      toolsByFile.set(n.filePath, list);
    }
  }
  for (const list of routesByFile.values()) list.sort();
  for (const list of toolsByFile.values()) list.sort();

  // ---- BFS from each entry point and emit Process nodes/edges. ----------
  let processCount = 0;
  let totalSteps = 0;

  for (const ep of entryPoints) {
    const steps = bfs(ep.id, adjacency);
    if (steps.length < MIN_STEPS_PER_PROCESS) continue;

    const processNodeId = makeNodeId("Process", ep.meta.filePath, `process-${ep.id}`);

    // Cohesion label: tokenize entry-point name + every symbol reached.
    const tokenCounts = new Map<string, number>();
    countTokens(ep.meta.name, tokenCounts);
    for (const s of steps) {
      const name = nameById.get(s.to);
      if (name !== undefined) countTokens(name, tokenCounts);
    }
    const topTokens = pickTopTokens(tokenCounts, MAX_COHESION_TOKENS);
    const inferredLabel = topTokens.length >= 2 ? topTokens.join(" ") : `${ep.meta.name}-flow`;

    const processNode: ProcessNode = {
      id: processNodeId,
      kind: "Process",
      name: `${ep.meta.name}-flow`,
      filePath: ep.meta.filePath,
      entryPointId: ep.id,
      stepCount: steps.length,
      inferredLabel,
    };
    ctx.graph.addNode(processNode);

    // Emit PROCESS_STEP edges: ctx.graph.addEdge dedupes on
    // (from, type, to, step), so we thread `step` through to preserve
    // multiple transitions along a chain that revisits the same pair at
    // different depths.
    for (const s of steps) {
      ctx.graph.addEdge({
        from: s.from as NodeId,
        to: s.to as NodeId,
        type: "PROCESS_STEP",
        confidence: 0.85,
        reason: "bfs-from-entry-point",
        step: s.depth,
      });
    }

    // ENTRY_POINT_OF edges from Route / Tool whose file matches the EP.
    const routes = routesByFile.get(ep.meta.filePath) ?? [];
    for (const r of routes) {
      ctx.graph.addEdge({
        from: r,
        to: processNodeId,
        type: "ENTRY_POINT_OF",
        confidence: 0.85,
        reason: "route-matches-entry-file",
      });
    }
    const tools = toolsByFile.get(ep.meta.filePath) ?? [];
    for (const t of tools) {
      ctx.graph.addEdge({
        from: t,
        to: processNodeId,
        type: "ENTRY_POINT_OF",
        confidence: 0.85,
        reason: "tool-matches-entry-file",
      });
    }

    processCount += 1;
    totalSteps += steps.length;
  }

  return {
    processCount,
    avgStepsPerProcess: processCount === 0 ? 0 : totalSteps / processCount,
  };
}

interface BfsStep {
  readonly from: string;
  readonly to: string;
  readonly depth: number;
}

/**
 * Deterministic forward BFS along the CALLS adjacency. Neighbours are
 * pre-sorted in `adjacency`; we limit branching and total coverage to keep
 * processes bounded.
 */
function bfs(start: string, adjacency: ReadonlyMap<string, readonly string[]>): BfsStep[] {
  const visited = new Set<string>([start]);
  const queue: { id: string; depth: number }[] = [{ id: start, depth: 0 }];
  const steps: BfsStep[] = [];
  while (queue.length > 0 && visited.size < MAX_NODES_PER_PROCESS) {
    const head = queue.shift() as { id: string; depth: number };
    if (head.depth >= MAX_DEPTH) continue;
    const neighbours = adjacency.get(head.id) ?? [];
    const limited = neighbours.slice(0, MAX_BRANCHING);
    for (const nb of limited) {
      if (visited.has(nb)) {
        // Skip cycles; still emit no edge (would create duplicate step).
        continue;
      }
      visited.add(nb);
      steps.push({ from: head.id, to: nb, depth: head.depth + 1 });
      queue.push({ id: nb, depth: head.depth + 1 });
      if (visited.size >= MAX_NODES_PER_PROCESS) break;
    }
  }
  return steps;
}

function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const segments = lower.split("/");
  for (const s of segments) {
    if (s === "test" || s === "tests" || s === "spec" || s === "specs" || s === "__tests__") {
      return true;
    }
  }
  // Also catch `foo.test.ts`, `foo.spec.ts`, etc.
  if (lower.includes(".test.") || lower.includes(".spec.")) return true;
  return false;
}

function hasFileHint(filePath: string): boolean {
  const slash = filePath.lastIndexOf("/");
  const base = (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
  const dot = base.indexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  for (const h of FILE_HINTS) {
    if (stem === h) return true;
  }
  return false;
}

function hasDirHint(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  // Wrap with slashes so leading segments also match.
  const anchored = `/${lower}`;
  for (const sub of DIR_HINT_SUBSTRINGS) {
    if (anchored.includes(sub)) return true;
  }
  for (const suffix of PATH_SUFFIX_HINTS) {
    if (anchored.endsWith(suffix)) return true;
  }
  return false;
}

function hasNameHint(name: string): boolean {
  if (name.length === 0) return false;
  if (name === "main") return true;
  for (const p of NAME_PREFIXES) {
    if (name === p) return true;
    if (name.length <= p.length) continue;
    // CamelCase boundary: `handleRequest`, `serveHttp`, etc.
    if (
      name.startsWith(p) &&
      (name[p.length] as string) >= "A" &&
      (name[p.length] as string) <= "Z"
    ) {
      return true;
    }
    // snake/kebab boundary: `handle_request`, `handle-request`.
    if (name.startsWith(p) && (name[p.length] === "_" || name[p.length] === "-")) {
      return true;
    }
  }
  for (const s of NAME_SUFFIXES) {
    if (name.endsWith(s) && name.length > s.length) return true;
  }
  return false;
}

function basenameOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(0, slash) : "";
}

/**
 * Split an identifier into camelCase / snake_case / kebab-case / dot.case
 * components, lowercase everything, and bump frequency counts.
 */
function countTokens(name: string, counts: Map<string, number>): void {
  for (const tok of splitIdentifier(name)) {
    if (tok.length < MIN_TOKEN_LEN) continue;
    if (STOP_TOKENS.has(tok)) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
}

function splitIdentifier(name: string): readonly string[] {
  // Normalize separators to spaces, then split camelCase.
  const separatorSplit = name.replace(/[_\-.]+/g, " ").trim();
  // Split runs like `HTTPServer` into `HTTP Server`, and `serveHttp` into
  // `serve Http` before lowercasing.
  const camelSplit = separatorSplit
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return camelSplit.split(/\s+/).filter((t) => t.length > 0);
}

function pickTopTokens(counts: ReadonlyMap<string, number>, limit: number): readonly string[] {
  const entries: { token: string; count: number }[] = [];
  for (const [token, count] of counts) entries.push({ token, count });
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    // Deterministic tiebreak on token text.
    return a.token < b.token ? -1 : a.token > b.token ? 1 : 0;
  });
  return entries.slice(0, limit).map((e) => e.token);
}
