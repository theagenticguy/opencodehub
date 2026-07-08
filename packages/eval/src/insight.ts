/**
 * INSIGHT — structural single-trajectory anti-pattern detectors
 * (Move 1 / arXiv:2607.06184 "TraceProbe", the INSIGHT module).
 *
 * Each detector is a deterministic, no-oracle predicate over a normalized
 * {@link Action} list. TraceProbe defines eight structural detectors; v1 ships
 * the four whose frozen predicates read only structural fields OCH already
 * captures — action type, file target, normalized query, command first word —
 * so no LLM labeler is required. This is the same discipline that made Finding
 * 0001's headline the directly-measured token number rather than the
 * judge-dependent one: publish what a rule can prove.
 *
 * The four (predicates quoted from the paper's frozen-detector table):
 *   - Search Loop   — "≥10 consecutive SEARCH or FILE READ actions with no
 *                      FILE WRITE and no validation COMMAND between them."
 *   - Re-read Churn — "same canonical file path is read ≥3 times within a
 *                      10-action window, with no intervening write to that file."
 *   - Redundant Search — "same exact-normalized SEARCH query recurs ≥2 times
 *                      within a 10-action window."
 *   - Shell-over-Tool — "a shell command's first word is cat/head/tail/less/
 *                      more, grep-family, rg/ag, or find while structured
 *                      read/search tools are exposed."
 *
 * Deliberately deferred to v2 (need a semantic labeler / effect labels — the
 * judge-oracle caveat): Tool Oscillation, No Formal Tail Validation, Unsupported
 * Completion Claim, Structured Plan Absence, and all four semantic detectors
 * (Phase Oscillation, …). Counting them would import LLM-labeler noise into a
 * number we want to be a pure function of the trajectory.
 *
 * Each detector returns a **count of firings** (windows/occurrences), not a
 * boolean, so the with/without-pack delta is graded, not just present/absent.
 * The functions are pure — identical action list → identical counts — so an
 * `InsightReport` inherits the probe's byte-stable-report contract.
 */

import { type Action, isShellReadSearch, isValidationCommand } from "./trajectory.js";

/** Per-detector firing counts for one trajectory. */
export interface InsightCounts {
  /** Number of maximal ≥10-long search/read runs with no write/validation. */
  readonly searchLoop: number;
  /** Number of (file, window) re-read-churn firings. */
  readonly rereadChurn: number;
  /** Number of redundant-search firings (a repeat within a 10-action window). */
  readonly redundantSearch: number;
  /** Number of shell commands doing read/search work a structured tool covers. */
  readonly shellOverTool: number;
}

/** Detector window width (TraceProbe's "10-action window"). */
const WINDOW = 10;
/** Search Loop minimum run length. */
const SEARCH_LOOP_MIN = 10;
/** Re-read Churn minimum reads of the same file within a window. */
const REREAD_MIN = 3;
// Redundant Search's threshold ("recurs ≥2 times") is one prior identical query
// within the window — expressed directly by the first-match `break` in
// countRedundantSearch rather than a named minimum.

/**
 * Score all four structural detectors over one trajectory. Pure.
 */
export function scoreInsight(actions: readonly Action[]): InsightCounts {
  return {
    searchLoop: countSearchLoops(actions),
    rereadChurn: countRereadChurn(actions),
    redundantSearch: countRedundantSearch(actions),
    shellOverTool: countShellOverTool(actions),
  };
}

/**
 * Search Loop: count maximal segments holding ≥{@link SEARCH_LOOP_MIN} SEARCH
 * or FILE_READ actions with no FILE_WRITE and no validation COMMAND between
 * them. Only those two — a write, or a validation command — break a segment;
 * every other action type (`reason`, `plan`, `spawn`, `fetch`, `navigate`, and
 * a non-validation `command`) is transparent, because the paper's predicate
 * names FILE WRITE and validation COMMAND as the sole exclusions. This matters:
 * agents emit `reason` blocks between nearly every tool call, so a detector
 * that reset on `reason` would essentially never fire. A transparent action
 * neither counts toward the 10 nor resets the tally. One maximal qualifying
 * segment counts once — a 25-read hunt is one loop, not sixteen.
 */
function countSearchLoops(actions: readonly Action[]): number {
  let count = 0;
  let run = 0;
  for (const a of actions) {
    if (a.type === "search" || a.type === "file_read") {
      run += 1;
    } else if (breaksSearchLoop(a)) {
      if (run >= SEARCH_LOOP_MIN) count += 1;
      run = 0;
    }
    // else: transparent action — leave `run` untouched.
  }
  if (run >= SEARCH_LOOP_MIN) count += 1;
  return count;
}

/**
 * Re-read Churn: for each sliding window of {@link WINDOW} actions, count a
 * firing for every distinct file path read ≥{@link REREAD_MIN} times within
 * that window with no intervening write *to that same path* inside the window.
 * A file counted in one window can fire again in a later window (the churn
 * persists), matching the paper's window-local definition; the same file is not
 * double-counted within a single window.
 */
function countRereadChurn(actions: readonly Action[]): number {
  let count = 0;
  for (let start = 0; start + WINDOW <= actions.length; start += 1) {
    const window = actions.slice(start, start + WINDOW);
    count += churnFiringsInWindow(window);
  }
  // Windows shorter than WINDOW at the tail cannot reach a full-window count,
  // but a churn can still complete inside them; scan the final partial window
  // only when the trajectory is shorter than one full window (otherwise every
  // qualifying churn already appeared in a full window above).
  if (actions.length < WINDOW) {
    count += churnFiringsInWindow(actions);
  }
  return count;
}

/** Count distinct files read ≥REREAD_MIN times with no intervening write, in one window. */
function churnFiringsInWindow(window: readonly Action[]): number {
  const readsSinceLastWrite = new Map<string, number>();
  const fired = new Set<string>();
  let firings = 0;
  for (const a of window) {
    if (a.target === undefined) continue;
    if (a.type === "file_write") {
      readsSinceLastWrite.set(a.target, 0); // a write resets the read tally
    } else if (a.type === "file_read") {
      const n = (readsSinceLastWrite.get(a.target) ?? 0) + 1;
      readsSinceLastWrite.set(a.target, n);
      if (n >= REREAD_MIN && !fired.has(a.target)) {
        fired.add(a.target);
        firings += 1;
      }
    }
  }
  return firings;
}

/**
 * Redundant Search: count firings where the same normalized SEARCH query recurs
 * ≥2 times within a {@link WINDOW}-action window. Counted
 * per repeat occurrence: the second (and each later) appearance of a query
 * already seen within the trailing window fires once. This makes three
 * back-to-back identical searches score 2, matching "recurs ≥2 times" read as
 * repeats beyond the first.
 */
function countRedundantSearch(actions: readonly Action[]): number {
  let count = 0;
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    if (a?.type !== "search" || a.query === undefined) continue;
    // Look back within the window for an identical normalized query.
    const lo = Math.max(0, i - (WINDOW - 1));
    for (let j = i - 1; j >= lo; j -= 1) {
      const prev = actions[j];
      if (prev?.type === "search" && prev.query === a.query) {
        count += 1;
        break; // one firing per redundant occurrence
      }
    }
  }
  return count;
}

/**
 * Shell-over-Tool: count COMMAND actions whose unwrapped program is a shell
 * read/search utility (cat/head/tail/less/more, grep-family, rg/ag, find) that
 * a structured Read/Grep/Glob tool covers. Each such command counts once.
 */
function countShellOverTool(actions: readonly Action[]): number {
  let count = 0;
  for (const a of actions) {
    if (a.type === "command" && a.command !== undefined && isShellReadSearch(a.command)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Whether a command action breaks a search loop (a validation command). Exposed
 * for the detector's unit tests and any future detector that shares the notion.
 */
export function breaksSearchLoop(action: Action): boolean {
  if (action.type === "file_write") return true;
  if (action.type === "command" && action.command !== undefined) {
    return isValidationCommand(action.command);
  }
  return false;
}

/** Zero counts — the additive identity for aggregation. */
export const ZERO_INSIGHT: InsightCounts = {
  searchLoop: 0,
  rereadChurn: 0,
  redundantSearch: 0,
  shellOverTool: 0,
};

/** Element-wise sum of two count records. */
function addCounts(a: InsightCounts, b: InsightCounts): InsightCounts {
  return {
    searchLoop: a.searchLoop + b.searchLoop,
    rereadChurn: a.rereadChurn + b.rereadChurn,
    redundantSearch: a.redundantSearch + b.redundantSearch,
    shellOverTool: a.shellOverTool + b.shellOverTool,
  };
}

/**
 * Aggregate an arm's per-run trajectories into summed + per-scored-run counts.
 * Only runs that carried a trajectory are scored; a run whose `trajectory` is
 * `undefined` (an errored run that emitted no stream, or a legacy runner) is
 * excluded from `scored` rather than counted as a clean zero — a crash that
 * produced no actions is absence of evidence, not evidence of a clean run.
 *
 * Returns `undefined` when no run carried a trajectory, so the report omits the
 * insight block entirely rather than dividing by zero.
 */
export function aggregateInsight(
  trajectories: readonly (readonly Action[] | undefined)[],
): { total: InsightCounts; perRun: InsightCounts; scored: number } | undefined {
  let total = ZERO_INSIGHT;
  let scored = 0;
  for (const traj of trajectories) {
    if (traj === undefined) continue;
    total = addCounts(total, scoreInsight(traj));
    scored += 1;
  }
  if (scored === 0) return undefined;
  return {
    total,
    perRun: {
      searchLoop: total.searchLoop / scored,
      rereadChurn: total.rereadChurn / scored,
      redundantSearch: total.redundantSearch / scored,
      shellOverTool: total.shellOverTool / scored,
    },
    scored,
  };
}
