/**
 * Ownership drift helpers.
 *
 * For each of three rolling windows (30, 90, 365 days) we compute the stddev
 * of the top-3 contributors' line share across the window. A high stddev
 * implies ownership changed hands inside the window; a low stddev implies
 * steady ownership.
 *
 * Sampling plan (see research notes §9):
 *   - 30d window: 4 weekly samples.
 *   - 90d window: 13 weekly samples.
 *   - 365d window: 52 weekly samples.
 *
 * Samples are anchored to `nowEpochSec`. At each sample tick we project the
 * set of commits whose `ct <= tick` down onto each contributor's cumulative
 * line share and record the top-3 contributors' shares. Stddev is taken over
 * the concatenation of the three contributors' share vectors across ticks.
 */

export interface CommitContribution {
  /** Epoch seconds of the committer timestamp. */
  readonly ctEpochSec: number;
  /** Per-contributor line counts this commit applied. */
  readonly contributions: ReadonlyMap<string, number>;
}

export interface OwnershipDriftInput {
  /** History of per-commit contribution events across the target (file or community). */
  readonly commits: readonly CommitContribution[];
  /** Reference "now" in epoch seconds. */
  readonly nowEpochSec: number;
}

export interface OwnershipDriftResult {
  readonly drift30d: number;
  readonly drift90d: number;
  readonly drift365d: number;
}

const DAY_SEC = 86_400;
const WEEK_SEC = 7 * DAY_SEC;

/**
 * Compute the three rolling drift values. Windows with fewer than two samples
 * yield drift = 0 (no variation detectable).
 */
export function computeOwnershipDrift(input: OwnershipDriftInput): OwnershipDriftResult {
  return {
    drift30d: driftForWindow(input, 30 * DAY_SEC, 4),
    drift90d: driftForWindow(input, 90 * DAY_SEC, 13),
    drift365d: driftForWindow(input, 365 * DAY_SEC, 52),
  };
}

function driftForWindow(
  input: OwnershipDriftInput,
  windowSec: number,
  sampleCount: number,
): number {
  if (sampleCount < 2) return 0;
  const windowStart = input.nowEpochSec - windowSec;
  // Filter commits inside the window; we still want older commits for the
  // "prior share" baseline but they don't contribute new line-share movement
  // within the window.
  const relevantCommits = input.commits.filter((c) => c.ctEpochSec >= windowStart);
  if (relevantCommits.length === 0) return 0;

  const sortedCommits = [...input.commits].sort((a, b) => a.ctEpochSec - b.ctEpochSec);
  const sampleTicks: number[] = [];
  // Tick spacing: one per week, capped at `sampleCount` ticks, newest last.
  for (let i = sampleCount - 1; i >= 0; i -= 1) {
    const tickSec = input.nowEpochSec - i * WEEK_SEC;
    if (tickSec < windowStart) continue;
    sampleTicks.push(tickSec);
  }
  if (sampleTicks.length < 2) return 0;

  // For each tick, compute cumulative shares and pick top-3 by cumulative
  // lines. Track each selected contributor's share at the tick.
  const perContributorShares = new Map<string, number[]>();
  const cumulative = new Map<string, number>();
  let sortedIdx = 0;

  for (const tickSec of sampleTicks) {
    while (sortedIdx < sortedCommits.length) {
      const commit = sortedCommits[sortedIdx];
      if (commit === undefined) break;
      if (commit.ctEpochSec > tickSec) break;
      for (const [email, lines] of commit.contributions) {
        cumulative.set(email, (cumulative.get(email) ?? 0) + lines);
      }
      sortedIdx += 1;
    }
    let total = 0;
    for (const v of cumulative.values()) total += v;
    if (total === 0) continue;
    const top3 = [...cumulative.entries()]
      .sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      })
      .slice(0, 3);
    for (const [email, lines] of top3) {
      const share = lines / total;
      const arr = perContributorShares.get(email);
      if (arr === undefined) perContributorShares.set(email, [share]);
      else arr.push(share);
    }
  }
  // Flatten shares across top-3 contributors and compute stddev.
  const flat: number[] = [];
  for (const arr of perContributorShares.values()) {
    for (const v of arr) flat.push(v);
  }
  if (flat.length < 2) return 0;
  return round4(stddev(flat));
}

function stddev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of values) {
    const d = v - mean;
    variance += d * d;
  }
  variance /= n; // population stddev — fixture tests prefer this form.
  return Math.sqrt(variance);
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10_000) / 10_000;
}
