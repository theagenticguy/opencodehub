/**
 * `AgentRunner` — the harness-agnostic seam the probe drives (spec 010 §4).
 *
 * The probe core knows nothing about *how* an agent runs; it only asks a
 * runner to execute a task in one arm and hand back the captured outcome. v1
 * ships a direct-CLI runner (`cli-runner.ts`) that shells out to `claude -p` /
 * `codex exec` with Bedrock wired (§4a). A future omnigent-backed runner (v2)
 * implements the same interface and drops in without touching the probe.
 *
 * Determinism note: a runner is free to be nondeterministic *within* an arm
 * (that's the variance being measured) but must hold every controlled input —
 * commit, instruction, agent, model — identical *between* arms. The only
 * manipulated variable is `withPack`.
 */

import type { Task } from "./task.js";

/** Which coding agent a runner drives. */
export type Harness = "claude" | "codex";

/** Inputs handed to a runner for a single agent invocation. */
export interface RunRequest {
  /** The task being run (repo/commit/instruction). */
  readonly task: Task;
  /** Which agent to drive. */
  readonly harness: Harness;
  /**
   * When true, the OCH code-pack for `repo@commit` is injected into the
   * agent's context (the with-pack arm); when false, only the bare
   * instruction is given (the without-pack arm).
   */
  readonly withPack: boolean;
  /**
   * The pack context to inject when `withPack` is true. The CLI layer
   * generates the pack once per task and threads it in here, so the probe
   * core (and `@opencodehub/eval`) never depends on `@opencodehub/pack` —
   * keeping the package boundary acyclic. Absent on the without-pack arm.
   */
  readonly packContext?: string;
}

/** Token accounting captured from one agent run. */
export interface RunTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Cached input tokens the harness billed/served separately from
   * `inputTokens` — Claude Code's `cache_creation_input_tokens` +
   * `cache_read_input_tokens`, or Codex's `cached_input_tokens`. Claude Code
   * injects a large cached system prompt per call (~27K tokens observed), so
   * omitting this materially undercounts the token-overhead headline (the
   * "~10% more tokens" cost the variance claim rides on). 0 when the harness
   * reports no cache usage.
   */
  readonly cacheTokens: number;
  /** Total cost in USD when the harness reports it; `null` when unavailable. */
  readonly costUsd: number | null;
}

/** What a runner captures from a single agent invocation. */
export interface RunOutcome {
  /** The agent's final answer text. */
  readonly finalText: string;
  /**
   * The unified diff the agent produced, when the harness exposes one.
   * Empty string when the run produced no patch or the harness doesn't
   * surface diffs.
   */
  readonly diff: string;
  /** Token + cost accounting for the run. */
  readonly tokens: RunTokens;
  /**
   * Path to the (possibly mutated) repo checkout this run produced, so an
   * `assertion` oracle can execute its check against the run's result. Absent
   * when the runner does not materialize a per-run checkout.
   */
  readonly checkoutPath?: string;
  /**
   * True when the agent invocation itself failed (non-zero exit, crash,
   * timeout) as opposed to completing with a (possibly wrong) answer. A failed
   * run still counts toward the arm — a pack that makes the agent crash less is
   * lower variance — but the oracle treats it as the worst outcome.
   */
  readonly errored: boolean;
}

/**
 * Runs an agent for a single task invocation. Implementations: the direct-CLI
 * runner (v1) and, later, an omnigent-backed runner (v2).
 */
export interface AgentRunner {
  /** Stable name for the report (e.g. "cli:claude", "cli:codex"). */
  readonly name: string;
  /** Execute one invocation and capture its outcome. */
  run(request: RunRequest): Promise<RunOutcome>;
}
