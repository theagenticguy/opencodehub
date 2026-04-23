/**
 * Community-level truck-factor aggregation.
 *
 * Strategy: union every member File's per-contributor line count into a single
 * vector, then compute the corrected Gini → bus-factor mapping the temporal
 * phase already uses for File nodes. This collapses "how many people does the
 * community depend on" into a single integer without the simple-min failure
 * mode (one single-owner test file would otherwise tank an entire community).
 *
 * The vector is the sum of each contributor's lines across all member files,
 * so a contributor who owns 50 lines in file A and 30 lines in file B
 * contributes 80 lines to the community vector.
 */

import { busFactor } from "../phases/temporal-helpers/gini.js";
import type { ContributorWeight } from "./line-overlap.js";

export interface CommunityTruckFactorInput {
  /** One entry per member File — the contributor line-share vector for that file. */
  readonly memberFiles: ReadonlyArray<readonly ContributorWeight[]>;
}

/**
 * Compute the community truck factor. Empty input → 1 (a community with no
 * ownership signals is maximally concentrated by default).
 */
export function communityTruckFactor(input: CommunityTruckFactorInput): number {
  const totals = new Map<string, number>();
  for (const fileContribs of input.memberFiles) {
    for (const contrib of fileContribs) {
      if (contrib.lines <= 0) continue;
      totals.set(contrib.email, (totals.get(contrib.email) ?? 0) + contrib.lines);
    }
  }
  if (totals.size === 0) return 1;
  return busFactor([...totals.values()]);
}
