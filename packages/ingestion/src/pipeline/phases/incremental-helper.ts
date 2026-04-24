/**
 * Shared incremental-scope consumer helpers.
 *
 * Flips the four expensive post-parse phases — crossFile, mro,
 * communities, processes — from passive to active incremental mode. Each
 * consumer reads {@link IncrementalScopeOutput} from `ctx.phaseOutputs` and
 * asks three questions:
 *   1. Should I recompute at all? (no when mode=incremental AND
 *      closureFiles is empty AND there is a prior graph to carry forward).
 *   2. Which files make up the recompute scope? (allFiles when mode=full,
 *      closureFiles when mode=incremental).
 *   3. Can I carry forward prior nodes / edges whose anchor is outside the
 *      scope? (yes iff `previousGraph.nodes` and `previousGraph.edges`
 *      were supplied alongside `options.incrementalFrom`).
 *
 * The answers must be a pure function of (ctx.options.incrementalFrom,
 * ctx.phaseOutputs["incremental-scope"]) so a subsequent full run at the
 * same commit produces a byte-identical graph hash. That determinism gate
 * is exercised in `packages/ingestion/src/pipeline/incremental-determinism.test.ts`.
 */

import type { CodeRelation, GraphNode } from "@opencodehub/core-types";
import type { PipelineContext, PreviousGraph } from "../types.js";
import { INCREMENTAL_SCOPE_PHASE_NAME, type IncrementalScopeOutput } from "./incremental-scope.js";

/**
 * Snapshot passed from incremental phases into their own runners. `active`
 * means "run incremental carry-forward logic"; when `false` the phase must
 * execute its full-graph codepath.
 */
export interface IncrementalScopeView {
  /**
   * When true the phase should carry forward non-closure work from
   * `previousGraph` and only recompute for closure files. When false the
   * phase runs the full-graph path exactly as it did in v1.0.
   */
  readonly active: boolean;
  /**
   * Closure file set, as an immutable Set for O(1) membership checks.
   * Meaningful only when `active === true`.
   */
  readonly closure: ReadonlySet<string>;
  /**
   * Raw output of the incremental-scope phase. Exposed for phases that want
   * to log mode / ratio without re-reading it themselves.
   */
  readonly scope: IncrementalScopeOutput | undefined;
  /**
   * Prior-run graph snapshot. Present only when `options.incrementalFrom`
   * was supplied; its `nodes`/`edges` fields drive carry-forward. Phases
   * still receive the projection even when `active === false` (e.g. for
   * diagnostics) — they just must not consult it.
   */
  readonly previousGraph: PreviousGraph | undefined;
}

/**
 * Resolve the incremental view from a phase's context.
 *
 * Active mode requires all three conditions:
 *   - `options.incrementalFrom` was supplied by the caller,
 *   - the incremental-scope phase ran and emitted `mode="incremental"`,
 *   - the carry-forward projection (`nodes` + `edges`) is present on the
 *     `PreviousGraph`.
 *
 * When any condition is false the view returns `active: false` and the
 * caller should fall through to the full-graph path. The
 * incremental-scope phase's own 30% safety valve already flips `mode` to
 * `"full"` when the closure is too big, so consumers need not re-check the
 * ratio themselves.
 */
export function resolveIncrementalView(ctx: PipelineContext): IncrementalScopeView {
  const scope = ctx.phaseOutputs.get(INCREMENTAL_SCOPE_PHASE_NAME) as
    | IncrementalScopeOutput
    | undefined;
  const prior = ctx.options.incrementalFrom;
  if (scope === undefined || prior === undefined) {
    return {
      active: false,
      closure: new Set<string>(),
      scope,
      previousGraph: prior,
    };
  }
  if (scope.mode !== "incremental") {
    return {
      active: false,
      closure: new Set<string>(),
      scope,
      previousGraph: prior,
    };
  }
  // Carry-forward requires the full node/edge snapshot. Without it we
  // cannot produce a byte-identical graph, so degrade to the full path.
  if (prior.nodes === undefined || prior.edges === undefined) {
    return {
      active: false,
      closure: new Set<string>(),
      scope,
      previousGraph: prior,
    };
  }
  return {
    active: true,
    closure: new Set<string>(scope.closureFiles),
    scope,
    previousGraph: prior,
  };
}

/**
 * A node "belongs" to the closure when its defining file sits in the
 * closure set, OR when its `filePath` is the sentinel "<global>" used for
 * Community / process-like nodes that have no natural file anchor. For
 * `<global>` we treat the node as closure when ANY of its referenced
 * members are closure files (resolved via the community's MEMBER_OF edges
 * at carry-forward time — the helpers below surface this as "global" and
 * let the phase decide).
 */
export function isNodeInClosure(node: GraphNode, closure: ReadonlySet<string>): boolean {
  if (node.filePath === "<global>") return false;
  return closure.has(node.filePath);
}

/**
 * Partition the prior graph's edges into carry-forward candidates + in-
 * scope edges. Edges are carried forward when BOTH endpoints map to a
 * path outside the closure OR to a prior node with `filePath` outside the
 * closure. The caller provides a resolver from node id → filePath built
 * over the prior node set; ids the resolver cannot place are conservative-
 * dropped from the carry-forward set.
 */
export function partitionPriorEdges(
  priorEdges: readonly CodeRelation[],
  filePathByNodeId: ReadonlyMap<string, string>,
  closure: ReadonlySet<string>,
  edgeTypes: ReadonlySet<string>,
): readonly CodeRelation[] {
  const out: CodeRelation[] = [];
  for (const e of priorEdges) {
    if (!edgeTypes.has(e.type)) continue;
    const fromPath = filePathByNodeId.get(e.from as string);
    const toPath = filePathByNodeId.get(e.to as string);
    if (fromPath === undefined || toPath === undefined) continue;
    // Both endpoints outside the closure → carry forward unchanged.
    const fromInClosure = fromPath !== "<global>" && closure.has(fromPath);
    const toInClosure = toPath !== "<global>" && closure.has(toPath);
    if (fromInClosure || toInClosure) continue;
    out.push(e);
  }
  return out;
}

/**
 * Build a (nodeId → filePath) lookup from a prior-graph node snapshot.
 * The map participates in partitioning prior edges; nodes missing from
 * the map force their attached edges into the "recompute" bucket (safe
 * default — a false recompute only trades performance, never correctness).
 */
export function buildFilePathLookup(priorNodes: readonly GraphNode[]): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const n of priorNodes) m.set(n.id, n.filePath);
  return m;
}
