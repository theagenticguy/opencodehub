/**
 * Reciprocal Rank Fusion.
 *
 * Given N ranked runs (each a list of candidates ordered best-first) this
 * fuses them into a single list by summing `1 / (k + rank)` across runs
 * for each candidate. Rank here is 1-based; a missing candidate contributes
 * nothing from that run.
 *
 * Default `k` follows Cormack et al. (2009): 60.
 *
 * Tie handling is deterministic: when two candidates tie on the fused
 * score, the one that appeared earlier in the first run wins; then the
 * second run; and so on. Candidates absent from all runs are dropped.
 */

/** Shape of a single input-run row. Only `id` is required by this fuser. */
export interface RankedItem {
  readonly id: string;
}

export interface FusedItem {
  readonly id: string;
  readonly score: number;
}

export const DEFAULT_RRF_K = 60;
export const DEFAULT_RRF_TOP_K = 50;

/**
 * Fuse a set of ranked runs into a single ranked list.
 *
 * @param runs Ordered runs, each best-first.
 * @param k Reciprocal-rank dampener. Higher `k` flattens the weights.
 * @param topK Cap on the returned list length.
 */
export function rrf(
  runs: readonly (readonly RankedItem[])[],
  k: number = DEFAULT_RRF_K,
  topK: number = DEFAULT_RRF_TOP_K,
): readonly FusedItem[] {
  if (k <= 0) throw new Error(`rrf: k must be positive, got ${k}`);
  if (topK <= 0) return [];

  // Accumulate per-id scores and remember the first-run / first-rank at
  // which each id appeared so tie-breaking is fully deterministic.
  const scoreById = new Map<string, number>();
  const firstRunById = new Map<string, number>();
  const firstRankById = new Map<string, number>();

  for (let r = 0; r < runs.length; r += 1) {
    const run = runs[r] ?? [];
    for (let idx = 0; idx < run.length; idx += 1) {
      const item = run[idx];
      if (item === undefined) continue;
      const id = item.id;
      const rank = idx + 1; // 1-based
      const contribution = 1 / (k + rank);
      scoreById.set(id, (scoreById.get(id) ?? 0) + contribution);
      if (!firstRunById.has(id)) {
        firstRunById.set(id, r);
        firstRankById.set(id, rank);
      }
    }
  }

  const all: FusedItem[] = [];
  for (const [id, score] of scoreById) {
    all.push({ id, score });
  }

  all.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ra = firstRunById.get(a.id) ?? Number.POSITIVE_INFINITY;
    const rb = firstRunById.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    const ia = firstRankById.get(a.id) ?? Number.POSITIVE_INFINITY;
    const ib = firstRankById.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ia !== ib) return ia - ib;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return all.slice(0, topK);
}
