/**
 * Pure render helpers for `codehub verdict`.
 *
 * The CLI supports three output formats:
 *   - `summary`   — chalk-free ANSI pretty-print for human eyes in a TTY.
 *                   Honors `NO_COLOR` and falls back to plain text when
 *                   stdout is not a TTY (piped or redirected).
 *   - `markdown`  — the PR-comment markdown string already synthesized by
 *                   the analysis module. Safe to pipe directly into
 *                   `gh pr comment`.
 *   - `json`      — pretty-printed JSON document of the entire response.
 *
 * Renderers are pure: they take a {@link VerdictResponse} and return a
 * string. Side-effect output (stdout, exit code) is the caller's concern.
 *
 * The CLI also defines its own exit-code ladder (0/1/2/3) for the
 * `--exit-code` flag. That ladder is stricter than
 * `VerdictResponse.exitCode` (which maxes out at 2 per the analysis
 * module's original PRD contract) so CI pipes get distinct signals for
 * `single_review` vs `dual_review` vs `block`.
 */

import type { VerdictResponse, VerdictTier } from "@opencodehub/analysis";

/** CLI exit-code ladder distinct from `VerdictResponse.exitCode`. */
const CLI_TIER_EXIT_CODES: Record<VerdictTier, 0 | 1 | 2 | 3> = {
  auto_merge: 0,
  single_review: 1,
  dual_review: 1,
  expert_review: 2,
  block: 3,
};

export function cliExitCodeForTier(tier: VerdictTier): 0 | 1 | 2 | 3 {
  return CLI_TIER_EXIT_CODES[tier];
}

export function renderJson(verdict: VerdictResponse): string {
  return JSON.stringify(verdict, null, 2);
}

export function renderMarkdown(verdict: VerdictResponse): string {
  if (verdict.reviewCommentMarkdown.length > 0) {
    return verdict.reviewCommentMarkdown;
  }
  // Defensive fallback — should not normally trigger because
  // computeVerdict always populates reviewCommentMarkdown.
  return [
    `## OpenCodeHub Verdict: \`${verdict.verdict}\``,
    "",
    `**Confidence:** ${(verdict.confidence * 100).toFixed(0)}% | **Exit code:** ${verdict.exitCode}`,
    `**Blast radius:** ${verdict.blastRadius} across ${verdict.communitiesTouched.length} communities`,
  ].join("\n");
}

interface SummaryEnv {
  readonly isTty: boolean;
  readonly noColor: boolean;
}

/** ANSI SGR codes. */
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const TIER_COLORS: Record<VerdictTier, string> = {
  auto_merge: GREEN,
  single_review: CYAN,
  dual_review: YELLOW,
  expert_review: RED,
  block: RED,
};

function paintFactory(env: SummaryEnv): (color: string, text: string) => string {
  if (env.noColor || !env.isTty) {
    return (_color, text) => text;
  }
  return (color, text) => `${color}${text}${RESET}`;
}

export interface RenderSummaryOptions {
  /** Defaults to `process.stdout.isTTY`. */
  readonly isTty?: boolean;
  /** Defaults to whether `NO_COLOR` is set and non-empty. */
  readonly noColor?: boolean;
}

export function renderSummary(verdict: VerdictResponse, opts: RenderSummaryOptions = {}): string {
  const env: SummaryEnv = {
    isTty: opts.isTty ?? process.stdout.isTTY === true,
    noColor:
      opts.noColor ??
      (typeof process.env["NO_COLOR"] === "string" && process.env["NO_COLOR"].length > 0),
  };
  const paint = paintFactory(env);
  const tierColor = TIER_COLORS[verdict.verdict];

  const out: string[] = [];
  const confidencePct = (verdict.confidence * 100).toFixed(0);
  out.push(
    `${paint(BOLD, "Verdict:")} ${paint(tierColor + BOLD, verdict.verdict)} ` +
      `${paint(DIM, `(confidence ${confidencePct}%)`)}`,
  );
  out.push(
    `${paint(BOLD, "Blast radius:")} ${verdict.blastRadius} symbols across ` +
      `${verdict.communitiesTouched.length} communities`,
  );
  out.push(
    `${paint(BOLD, "Files changed:")} ${verdict.changedFileCount} | ` +
      `${paint(BOLD, "Symbols affected:")} ${verdict.affectedSymbolCount}`,
  );
  const boundary = verdict.decisionBoundary;
  if (boundary.nextTier !== null) {
    out.push(
      `${paint(BOLD, "Boundary:")} ${boundary.distancePercent}% away from ` +
        `${paint(TIER_COLORS[boundary.nextTier], boundary.nextTier)}`,
    );
  } else {
    out.push(`${paint(BOLD, "Boundary:")} terminal tier (no escalation above)`);
  }
  out.push("");

  out.push(paint(BOLD, "Reasoning:"));
  if (verdict.reasoningChain.length === 0) {
    out.push("  (no signals)");
  } else {
    for (const sig of verdict.reasoningChain) {
      const sevPaint = sig.severity === "error" ? RED : sig.severity === "warn" ? YELLOW : DIM;
      const marker = sig.severity === "error" ? "[!!]" : sig.severity === "warn" ? "(!)" : "(i)";
      out.push(`  ${paint(sevPaint, marker)} ${sig.label}: ${String(sig.value)}`);
    }
  }
  out.push("");

  out.push(paint(BOLD, "Suggested reviewers:"));
  if (verdict.recommendedReviewers.length === 0) {
    out.push("  (none)");
  } else {
    for (const rev of verdict.recommendedReviewers) {
      const label = rev.name.length > 0 ? `${rev.name} <${rev.email}>` : rev.email;
      out.push(`  - ${label} ${paint(DIM, `(${rev.weight.toFixed(2)})`)}`);
    }
  }

  if (verdict.githubLabels.length > 0) {
    out.push("");
    out.push(`${paint(BOLD, "Labels:")} ${verdict.githubLabels.join(", ")}`);
  }

  return out.join("\n");
}
