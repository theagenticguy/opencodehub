/**
 * Gini inequality coefficient and bus-factor proxy.
 *
 * The Gini coefficient is computed on a sorted contribution vector using the
 * O(n log n) mean-rank identity, which avoids the O(n^2) pairwise loop while
 * remaining numerically stable:
 *
 *   G = (2 * Σᵢ i·x[i]) / (n · Σx) − (n + 1) / n
 *
 * with `i` 1-indexed after ascending sort. G = 0 when all values are equal
 * and approaches 1 as inequality grows.
 *
 * Bus factor collapses inequality into an integer head-count proxy. The
 * corrected formula (see research notes) is:
 *
 *   busFactor = max(1, min(n, 1 + round((1 - G) · (n - 1))))
 *
 * which returns 1 for a single author, `n` for perfectly uniform contribution,
 * and 1 for a highly-skewed distribution.
 */

/**
 * Compute the Gini coefficient for a vector of non-negative contribution
 * counts. Zero, empty, and all-equal inputs all yield 0.
 */
export function gini(counts: readonly number[]): number {
  const n = counts.length;
  if (n === 0) return 0;
  let sum = 0;
  for (const v of counts) {
    if (v < 0) {
      throw new Error("gini: contribution counts must be non-negative");
    }
    sum += v;
  }
  if (sum === 0) return 0;
  // Ascending sort without mutating caller input.
  const sorted = [...counts].sort((a, b) => a - b);
  let weighted = 0;
  for (let i = 0; i < n; i += 1) {
    // i is 0-indexed here; the mean-rank identity expects 1-indexed ranks.
    weighted += (i + 1) * (sorted[i] ?? 0);
  }
  const g = (2 * weighted) / (n * sum) - (n + 1) / n;
  // Numerical clamp: floating-point error can produce tiny negatives or
  // slight overshoot past 1.
  if (g < 0) return 0;
  if (g > 1) return 1;
  return g;
}

/**
 * Derive the bus factor from a per-contributor count vector.
 *
 * Returns 1 when the vector is empty or contains only zero totals.
 */
export function busFactor(counts: readonly number[]): number {
  const n = counts.length;
  if (n === 0) return 1;
  // Drop zero-count contributors so "n" reflects actual touchers.
  const active = counts.filter((c) => c > 0);
  const m = active.length;
  if (m === 0) return 1;
  if (m === 1) return 1;
  const g = gini(active);
  const raw = 1 + Math.round((1 - g) * (m - 1));
  if (raw < 1) return 1;
  if (raw > m) return m;
  return raw;
}
