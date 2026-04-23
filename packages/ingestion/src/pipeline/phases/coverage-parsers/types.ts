/**
 * Shared coverage-parser contract.
 *
 * Every format-specific parser ingests a raw payload (plus the repo root,
 * which the parser may need to resolve absolute → relative paths) and
 * returns a map keyed by repo-relative POSIX file path. `FileCoverage`
 * carries the minimal information needed to populate
 * `FileNode.coveragePercent` + `FileNode.coveredLines` downstream.
 *
 * Invariants the phase relies on:
 *   - `coveredLines` is sorted ascending with duplicates removed.
 *   - `totalLines` is the count of instrumented lines (hit or miss), NOT
 *     the file's raw line count — a partial-coverage report must still
 *     compute a sensible ratio.
 *   - `coveragePercent` is in `[0, 1]`. Parsers are free to return their
 *     own ratio; the phase validates + clamps before writing to the graph.
 */

export interface FileCoverage {
  readonly filePath: string;
  readonly coveredLines: readonly number[];
  readonly totalLines: number;
  readonly coveragePercent: number;
}

/** Sort ascending + dedupe. Used by every parser before construction. */
export function canonLines(raw: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  for (const n of raw) {
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export function ratio(covered: number, total: number): number {
  if (total <= 0) return 0;
  const r = covered / total;
  if (!Number.isFinite(r)) return 0;
  if (r < 0) return 0;
  if (r > 1) return 1;
  return r;
}
