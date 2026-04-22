/**
 * Orphan detection (Stream H.5).
 *
 * Classifies each File into one of four lifecycle buckets, driven by
 * three inputs per file:
 *
 *   - `topContributorLastSeenDays` from temporal signal 11.
 *   - `coauthors365d`: count of distinct Co-authored-by: emails across the
 *     past 365 days of commits touching this file.
 *   - `decayedChurn` from temporal signal 6.
 *
 * Grades:
 *   - `active`     — none of the lifecycle conditions fire.
 *   - `orphaned`   — top contributor inactive for >180 days, no recent
 *                    coauthors, but the file still shows non-trivial churn.
 *   - `abandoned`  — top contributor inactive for >365 days with non-trivial
 *                    churn remaining.
 *   - `fossilized` — top contributor inactive for >730 days and no churn
 *                    above epsilon; old code that nobody touches.
 *
 * `epsilon` is 1% of the repo-median `decayedChurn` so the threshold scales
 * with repo activity — a high-churn monorepo demands a higher bar than a
 * handful of scripts.
 */

export type OrphanGrade = "active" | "orphaned" | "abandoned" | "fossilized";

export interface OrphanFileInput {
  /** Days since the file's top contributor last appeared anywhere in the repo. */
  readonly topContributorLastSeenDays: number | undefined;
  /** Distinct Co-authored-by: emails in the past 365 days. */
  readonly coauthors365d: number;
  /** Sum of exponential-decay churn weights for the file. */
  readonly decayedChurn: number;
}

export interface OrphanClassificationInput {
  /** Optional override of the epsilon threshold; default = 1% of repo median. */
  readonly epsilonOverride?: number;
  /** Whether enough history exists; when `false`, all files return `"active"`. */
  readonly hasEnoughHistory: boolean;
}

const ORPHANED_DAYS = 180;
const ABANDONED_DAYS = 365;
const FOSSILIZED_DAYS = 730;

/**
 * Compute the orphan epsilon threshold from a repo's decayed-churn vector.
 * Zero-length input yields 0 (everything passes the churn filter vacuously).
 */
export function computeOrphanEpsilon(
  decayedChurnValues: readonly number[],
  percentOfMedian = 0.01,
): number {
  if (decayedChurnValues.length === 0) return 0;
  const sorted = [...decayedChurnValues].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return median * percentOfMedian;
}

/**
 * Classify a single file. Rule precedence (first match wins):
 *  1. `fossilized` — oldest top contributor, churn at-or-below epsilon.
 *  2. `abandoned` — top contributor inactive >365d, churn above epsilon.
 *  3. `orphaned` — top contributor inactive >180d, zero coauthors in the
 *     past year, churn above epsilon.
 *  4. `active` — fallthrough.
 */
export function classifyOrphan(
  file: OrphanFileInput,
  ctx: { readonly epsilon: number; readonly hasEnoughHistory: boolean },
): OrphanGrade {
  if (!ctx.hasEnoughHistory) return "active";
  const lastSeen = file.topContributorLastSeenDays;
  if (lastSeen === undefined) return "active";
  const epsilon = ctx.epsilon;
  const hasMeaningfulChurn = file.decayedChurn > epsilon;
  if (lastSeen > FOSSILIZED_DAYS && !hasMeaningfulChurn) return "fossilized";
  if (lastSeen > ABANDONED_DAYS && hasMeaningfulChurn) return "abandoned";
  if (lastSeen > ORPHANED_DAYS && hasMeaningfulChurn && file.coauthors365d === 0) {
    return "orphaned";
  }
  return "active";
}

/**
 * Batch-classify every file in one pass. Returns a Map keyed by the original
 * file key (caller chooses semantics).
 */
export function classifyOrphans<K>(
  files: ReadonlyMap<K, OrphanFileInput>,
  ctxIn: OrphanClassificationInput,
): Map<K, OrphanGrade> {
  const out = new Map<K, OrphanGrade>();
  if (!ctxIn.hasEnoughHistory) {
    for (const key of files.keys()) out.set(key, "active");
    return out;
  }
  const decayedChurnValues: number[] = [];
  for (const f of files.values()) decayedChurnValues.push(f.decayedChurn);
  const epsilon = ctxIn.epsilonOverride ?? computeOrphanEpsilon(decayedChurnValues);
  for (const [key, f] of files) {
    out.set(key, classifyOrphan(f, { epsilon, hasEnoughHistory: true }));
  }
  return out;
}

/**
 * Impact multiplier per grade.
 *
 * Scale (active / orphaned / abandoned / fossilized) = (1.0 / 1.3 / 1.6 / 1.6).
 * Fossilized ties with abandoned at the top because dormant-old code often
 * carries the most hidden complexity (the top contributor is long gone and
 * no one has touched it, so nobody has warmed the file into working memory
 * recently). Orphaned sits in the middle: the code still churns, just
 * without the original author.
 */
export function orphanImpactMultiplier(grade: OrphanGrade | undefined): number {
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
      // Exhaustiveness — new grades added to the union without updating this
      // switch will fail TypeScript's checks at build time.
      const _exhaust: never = grade;
      void _exhaust;
      return 1.0;
    }
  }
}
