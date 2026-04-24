/**
 * Verdict engine types.
 *
 * A verdict is the 5-tier composite signal emitted for a diff: one of
 * `auto_merge`, `single_review`, `dual_review`, `expert_review`, or
 * `block`. Every field is readonly so results can cross serialization
 * boundaries without defensive copying.
 *
 * Tier semantics (ordered by escalation):
 *   - `auto_merge`     — bot-safe; no human needed.
 *   - `single_review`  — one reviewer sufficient.
 *   - `dual_review`    — two reviewers required; cross-community or orphan risk.
 *   - `expert_review`  — owner / maintainer sign-off required; large blast.
 *   - `block`          — reject; requires split or additional guard rails.
 *
 * Exit-code mapping (hard constraint per PRD §F.1):
 *   - auto_merge, single_review  → 0
 *   - dual_review                → 1
 *   - expert_review, block       → 2
 */

/** Ordered, least-to-most escalation. */
export type VerdictTier =
  | "auto_merge"
  | "single_review"
  | "dual_review"
  | "expert_review"
  | "block";

/**
 * How close this verdict is to flipping to the next tier.
 *
 * `distancePercent` is in [0, 100]: 0 = right at the boundary, 100 = far from
 * the next tier. `nextTier` is the tier one above the current one, or `null`
 * when the current tier is `block` (there is no next tier).
 */
export interface DecisionBoundary {
  readonly distancePercent: number;
  readonly nextTier: VerdictTier | null;
}

/** One line of reasoning that drove the verdict. */
export interface ReasoningSignal {
  readonly label: string;
  readonly value: number | string;
  readonly severity: "info" | "warn" | "error";
}

/** One reviewer recommendation derived from OWNED_BY edges. */
export interface RecommendedReviewer {
  readonly email: string;
  readonly emailHash: string;
  readonly name: string;
  readonly weight: number;
}

/** Top-level verdict response. */
export interface VerdictResponse {
  readonly verdict: VerdictTier;
  readonly confidence: number;
  readonly decisionBoundary: DecisionBoundary;
  readonly reasoningChain: readonly ReasoningSignal[];
  readonly recommendedReviewers: readonly RecommendedReviewer[];
  readonly githubLabels: readonly string[];
  readonly reviewCommentMarkdown: string;
  readonly exitCode: 0 | 1 | 2;
  /** Raw aggregated blast radius (max across affected symbols). */
  readonly blastRadius: number;
  /** Distinct community ids touched by the diff. */
  readonly communitiesTouched: readonly string[];
  /** Number of changed files. */
  readonly changedFileCount: number;
  /** Number of affected symbols. */
  readonly affectedSymbolCount: number;
}

/** Thresholds and tunables for the verdict algorithm. */
export interface VerdictConfig {
  /** Blast radius >= this → tier=block. Default 50. */
  readonly blockThreshold: number;
  /** Blast radius >= this → tier=expert_review. Default 20. */
  readonly escalationThreshold: number;
  /** Blast radius >= this → tier=dual_review (with other gates). Default 5. */
  readonly warningThreshold: number;
  /**
   * Minimum distinct communities touched to force dual_review when all other
   * gates are below thresholds. Default 3.
   */
  readonly communityBoundaryThreshold: number;
  /** When false, disable community-based escalation. Default true. */
  readonly communityBoundaryEscalation: boolean;
  /**
   * Fix-follow-feat density threshold that nudges a change into `single_review`.
   * Default 0.3.
   */
  readonly fixFollowFeatThreshold: number;
}

export const DEFAULT_VERDICT_CONFIG: VerdictConfig = Object.freeze({
  blockThreshold: 50,
  escalationThreshold: 20,
  warningThreshold: 5,
  communityBoundaryThreshold: 3,
  communityBoundaryEscalation: true,
  fixFollowFeatThreshold: 0.3,
});

/** Input options accepted by `computeVerdict`. */
export interface VerdictQuery {
  readonly repoPath: string;
  /** Base git ref (default: "main"). */
  readonly base?: string;
  /** Head git ref (default: "HEAD"). */
  readonly head?: string;
  /** Partial config override; unspecified fields fall back to defaults. */
  readonly config?: Partial<VerdictConfig>;
  /**
   * Optional pre-determined author email (to exclude from reviewer recs).
   * When omitted, `computeVerdict` will shell out to `git log` to discover
   * the HEAD author. Supplying it explicitly makes the function hermetic.
   */
  readonly authorEmail?: string;
}
