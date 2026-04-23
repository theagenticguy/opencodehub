/**
 * Fetches phase — emits FETCHES edges from outbound HTTP call sites.
 *
 * Per language-aware scanning:
 *   1. For each scanned file that has a provider implementing
 *      `detectOutboundHttp`, re-read the source text (parse captures are
 *      not persisted by the parse phase) and run the hook.
 *   2. For each `HttpCall` returned, try to match a local `Route` node by
 *      normalized `(method, path)`. When found, emit
 *      `FETCHES: enclosingSymbol -> Route` with confidence 0.8.
 *   3. When no local Route matches, emit `FETCHES: enclosingSymbol ->
 *      <unresolved-url>` with the urlTemplate stored in `reason`. The
 *      synthetic `<unresolved-url>` target is not a real node — it is a
 *      string id string that downstream cross-repo tools recognize as
 *      "needs producer lookup".
 *
 * Enclosing-symbol resolution:
 *   - Walk `definitionsByFile` for the file.
 *   - Find the innermost definition whose `[startLine, endLine]` range
 *     contains the HttpCall's startLine. Prefer Functions/Methods over
 *     Classes for readability.
 *   - Fall back to the File node id when no enclosing callable exists.
 *
 * Determinism:
 *   - Files iterate in alphabetical order over `scan.files`.
 *   - Within a file, detected calls are pre-sorted by
 *     (startLine, method, url, clientLibrary).
 *   - Resulting FETCHES edges are stable because `KnowledgeGraph.addEdge`
 *     dedupes on `(from, type, to, step)`, and we sort the iteration keys.
 *
 * The phase never hits the network.
 */

import { promises as fs } from "node:fs";
import type { CodeRelation, NodeKind } from "@opencodehub/core-types";
import { makeNodeId, type NodeId } from "@opencodehub/core-types";
import { getProvider } from "../../providers/registry.js";
import type { HttpCall } from "../../providers/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { ROUTES_PHASE_NAME } from "./routes.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

export const FETCHES_PHASE_NAME = "fetches" as const;

/**
 * Synthetic target id used when no local Route matches a detected HTTP
 * call. The MCP `group_contracts` tool recognises this prefix and treats
 * the URL template stored in `reason` as the lookup key.
 */
export const UNRESOLVED_FETCH_TARGET_PREFIX = "fetches:unresolved:";

export interface FetchesOutput {
  readonly httpCallsDetected: number;
  readonly edgesEmitted: number;
  readonly unresolvedCount: number;
}

const CALLABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Function",
  "Method",
  "Constructor",
]);

export const fetchesPhase: PipelinePhase<FetchesOutput> = {
  name: FETCHES_PHASE_NAME,
  // Depends on parse (for definitionsByFile/symbol boundaries), profile (so
  // framework gating via ProjectProfile can land), and routes (so local
  // Route nodes are already in the graph for local-match resolution).
  deps: [PARSE_PHASE_NAME, PROFILE_PHASE_NAME, ROUTES_PHASE_NAME],
  async run(ctx, deps) {
    const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (parse === undefined) throw new Error("fetches: parse output missing");
    if (scan === undefined) throw new Error("fetches: scan output missing");
    return runFetches(ctx, scan, parse);
  },
};

interface RouteIndex {
  readonly byKey: ReadonlyMap<string, NodeId>;
}

function buildRouteIndex(ctx: PipelineContext): RouteIndex {
  const byKey = new Map<string, NodeId>();
  for (const n of ctx.graph.nodes()) {
    if (n.kind !== "Route") continue;
    const route = n as typeof n & { url?: string; method?: string };
    if (route.url === undefined) continue;
    const method = (route.method ?? "GET").toUpperCase();
    const key = routeKey(method, route.url);
    if (!byKey.has(key)) byKey.set(key, n.id);
  }
  return { byKey };
}

function routeKey(method: string, url: string): string {
  const normalized = url
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
  return `${method.toUpperCase()}\u0000${normalized}`;
}

async function runFetches(
  ctx: PipelineContext,
  scan: ScanOutput,
  parse: ParseOutput,
): Promise<FetchesOutput> {
  const routes = buildRouteIndex(ctx);

  interface PendingEdge {
    readonly from: NodeId;
    readonly to: NodeId | string;
    readonly method: string;
    readonly urlTemplate: string;
    readonly clientLibrary: string;
    readonly startLine: number;
    readonly resolved: boolean;
  }
  const pending: PendingEdge[] = [];
  let httpCallsDetected = 0;

  // Iterate scanned files in alphabetical order for deterministic emission.
  const candidates = [...scan.files]
    .filter((f) => f.language !== undefined)
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  for (const f of candidates) {
    if (f.language === undefined) continue;
    const provider = getProvider(f.language);
    if (provider.detectOutboundHttp === undefined) continue;

    let content: string;
    try {
      const buf = await fs.readFile(f.absPath);
      content = buf.toString("utf8");
    } catch (err) {
      ctx.onProgress?.({
        phase: FETCHES_PHASE_NAME,
        kind: "warn",
        message: `fetches: cannot read ${f.relPath}: ${(err as Error).message}`,
      });
      continue;
    }

    const calls = provider.detectOutboundHttp({
      filePath: f.relPath,
      captures: [],
      sourceText: content,
    });
    if (calls.length === 0) continue;

    const defs = parse.definitionsByFile.get(f.relPath) ?? [];

    for (const call of calls) {
      httpCallsDetected += 1;
      const from = enclosingSymbolId(defs, call, f.relPath);
      const key = routeKey(call.method, call.urlTemplate);
      const localRoute = routes.byKey.get(key);
      if (localRoute !== undefined) {
        pending.push({
          from,
          to: localRoute,
          method: call.method,
          urlTemplate: call.urlTemplate,
          clientLibrary: call.clientLibrary,
          startLine: call.startLine,
          resolved: true,
        });
      } else {
        const placeholder = `${UNRESOLVED_FETCH_TARGET_PREFIX}${call.method}:${call.urlTemplate}`;
        pending.push({
          from,
          to: placeholder,
          method: call.method,
          urlTemplate: call.urlTemplate,
          clientLibrary: call.clientLibrary,
          startLine: call.startLine,
          resolved: false,
        });
      }
    }
  }

  // Deterministic sort before emit so two runs produce identical edges.
  pending.sort((a, b) => {
    if (a.from !== b.from) return (a.from as string) < (b.from as string) ? -1 : 1;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    if (a.urlTemplate !== b.urlTemplate) return a.urlTemplate < b.urlTemplate ? -1 : 1;
    if (a.clientLibrary !== b.clientLibrary) return a.clientLibrary < b.clientLibrary ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return 0;
  });

  let edgesEmitted = 0;
  let unresolvedCount = 0;
  for (const p of pending) {
    const edge: Omit<CodeRelation, "id"> = {
      from: p.from,
      to: p.to as NodeId,
      type: "FETCHES",
      confidence: p.resolved ? 0.8 : 0.5,
      reason: p.resolved
        ? `${p.clientLibrary}:${p.method}:${p.urlTemplate}`
        : `unresolved:${p.clientLibrary}:${p.method}:${p.urlTemplate}`,
    };
    ctx.graph.addEdge(edge);
    edgesEmitted += 1;
    if (!p.resolved) unresolvedCount += 1;
  }

  return { httpCallsDetected, edgesEmitted, unresolvedCount };
}

function enclosingSymbolId(
  defs: readonly import("../../providers/extraction-types.js").ExtractedDefinition[],
  call: HttpCall,
  filePath: string,
): NodeId {
  let best: (typeof defs)[number] | undefined;
  for (const d of defs) {
    if (!CALLABLE_KINDS.has(d.kind)) continue;
    if (call.startLine < d.startLine || call.startLine > d.endLine) continue;
    if (best === undefined || d.startLine > best.startLine) best = d;
  }
  if (best === undefined) {
    return makeNodeId("File", filePath, filePath);
  }
  return makeNodeId(best.kind, best.filePath, best.qualifiedName, {
    ...(best.parameterCount !== undefined ? { parameterCount: best.parameterCount } : {}),
    ...(best.parameterTypes !== undefined ? { parameterTypes: best.parameterTypes } : {}),
    ...(best.isConst !== undefined ? { isConst: best.isConst } : {}),
  });
}
