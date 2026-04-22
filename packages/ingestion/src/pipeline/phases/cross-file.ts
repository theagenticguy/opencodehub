/**
 * Cross-file phase — upgrade low-confidence CALLS edges after every file
 * has contributed its exports.
 *
 * At parse time every call site is resolved through the three-tier
 * {@link resolve} helper (same-file → import-scoped → global). A call that
 * only matches at the global tier is emitted with confidence 0.5 because we
 * cannot prove which declaration the call targets. Once the whole repo has
 * been parsed we can do better: if the caller file imports a module that
 * now exports a matching identifier, the call is *import-scoped* in
 * hindsight and deserves confidence 0.9.
 *
 * Strategy:
 *  1. Build a directed import graph of repository files (skip external npm
 *     specifiers — they were already dropped at parse time).
 *  2. Run Tarjan's SCC algorithm on that graph. Circular imports collapse
 *     into a single component; we still visit every file in a component.
 *  3. Topologically sort the condensation so dependencies of file F are
 *     processed before F. Inside a component, order by filename for
 *     determinism.
 *  4. For each file, walk every low-confidence (0.5) CALLS edge. Re-run
 *     the resolution strategy with the symbol index. If it now produces a
 *     higher-tier candidate, re-add the edge with the better confidence;
 *     the graph's dedupe keeps the stronger edge.
 *
 * Determinism: SCC discovery order is driven by sorted file iteration, and
 * condensation order is produced by Kahn's algorithm with a lexical tie
 * break. Two runs on the same repo produce identical edge upgrades.
 */

import { makeNodeId, type NodeId } from "@opencodehub/core-types";
import { getProvider } from "../../providers/registry.js";
import {
  CONFIDENCE_BY_TIER,
  resolve,
  type SymbolIndex,
} from "../../providers/resolution/context.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import {
  buildFilePathLookup,
  partitionPriorEdges,
  resolveIncrementalView,
} from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { ORM_PHASE_NAME } from "./orm.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
import { ROUTES_PHASE_NAME } from "./routes.js";
import { TOOLS_PHASE_NAME } from "./tools.js";

export const CROSS_FILE_PHASE_NAME = "crossFile";

export interface CrossFileOutput {
  readonly upgradedCallsCount: number;
  readonly unresolvedRemaining: number;
  readonly sccCount: number;
  /** File SCCs with more than five members — typically cyclic import webs. */
  readonly largeSccs: readonly string[];
}

export const crossFilePhase: PipelinePhase<CrossFileOutput> = {
  name: CROSS_FILE_PHASE_NAME,
  deps: [
    PARSE_PHASE_NAME,
    ROUTES_PHASE_NAME,
    TOOLS_PHASE_NAME,
    ORM_PHASE_NAME,
    INCREMENTAL_SCOPE_PHASE_NAME,
  ],
  async run(ctx, deps) {
    const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;
    if (parse === undefined) {
      throw new Error("crossFile: parse output missing from dependency map");
    }
    return runCrossFile(ctx, parse);
  },
};

function runCrossFile(ctx: PipelineContext, parse: ParseOutput): CrossFileOutput {
  // ---- 0. Stream L: incremental-scope carry-forward. --------------------
  //
  // When the incremental view is active we first splat every prior-graph
  // CALLS upgrade whose endpoints both live OUTSIDE the current closure
  // into `ctx.graph`. The post-parse graph already carries the 0.5-tier
  // CALLS; replaying the prior cross-file upgrades lets us skip work for
  // non-closure files while keeping the final edge set byte-identical to
  // a full run at the same commit. Determinism gate: see
  // `packages/ingestion/src/pipeline/incremental-determinism.test.ts`.
  const view = resolveIncrementalView(ctx);
  if (
    view.active &&
    view.previousGraph?.edges !== undefined &&
    view.previousGraph.nodes !== undefined
  ) {
    const filePathByNodeId = buildFilePathLookup(view.previousGraph.nodes);
    const carried = partitionPriorEdges(
      view.previousGraph.edges,
      filePathByNodeId,
      view.closure,
      new Set(["CALLS"]),
    );
    for (const e of carried) {
      if (e.confidence <= CONFIDENCE_BY_TIER.global) continue;
      ctx.graph.addEdge({
        from: e.from,
        to: e.to,
        type: e.type,
        confidence: e.confidence,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      });
    }
  }

  // ---- 1. Build the import graph restricted to files we actually parsed. -
  // In incremental mode we narrow the SCC+upgrade walk to closure files;
  // the carry-forward above covers the non-closure tail.
  const parsedFiles: readonly string[] = view.active
    ? [...parse.definitionsByFile.keys()].filter((f) => view.closure.has(f)).sort()
    : [...parse.definitionsByFile.keys()].sort();
  const parsedSet = new Set(parsedFiles);

  const adjacency = new Map<string, string[]>();
  for (const f of parsedFiles) adjacency.set(f, []);

  // Walk the graph's IMPORTS edges — they were already resolved to in-repo
  // File nodes at parse time, so we get the import graph for free without
  // re-running path resolution.
  for (const edge of ctx.graph.edges()) {
    if (edge.type !== "IMPORTS") continue;
    const from = nodeIdToFilePath(edge.from as string);
    const to = nodeIdToFilePath(edge.to as string);
    if (from === undefined || to === undefined) continue;
    if (!parsedSet.has(from) || !parsedSet.has(to)) continue;
    const list = adjacency.get(from);
    if (list !== undefined && !list.includes(to)) list.push(to);
  }
  for (const [n, list] of adjacency) {
    list.sort();
    adjacency.set(n, list);
  }

  // ---- 2. Tarjan SCC on the import graph. -------------------------------
  const sccs = tarjanScc(parsedFiles, adjacency);
  const sccIndex = new Map<string, number>();
  sccs.forEach((members, i) => {
    for (const m of members) sccIndex.set(m, i);
  });

  // ---- 3. Kahn topo-sort over the condensation. -------------------------
  const condensationAdj = new Map<number, Set<number>>();
  for (let i = 0; i < sccs.length; i++) condensationAdj.set(i, new Set());
  for (const [from, neighbors] of adjacency) {
    const fi = sccIndex.get(from);
    if (fi === undefined) continue;
    for (const to of neighbors) {
      const ti = sccIndex.get(to);
      if (ti === undefined || ti === fi) continue;
      condensationAdj.get(fi)?.add(ti);
    }
  }
  const condensationOrder = kahnCondensation(condensationAdj);

  // ---- 4. Process files in SCC-topo order; inside a component, by name. -
  let upgradedCallsCount = 0;
  let unresolvedRemaining = 0;
  const largeSccs: string[] = [];
  for (const idx of condensationOrder) {
    const members = sccs[idx];
    if (members === undefined) continue;
    if (members.length > 5) {
      // Name the component by its lexicographically smallest member for a
      // stable identifier across runs.
      const smallest = [...members].sort()[0];
      if (smallest !== undefined) largeSccs.push(smallest);
    }
    const sortedMembers = [...members].sort();
    for (const filePath of sortedMembers) {
      const upgraded = reresolveCallsForFile(ctx, parse.symbolIndex, parse, filePath);
      upgradedCallsCount += upgraded.upgraded;
      unresolvedRemaining += upgraded.stillUnresolved;
    }
  }

  return {
    upgradedCallsCount,
    unresolvedRemaining,
    sccCount: sccs.length,
    largeSccs,
  };
}

function reresolveCallsForFile(
  ctx: PipelineContext,
  symbolIndex: SymbolIndex,
  parse: ParseOutput,
  filePath: string,
): { upgraded: number; stillUnresolved: number } {
  // We compare against the edges already emitted at parse time: pick only
  // CALLS edges whose source file matches `filePath` and whose confidence
  // is capped at the global tier (0.5). Anything higher is already as
  // strong as we can make it.
  const defs = parse.definitionsByFile.get(filePath) ?? [];
  const calls = parse.callsByFile.get(filePath) ?? [];
  if (calls.length === 0) return { upgraded: 0, stillUnresolved: 0 };

  // Build a quick lookup from qualified name → current definition's id so we
  // can re-derive the caller id without walking the whole graph per call.
  const callerIdByQualifiedName = new Map<string, NodeId>();
  for (const d of defs) {
    const id = makeNodeId(d.kind, d.filePath, d.qualifiedName, {
      ...(d.parameterCount !== undefined ? { parameterCount: d.parameterCount } : {}),
      ...(d.parameterTypes !== undefined ? { parameterTypes: d.parameterTypes } : {}),
      ...(d.isConst !== undefined ? { isConst: d.isConst } : {}),
    });
    callerIdByQualifiedName.set(d.qualifiedName, id);
  }
  const fileNodeId = makeNodeId("File", filePath, filePath);

  const language = parse.definitionsByFile.has(filePath)
    ? inferLanguageFromFile(filePath)
    : undefined;
  if (language === undefined) return { upgraded: 0, stillUnresolved: 0 };
  const provider = getProvider(language);

  let upgraded = 0;
  let stillUnresolved = 0;

  for (const call of calls) {
    const callerId =
      call.callerQualifiedName === "<module>"
        ? fileNodeId
        : callerIdByQualifiedName.get(call.callerQualifiedName);
    if (callerId === undefined) continue;

    const candidates = resolve(
      { callerFile: filePath, calleeName: call.calleeName, provider },
      symbolIndex,
    );
    const first = candidates[0];
    if (first === undefined) {
      stillUnresolved += 1;
      continue;
    }
    // Only upgrade when the resolved tier is above the global floor.
    if (first.confidence > CONFIDENCE_BY_TIER.global) {
      ctx.graph.addEdge({
        from: callerId,
        to: first.targetId as NodeId,
        type: "CALLS",
        confidence: first.confidence,
        reason: `cross-file-${first.tier}`,
      });
      upgraded += 1;
    }
  }

  return { upgraded, stillUnresolved };
}

function inferLanguageFromFile(
  filePath: string,
):
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "c"
  | "cpp"
  | "ruby"
  | "kotlin"
  | "swift"
  | "php"
  | "dart"
  | undefined {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return undefined;
  const ext = filePath.slice(idx).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".py":
    case ".pyi":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".cs":
      return "csharp";
    case ".c":
    case ".h":
      // .h is ambiguous between C/C++; default to C. A dedicated C++ header
      // detector can upgrade the classification later.
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".hh":
    case ".hxx":
      return "cpp";
    case ".rb":
      return "ruby";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".php":
    case ".php3":
    case ".php4":
    case ".php5":
    case ".php7":
    case ".phtml":
      return "php";
    case ".dart":
      return "dart";
    default:
      return undefined;
  }
}

/**
 * Recover a File's relative path from a `File:<path>:<qn>` node id. Returns
 * undefined for non-file ids.
 */
function nodeIdToFilePath(id: string): string | undefined {
  if (!id.startsWith("File:")) return undefined;
  const after = id.slice("File:".length);
  // File ids are `File:<path>:<path>` — the qualifiedName equals the path.
  // Splitting on the middle colon is robust even when the path contains
  // colons on Windows (we normalize to POSIX at scan time).
  const colonIdx = after.indexOf(":");
  if (colonIdx < 0) return after;
  return after.slice(0, colonIdx);
}

/**
 * Iterative Tarjan strongly-connected-components.
 * Input: sorted `nodes` list + adjacency map with sorted neighbor lists.
 * Output: array of SCCs; each SCC is the sorted list of its members.
 * Components are emitted in the order Tarjan discovers them, which — given
 * pre-sorted inputs — is deterministic.
 */
function tarjanScc(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const result: string[][] = [];

  // Iterative simulation so deep call chains don't blow the stack.
  function strongConnect(start: string): void {
    const dfsStack: { node: string; it: number }[] = [{ node: start, it: 0 }];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (dfsStack.length > 0) {
      const frame = dfsStack[dfsStack.length - 1];
      if (frame === undefined) break;
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.it < neighbors.length) {
        const next = neighbors[frame.it] as string;
        frame.it += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          lowlink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          dfsStack.push({ node: next, it: 0 });
        } else if (onStack.has(next)) {
          const cur = lowlink.get(frame.node) ?? 0;
          const nxt = index.get(next) ?? 0;
          lowlink.set(frame.node, Math.min(cur, nxt));
        }
      } else {
        // Finished `frame.node`: propagate to parent and maybe emit a SCC.
        const low = lowlink.get(frame.node) ?? 0;
        const idx = index.get(frame.node) ?? 0;
        if (low === idx) {
          const component: string[] = [];
          while (stack.length > 0) {
            const w = stack.pop() as string;
            onStack.delete(w);
            component.push(w);
            if (w === frame.node) break;
          }
          component.sort();
          result.push(component);
        }
        dfsStack.pop();
        const parent = dfsStack[dfsStack.length - 1];
        if (parent !== undefined) {
          const parentLow = lowlink.get(parent.node) ?? 0;
          const childLow = lowlink.get(frame.node) ?? 0;
          lowlink.set(parent.node, Math.min(parentLow, childLow));
        }
      }
    }
  }

  for (const n of nodes) {
    if (!index.has(n)) strongConnect(n);
  }
  return result;
}

/**
 * Kahn's algorithm on a condensation (DAG over SCC indices). Returns an
 * ordering of SCC indices such that each component is emitted before any
 * component that depends on it. Tiebreak: smaller index first (the index
 * already corresponds to SCC discovery order, which is deterministic).
 */
function kahnCondensation(adj: ReadonlyMap<number, ReadonlySet<number>>): number[] {
  const indeg = new Map<number, number>();
  for (const i of adj.keys()) indeg.set(i, 0);
  for (const [, outs] of adj) {
    for (const o of outs) indeg.set(o, (indeg.get(o) ?? 0) + 1);
  }
  const ready: number[] = [];
  for (const [i, d] of indeg) if (d === 0) ready.push(i);
  ready.sort((a, b) => a - b);

  const out: number[] = [];
  while (ready.length > 0) {
    const n = ready.shift() as number;
    out.push(n);
    const outs = adj.get(n) ?? new Set<number>();
    for (const next of outs) {
      const d = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, d);
      if (d === 0) {
        let i = 0;
        while (i < ready.length && (ready[i] ?? 0) < next) i += 1;
        ready.splice(i, 0, next);
      }
    }
  }
  return out;
}
