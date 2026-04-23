/**
 * Exponentially-decayed churn weighting.
 *
 * Given a committer timestamp (epoch seconds) and a reference "now" (also
 * epoch seconds), return the decay weight applied to the commit's lines
 * changed. A 90-day half-life is the default: a 0-day-old commit contributes
 * 1.0× its line count, a 90-day-old commit contributes 0.5×, and a 180-day-
 * old commit contributes 0.25×.
 *
 * Future-dated commits (timestamps after `now`) are clamped to 0 age so the
 * weight never exceeds 1.0.
 */

export const DEFAULT_CHURN_HALF_LIFE_DAYS = 90;
const SECONDS_PER_DAY = 86_400;

/**
 * Compute the decay weight in [0, 1] for a commit's churn contribution.
 *
 * @param commitCtEpochSec committer timestamp in epoch seconds
 * @param nowEpochSec reference "now" timestamp in epoch seconds
 * @param halfLifeDays half-life; must be positive
 */
export function decayWeight(
  commitCtEpochSec: number,
  nowEpochSec: number,
  halfLifeDays: number = DEFAULT_CHURN_HALF_LIFE_DAYS,
): number {
  if (halfLifeDays <= 0) {
    throw new Error("decayWeight: halfLifeDays must be > 0");
  }
  const rawAgeSec = nowEpochSec - commitCtEpochSec;
  const ageSec = rawAgeSec < 0 ? 0 : rawAgeSec;
  const ageDays = ageSec / SECONDS_PER_DAY;
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}
