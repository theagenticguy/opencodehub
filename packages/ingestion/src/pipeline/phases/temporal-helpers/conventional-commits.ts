/**
 * Conventional-Commits subject-line classifier.
 *
 * Only the subject line is inspected — the canonical spec places the type
 * prefix there. The grammar accepted is the de-facto commitlint subset:
 *   `<type>(<scope>)?!?: <description>`
 * where `<type>` is one of the 11 types named in the spec (plus `revert`).
 */

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?:/i;

/**
 * Return the lowercase type token for a Conventional-Commit subject, or
 * `undefined` if the subject is non-conforming.
 */
export function classifyConventionalType(subject: string): string | undefined {
  const match = CONVENTIONAL_COMMIT_RE.exec(subject);
  if (match === null) return undefined;
  const type = match[1];
  if (type === undefined) return undefined;
  return type.toLowerCase();
}

/**
 * Return a sort-stable histogram copy keyed by type.
 *
 * Sorting guarantees downstream JSON serialisation is byte-stable regardless
 * of insertion order.
 */
export function sortedHistogram(hist: ReadonlyMap<string, number>): Record<string, number> {
  const keys = [...hist.keys()].sort();
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = hist.get(k) ?? 0;
  }
  return out;
}
