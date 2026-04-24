/**
 * Risk scoring shared across impact analysis and change detection.
 *
 * The heuristic weights nearer dependents more heavily than distant ones:
 *   score = d1 * 3 + d2 * 1 + d3 * 0.3
 *
 * Thresholds are intentionally coarse so they map cleanly onto four human
 * risk buckets. Callers that need granular ranking should use the raw score
 * instead.
 */

import type { RiskLevel } from "./types.js";

/** Per-grade orphan multiplier. Matches `ingestion/ownership-helpers/orphan.ts`. */
export type OrphanGrade = "active" | "orphaned" | "abandoned" | "fossilized";

export function scoreFromDepths(d1: number, d2: number, d3: number): number {
  return d1 * 3 + d2 * 1 + d3 * 0.3;
}

export function riskFromScore(score: number): RiskLevel {
  if (score >= 30) return "CRITICAL";
  if (score >= 10) return "HIGH";
  if (score >= 3) return "MEDIUM";
  return "LOW";
}

/** Convenience: risk from a flat symbol count (used by detect-changes). */
export function riskFromCount(count: number): RiskLevel {
  // Treat all changes as depth-1 dependents. Keeps the heuristic simple while
  // still crossing the same thresholds as the multi-depth form.
  return riskFromScore(scoreFromDepths(count, 0, 0));
}

/**
 * Per-grade multiplier applied to a raw risk score when any traversed file
 * has a non-`active` orphan grade. Fossilised + abandoned share the top
 * weight (1.6) because they both indicate code no live author still holds
 * in working memory; orphaned sits in the middle (1.3); active is a no-op.
 */
export function orphanMultiplier(grade: OrphanGrade | undefined): number {
  switch (grade) {
    case "orphaned":
      return 1.3;
    case "abandoned":
      return 1.6;
    case "fossilized":
      return 1.6;
    case "active":
    case undefined:
      return 1.0;
    default: {
      const _exhaust: never = grade;
      void _exhaust;
      return 1.0;
    }
  }
}

/**
 * Pick the maximum orphan multiplier across a sequence of per-file grades.
 * Empty input → 1.0 (multiplicative identity). Used by impact analysis to
 * bump risk when the blast radius lands on abandoned code paths.
 */
export function maxOrphanMultiplier(grades: Iterable<OrphanGrade | undefined>): number {
  let max = 1.0;
  for (const g of grades) {
    const m = orphanMultiplier(g);
    if (m > max) max = m;
  }
  return max;
}
