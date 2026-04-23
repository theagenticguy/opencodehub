/**
 * Revert detection — three orthogonal regex vectors.
 *
 * A commit is a revert if ANY of the three tests match:
 *   1. Subject begins with `Revert "…"` (default `git revert`).
 *   2. Body contains a `This reverts commit <sha>` line (default body form).
 *   3. Body contains the `--reference` form `This reverts <sha>[ (subject, date)]`.
 *
 * OR-logic plus a `.test` short-circuit guarantees each commit is counted at
 * most once, even if the subject and body both announce the revert.
 */

const REVERT_SUBJECT_RE = /^Revert "/;
const REVERT_BODY_DEFAULT_RE = /This reverts commit ([0-9a-f]+)/m;
const REVERT_BODY_REFERENCE_RE = /This reverts ([0-9a-f]+)(?:\s*\(([^)]+)\))?/m;

/** Return true iff a commit's subject or body identifies it as a revert. */
export function isRevertCommit(subject: string, body: string): boolean {
  if (REVERT_SUBJECT_RE.test(subject)) return true;
  if (REVERT_BODY_DEFAULT_RE.test(body)) return true;
  if (REVERT_BODY_REFERENCE_RE.test(body)) return true;
  return false;
}
