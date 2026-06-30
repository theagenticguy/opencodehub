/**
 * Oracle scoring — reduce an arm's N {@link RunOutcome}s to an
 * {@link ArmDispersion} (spec 010 §2).
 *
 *   - `output_hash` — pure: hash the configured field, count distinct values.
 *   - `assertion`   — run a deterministic shell check against each run's
 *     checkout; pass/fail → Bernoulli dispersion. A run that errored, or whose
 *     command exceeds its timeout, scores as a fail (the worst outcome).
 *   - `judge`       — LLM-panel rubric scoring. The panel call is injected as a
 *     dependency so the probe core stays free of any model client; v1 ships the
 *     interface and a guard that fails fast if no judge function is supplied.
 *
 * The `assertion` path is the only one that touches the filesystem / spawns a
 * process; it is kept here (not in the pure dispersion module) so
 * `dispersion.ts` remains a pure, exhaustively-testable leaf.
 */

import { spawn } from "node:child_process";
import { sha256Hex } from "@opencodehub/core-types";
import {
  type ArmDispersion,
  bernoulliDispersion,
  distinctOutputRatio,
  populationStddev,
} from "./dispersion.js";
import type { RunOutcome } from "./runner.js";
import type { AssertionOracle, JudgeOracle, Oracle, OutputHashOracle } from "./task.js";

/** A judge-panel scorer: maps one run's outcome to a 0..1 rubric score. */
export type JudgeScorer = (outcome: RunOutcome, rubric: string) => Promise<number>;

export interface ScoreOptions {
  /** Required only when the task's oracle is `judge`. */
  readonly judge?: JudgeScorer;
}

/** Score an arm's outcomes into a dispersion, dispatching on the oracle type. */
export async function scoreArm(
  oracle: Oracle,
  outcomes: readonly RunOutcome[],
  options: ScoreOptions = {},
): Promise<ArmDispersion> {
  switch (oracle.type) {
    case "output_hash":
      return scoreOutputHash(oracle, outcomes);
    case "assertion":
      return scoreAssertion(oracle, outcomes);
    case "judge":
      return scoreJudge(oracle, outcomes, options.judge);
  }
}

function scoreOutputHash(oracle: OutputHashOracle, outcomes: readonly RunOutcome[]): ArmDispersion {
  const hashes = outcomes.map((o) => {
    const text = oracle.field === "diff" ? o.diff : o.finalText;
    // An errored run hashes to a sentinel so a crash counts as its own distinct
    // outcome rather than colliding with an empty-answer success.
    return o.errored ? `__errored__:${sha256Hex(text)}` : sha256Hex(text);
  });
  return { kind: "output_hash", distinctRatio: distinctOutputRatio(hashes), runs: outcomes.length };
}

async function scoreAssertion(
  oracle: AssertionOracle,
  outcomes: readonly RunOutcome[],
): Promise<ArmDispersion> {
  const passes: boolean[] = [];
  for (const outcome of outcomes) {
    if (outcome.errored || outcome.checkoutPath === undefined) {
      // No checkout to assert against, or the agent crashed → worst outcome.
      passes.push(false);
      continue;
    }
    passes.push(await runAssertionCommand(oracle, outcome.checkoutPath));
  }
  const { passRate, stddev } = bernoulliDispersion(passes);
  return { kind: "assertion", passRate, stddev, runs: outcomes.length };
}

async function scoreJudge(
  oracle: JudgeOracle,
  outcomes: readonly RunOutcome[],
  judge: JudgeScorer | undefined,
): Promise<ArmDispersion> {
  if (judge === undefined) {
    throw new Error(
      "eval: the `judge` oracle requires a JudgeScorer to be supplied to scoreArm; " +
        "none was provided. Pass `options.judge` or use the `assertion`/`output_hash` oracle.",
    );
  }
  const scores: number[] = [];
  for (const outcome of outcomes) {
    if (outcome.errored) {
      scores.push(0); // a crash is the worst rubric score
      continue;
    }
    // Average the panel: call the judge `panel` times and mean the results, so
    // judge-side noise doesn't inflate the agent-side variance we're measuring.
    const panelScores: number[] = [];
    for (let i = 0; i < oracle.panel; i += 1) {
      panelScores.push(clamp01(await judge(outcome, oracle.rubric)));
    }
    scores.push(panelScores.reduce((a, b) => a + b, 0) / panelScores.length);
  }
  const meanScore = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
  return { kind: "judge", meanScore, stddev: populationStddev(scores), runs: outcomes.length };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Run the assertion command in the run's checkout. Resolves `true` on exit
 * code 0, `false` otherwise (including spawn failure and timeout). Never
 * rejects — a broken check is a failed assertion, not a probe crash.
 */
function runAssertionCommand(oracle: AssertionOracle, checkoutPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cwd = oracle.cwd !== undefined ? `${checkoutPath}/${oracle.cwd}` : checkoutPath;
    const child = spawn(oracle.command, {
      cwd,
      shell: true,
      stdio: "ignore",
      timeout: oracle.timeoutMs,
    });
    let settled = false;
    const settle = (passed: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(passed);
    };
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
}
