/**
 * Public types for the diff-scoped change-pack capability.
 *
 * A change-pack is a deterministic, diff-scoped object with four sections:
 * the impacted subgraph (the union of per-symbol upstream fan-outs, retained
 * rather than collapsed to a scalar), the composite verdict, the affected
 * tests (which impact analysis classifies-then-drops today), and a
 * cost-attribution estimate. Every field is readonly so results can cross
 * serialization boundaries without defensive copying.
 */

import type { VerdictResponse } from "./verdict-types.js";

/** Input options accepted by `runChangePack`. */
export interface ChangePackQuery {
  readonly repoPath: string;
  /** Base git ref (default: "main"). */
  readonly base?: string;
  /** Head git ref (default: "HEAD"). */
  readonly head?: string;
  /** Upstream traversal depth cap (default: 4). */
  readonly depth?: number;
  /** Traversal confidence floor (default: 0.7). */
  readonly minConfidence?: number;
  /**
   * Context budget in heuristic tokens. Recorded in the hashed envelope for
   * provenance; v1 does not enforce trimming (default: 100_000).
   */
  readonly budget?: number;
  /**
   * When false (default), the impacted subgraph reflects production code only
   * — test-path nodes surface exclusively in `affectedTests`, matching the
   * verdict's production-only blast radius. When true, tests are also
   * retained in the subgraph.
   */
  readonly includeTestsInSubgraph?: boolean;
}

/** A changed symbol resolved from the diff. */
export interface ChangedSymbol {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly kind: string;
}

/**
 * One node in the impacted subgraph. `minDepth` is the shallowest depth at
 * which this node was reached across every per-symbol upstream fan-out.
 */
export interface ImpactedSubgraphNode {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly kind: string;
  readonly minDepth: number;
}

/** One edge in the impacted subgraph (deduplicated by `from`/`type`/`to`). */
export interface ImpactedSubgraphEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly confidence: number;
}

/**
 * The retained impacted subgraph: the union of every per-symbol upstream
 * fan-out, deduplicated. `truncated` is true when the node set was capped at
 * the hard ceiling.
 */
export interface ImpactedSubgraph {
  readonly nodes: readonly ImpactedSubgraphNode[];
  readonly edges: readonly ImpactedSubgraphEdge[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly truncated: boolean;
}

/** One test reached by an upstream fan-out from a changed symbol. */
export interface AffectedTest {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  /** Id of the changed symbol this test was first reached from. */
  readonly reachedFromSymbol: string;
  /** Shallowest depth at which the test was reached. */
  readonly depth: number;
}

/**
 * Cost attribution for the change-pack. All token figures are estimates from
 * a character heuristic, never model-tokenizer counts — `estimate` is always
 * true and `tokenizerModel` self-labels the basis.
 */
export interface CostAttribution {
  readonly estimate: true;
  readonly tokenizerModel: "char-heuristic-v1";
  /** Heuristic tokens for the change-pack context body the agent consumes. */
  readonly changePackTokens: number;
  /** Heuristic tokens an agent would read by opening every impacted file blind. */
  readonly blindBaselineTokens: number;
  readonly tokensSaved: number;
  readonly tokensSavedPct: number;
  readonly affectedTestCount: number;
  readonly totalTestCount: number;
  readonly ciTestsSkipped: number;
}

/** The full diff-scoped change-pack. */
export interface ChangePack {
  readonly changedFiles: readonly string[];
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly impactedSubgraph: ImpactedSubgraph;
  readonly verdict: VerdictResponse;
  readonly affectedTests: readonly AffectedTest[];
  readonly costAttribution: CostAttribution;
  readonly changePackHash: string;
}
