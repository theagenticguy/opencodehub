/**
 * The variance-probe report (spec 010 §5, R6).
 *
 * The report is a **pure function of the captured run outcomes** — no
 * wall-clock, no run-id, no absolute paths. Two probe runs over the same
 * captured outcomes serialize byte-identically (the context-bom discipline).
 * Serialization goes through `core-types`' `canonicalJson` (sorted keys), so
 * the emitted `--json` is reproducible.
 *
 * Token overhead is a first-class output, not a footnote: the paper's claim is
 * "halves variance at ~10% more tokens", so a probe that halves variance at
 * 3× tokens is a worse story. The report flags (never fails) when overhead
 * exceeds {@link TOKEN_OVERHEAD_FLAG} — "you bought stability expensively."
 */

import { canonicalJson } from "@opencodehub/core-types";
import type { ArmDispersion } from "./dispersion.js";
import { dispersionScalar } from "./dispersion.js";

/**
 * Token-overhead guardrail (spec 010 §7.4). Above this ratio the report flags
 * that stability was bought expensively. A reported constant, never a gate.
 */
export const TOKEN_OVERHEAD_FLAG = 1.3;

/** Aggregate token totals for one arm. */
export interface ArmTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Cached input tokens (Claude Code's per-call cached system prompt, Codex's
   * `cached_input_tokens`). Counted in the token-overhead total — omitting it
   * undercounts the cost the variance claim trades against.
   */
  readonly cacheTokens: number;
  /** Sum of per-run cost when every run reported it; `null` otherwise. */
  readonly costUsd: number | null;
}

/** One arm's measured result (with-pack or without-pack). */
export interface ArmReport {
  readonly dispersion: ArmDispersion;
  readonly tokens: ArmTokens;
}

/** The full per-harness probe result. */
export interface HarnessReport {
  /** Which agent produced this result (e.g. "claude", "codex"). */
  readonly harness: string;
  /** Runner name (e.g. "cli:claude"). */
  readonly runner: string;
  readonly runs: number;
  readonly without: ArmReport;
  readonly with: ArmReport;
  /**
   * `without − with` of the dispersion scalar. Positive = the pack reduced
   * variance (the Move-2 claim). The headline number.
   */
  readonly dispersionDelta: number;
  /** with-pack tokens / without-pack tokens (total in+out). */
  readonly tokenOverhead: number;
  /** True when `tokenOverhead` exceeds {@link TOKEN_OVERHEAD_FLAG}. */
  readonly tokenOverheadFlagged: boolean;
}

/** The top-level report the probe emits. */
export interface VarianceReport {
  /** Report schema version, so consumers can branch on shape changes. */
  readonly schema: 1;
  /** The task id this report measures. */
  readonly taskId: string;
  /**
   * Tokenizer-provenance lane the with-pack arm packed under
   * ("<vendor>:<name>@<pin>"). Optional so pre-existing captured reports stay
   * valid; when present it lets Finding 0001 v2 attribute a result to a
   * tokenizer (e.g. the Sonnet-5 lane whose heavier tokenizer inflates the
   * same bytes ~30-35% vs prior Claude tokenizers). Pure provenance — recording
   * it never changes the measured dispersion or token overhead.
   */
  readonly packTokenizerId?: string;
  /** One entry per harness the probe ran. */
  readonly harnesses: readonly HarnessReport[];
}

/** Sum input+output tokens for an arm. */
function totalTokens(t: ArmTokens): number {
  return t.inputTokens + t.outputTokens + t.cacheTokens;
}

/**
 * Assemble a {@link HarnessReport} from two scored arms + their token totals.
 * Pure: identical inputs → identical output.
 */
export function buildHarnessReport(input: {
  readonly harness: string;
  readonly runner: string;
  readonly runs: number;
  readonly without: ArmReport;
  readonly with: ArmReport;
}): HarnessReport {
  const dispersionDelta =
    dispersionScalar(input.without.dispersion) - dispersionScalar(input.with.dispersion);
  const withoutTotal = totalTokens(input.without.tokens);
  const withTotal = totalTokens(input.with.tokens);
  // Overhead is undefined when the baseline arm spent no tokens; report 0 in
  // that degenerate case rather than Infinity/NaN, and never flag it.
  const tokenOverhead = withoutTotal === 0 ? 0 : withTotal / withoutTotal;
  return {
    harness: input.harness,
    runner: input.runner,
    runs: input.runs,
    without: input.without,
    with: input.with,
    dispersionDelta,
    tokenOverhead,
    tokenOverheadFlagged: tokenOverhead > TOKEN_OVERHEAD_FLAG,
  };
}

/**
 * Canonical JSON for the report (R6). Sorted keys, no clock/run-id — byte-stable
 * across processes given the same captured outcomes.
 */
export function serializeReport(report: VarianceReport): string {
  return canonicalJson(report);
}

/**
 * Render a short human-readable summary of a report. Kept separate from the
 * machine JSON so the CLI can print one or the other.
 */
export function formatReport(report: VarianceReport): string {
  const lines: string[] = [];
  lines.push(`Variance probe — task: ${report.taskId}`);
  for (const h of report.harnesses) {
    lines.push("");
    lines.push(`  ${h.harness} (${h.runner}, N=${h.runs})`);
    lines.push(`    without-pack dispersion: ${fmtDispersion(h.without.dispersion)}`);
    lines.push(`    with-pack dispersion:    ${fmtDispersion(h.with.dispersion)}`);
    lines.push(`    delta (without − with):  ${h.dispersionDelta.toFixed(4)}`);
    lines.push(
      `    token overhead:          ${h.tokenOverhead.toFixed(3)}×` +
        (h.tokenOverheadFlagged
          ? `  [FLAG: > ${TOKEN_OVERHEAD_FLAG}× — stability bought expensively]`
          : ""),
    );
    // Surface the in/out/cache split so the overhead is auditable — cached
    // tokens (the per-call system prompt) are part of the total, not hidden.
    lines.push(`    tokens without:          ${fmtTokens(h.without.tokens)}`);
    lines.push(`    tokens with:             ${fmtTokens(h.with.tokens)}`);
  }
  return lines.join("\n");
}

/** Render an arm's token split: input + output + cache (the overhead inputs). */
function fmtTokens(t: ArmTokens): string {
  return `in ${t.inputTokens} + out ${t.outputTokens} + cache ${t.cacheTokens}`;
}

function fmtDispersion(d: ArmDispersion): string {
  switch (d.kind) {
    case "output_hash":
      return `distinct-output ratio ${d.distinctRatio.toFixed(4)}`;
    case "assertion":
      return `pass-rate ${d.passRate.toFixed(4)} (stddev ${d.stddev.toFixed(4)})`;
    case "judge":
      return `mean-score ${d.meanScore.toFixed(4)} (stddev ${d.stddev.toFixed(4)})`;
  }
}
