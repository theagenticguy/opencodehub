/**
 * The variance-probe experiment loop (spec 010 §3).
 *
 * For each harness, for each arm (without-pack, with-pack), run the agent N
 * times via the injected {@link AgentRunner}, capturing each outcome. Score the
 * arm's outcomes with the task's oracle, sum tokens, and assemble a
 * {@link HarnessReport}. The loop is harness- and inference-backend-agnostic:
 * everything agent-specific lives behind the runner; everything model-specific
 * (Bedrock wiring) lives in the runner impl.
 *
 * Controls that keep the number honest (§3): same instruction / commit / agent
 * / model across both arms — the runner enforces this by taking identical
 * inputs and flipping only `withPack`. Fresh session per run is the runner's
 * responsibility (the CLI runner spawns a new process each call).
 */

import { type ScoreOptions, scoreArm } from "./oracle.js";
import {
  type ArmReport,
  buildHarnessReport,
  type HarnessReport,
  type VarianceReport,
} from "./report.js";
import type { AgentRunner, Harness, RunOutcome } from "./runner.js";
import type { Task } from "./task.js";

/** Default runs per arm (spec 010 §7.2). */
export const DEFAULT_RUNS = 10;

export interface ProbeOptions {
  /** Runs per arm. Defaults to {@link DEFAULT_RUNS}. */
  readonly runs?: number;
  /**
   * Which harnesses to run. Defaults to the task's `harness` (one) or the
   * full set ["claude", "codex"] when the task pins none (§7.3).
   */
  readonly harnesses?: readonly Harness[];
  /**
   * The OCH pack context to inject in the with-pack arm. The CLI generates
   * this once per task and passes it in, so the probe never imports
   * `@opencodehub/pack` (keeps the package graph acyclic).
   */
  readonly packContext: string;
  /**
   * Tokenizer-provenance lane the with-pack `packContext` was authored under
   * ("<vendor>:<name>@<pin>"). Recorded verbatim on the {@link VarianceReport}
   * so Finding 0001 v2 attributes results to a tokenizer. Pure provenance — the
   * probe never encodes with it, so it cannot change the measured numbers.
   */
  readonly packTokenizerId?: string;
  /** Required only when the task's oracle is `judge`. */
  readonly score?: ScoreOptions;
  /**
   * Per-run progress callback. Pure-side-channel — never affects the report.
   */
  readonly onRun?: (event: ProbeRunEvent) => void;
}

export interface ProbeRunEvent {
  readonly harness: Harness;
  readonly arm: "without" | "with";
  /** 1-based run index within the arm. */
  readonly index: number;
  readonly runs: number;
}

/** Resolve which harnesses to run from the task + options. */
export function resolveHarnesses(task: Task, options: ProbeOptions): readonly Harness[] {
  if (options.harnesses !== undefined && options.harnesses.length > 0) {
    return options.harnesses;
  }
  if (task.harness !== undefined) return [task.harness];
  return ["claude", "codex"];
}

/** Sum an arm's per-run token accounting into {@link ArmReport} totals. */
function sumTokens(outcomes: readonly RunOutcome[]): ArmReport["tokens"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let costUsd = 0;
  let everyRunHadCost = true;
  for (const o of outcomes) {
    inputTokens += o.tokens.inputTokens;
    outputTokens += o.tokens.outputTokens;
    cacheTokens += o.tokens.cacheTokens;
    if (o.tokens.costUsd === null) everyRunHadCost = false;
    else costUsd += o.tokens.costUsd;
  }
  return { inputTokens, outputTokens, cacheTokens, costUsd: everyRunHadCost ? costUsd : null };
}

/** Run one arm: N invocations of the agent, then score + total tokens. */
async function runArm(
  runner: AgentRunner,
  task: Task,
  harness: Harness,
  withPack: boolean,
  options: ProbeOptions,
  runs: number,
): Promise<ArmReport> {
  const packContext = options.packContext;
  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < runs; i += 1) {
    options.onRun?.({ harness, arm: withPack ? "with" : "without", index: i + 1, runs });
    const outcome = await runner.run({
      task,
      harness,
      withPack,
      ...(withPack ? { packContext } : {}),
    });
    outcomes.push(outcome);
  }
  const dispersion = await scoreArm(task.oracle, outcomes, options.score ?? {});
  return { dispersion, tokens: sumTokens(outcomes) };
}

/**
 * Run the full probe for one harness: both arms + report assembly.
 */
export async function probeHarness(
  runner: AgentRunner,
  task: Task,
  harness: Harness,
  options: ProbeOptions,
): Promise<HarnessReport> {
  const runs = options.runs ?? DEFAULT_RUNS;
  // without-pack first, then with-pack — order is immaterial to the report
  // (it's a pure function of the captured outcomes), but running the cheaper
  // baseline arm first surfaces a misconfigured runner before the with-pack
  // arm spends pack-inflated tokens.
  const without = await runArm(runner, task, harness, false, options, runs);
  const withPack = await runArm(runner, task, harness, true, options, runs);
  return buildHarnessReport({
    harness,
    runner: runner.name,
    runs,
    without,
    with: withPack,
  });
}

/**
 * Run the variance probe across every resolved harness and assemble the
 * top-level {@link VarianceReport}.
 *
 * `runnerFor` maps a harness to its runner — the CLI layer supplies a factory
 * that returns the Bedrock-wired direct-CLI runner for each agent. Injecting it
 * keeps the probe core free of any process-spawning code.
 */
export async function runProbe(
  task: Task,
  runnerFor: (harness: Harness) => AgentRunner,
  options: ProbeOptions,
): Promise<VarianceReport> {
  const harnesses = resolveHarnesses(task, options);
  const reports: HarnessReport[] = [];
  for (const harness of harnesses) {
    reports.push(await probeHarness(runnerFor(harness), task, harness, options));
  }
  return {
    schema: 1,
    taskId: task.id,
    ...(options.packTokenizerId !== undefined ? { packTokenizerId: options.packTokenizerId } : {}),
    harnesses: reports,
  };
}
