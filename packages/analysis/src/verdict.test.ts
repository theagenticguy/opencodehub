/**
 * Verdict composition tests.
 *
 * Covers:
 *   - Pure tier decision across representative aggregate states (block,
 *     expert_review, dual_review, single_review, auto_merge).
 *   - Decision-boundary percentage within each tier's window.
 *   - Deterministic reasoning-chain ordering (severity desc, label asc).
 *   - Exit-code mapping.
 *   - Label synthesis (tier + area:<label>).
 *   - Markdown renderer skeleton shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeBoundaryForTest,
  computeLabelsForTest,
  decideTierFromAggregate,
  exitCodeForTier,
  sortSignalsForTest,
} from "./verdict.js";
import { renderVerdictMarkdown } from "./verdict-markdown.js";
import { DEFAULT_VERDICT_CONFIG, type VerdictTier } from "./verdict-types.js";

function emptyFindings(): {
  errorCount: number;
  warningCount: number;
  byRule: ReadonlyMap<string, number>;
} {
  return { errorCount: 0, warningCount: 0, byRule: new Map() };
}

test("decideTier: blast >= 50 → block", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 55,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "block");
  assert.equal(exitCodeForTier(tier), 2);
});

test("decideTier: blast >= 20 → expert_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 25,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "expert_review");
  assert.equal(exitCodeForTier(tier), 2);
});

test("decideTier: any finding error → expert_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: { errorCount: 1, warningCount: 0, byRule: new Map([["X", 1]]) },
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "expert_review");
});

test("decideTier: 3+ communities → dual_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(["c1", "c2", "c3"]),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "dual_review");
  assert.equal(exitCodeForTier(tier), 1);
});

test("decideTier: orphan grade → dual_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: "abandoned",
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "dual_review");
});

test("decideTier: 5 <= blast < 20 → dual_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 7,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "dual_review");
});

test("decideTier: warning finding → single_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: { errorCount: 0, warningCount: 1, byRule: new Map([["X", 1]]) },
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "single_review");
  assert.equal(exitCodeForTier(tier), 0);
});

test("decideTier: fix-follow-feat > threshold → single_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0.5,
  });
  assert.equal(tier, "single_review");
});

test("decideTier: nothing → auto_merge", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
  });
  assert.equal(tier, "auto_merge");
  assert.equal(exitCodeForTier(tier), 0);
});

test("decideTier (Q.2): complex + untested file → dual_review", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
    complexAndUntested: true,
  });
  assert.equal(tier, "dual_review");
  assert.equal(exitCodeForTier(tier), 1);
});

test("decideTier (Q.2): complex+untested absent → unaffected baseline", () => {
  const tier = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
    complexAndUntested: false,
  });
  assert.equal(tier, "auto_merge");
});

test("computeBoundary: dual_review at blast=7 → distancePercent reflects (20-7)/(20-5)", () => {
  const b = computeBoundaryForTest(7, "dual_review");
  // progress = 7 - 5 = 2; range = 20 - 5 = 15; remaining = 1 - 2/15 ≈ 0.8667
  // distancePercent ≈ 87
  assert.equal(b.nextTier, "expert_review");
  assert.ok(b.distancePercent >= 86 && b.distancePercent <= 88, `got ${b.distancePercent}`);
});

test("computeBoundary: block has null nextTier", () => {
  const b = computeBoundaryForTest(55, "block");
  assert.equal(b.nextTier, null);
  assert.equal(b.distancePercent, 0);
});

test("computeBoundary: auto_merge at blast=0 → distancePercent 100", () => {
  const b = computeBoundaryForTest(0, "auto_merge");
  assert.equal(b.nextTier, "single_review");
  assert.equal(b.distancePercent, 100);
});

test("sortSignals: severity desc, label asc, stable", () => {
  const sorted = sortSignalsForTest([
    { label: "zebra", value: 1, severity: "info" },
    { label: "apple", value: 2, severity: "error" },
    { label: "mango", value: 3, severity: "warn" },
    { label: "banana", value: 4, severity: "error" },
  ]);
  const labels = sorted.map((s) => s.label);
  assert.deepEqual(labels, ["apple", "banana", "mango", "zebra"]);
});

test("computeLabels: tier + area labels ordered lexicographically", () => {
  const labels = computeLabelsForTest("dual_review", ["auth", "billing"]);
  assert.deepEqual(labels, ["review:dual", "area:auth", "area:billing"]);
});

test("exit codes: exact 0/1/2 mapping per PRD", () => {
  const mapping: Record<VerdictTier, 0 | 1 | 2> = {
    auto_merge: 0,
    single_review: 0,
    dual_review: 1,
    expert_review: 2,
    block: 2,
  };
  for (const [tier, code] of Object.entries(mapping) as [VerdictTier, 0 | 1 | 2][]) {
    assert.equal(exitCodeForTier(tier), code, `mismatch on tier ${tier}`);
  }
});

test("renderVerdictMarkdown: header + tier + labels rendered", () => {
  const md = renderVerdictMarkdown({
    verdict: "block",
    confidence: 0.9,
    decisionBoundary: { distancePercent: 0, nextTier: null },
    reasoningChain: [
      { label: "blast_radius", value: 55, severity: "error" },
      { label: "tier", value: "block", severity: "error" },
    ],
    recommendedReviewers: [
      { email: "alice@example.com", emailHash: "abc", name: "Alice", weight: 1 },
    ],
    githubLabels: ["review:block"],
    reviewCommentMarkdown: "",
    exitCode: 2,
    blastRadius: 55,
    communitiesTouched: ["c1"],
    changedFileCount: 3,
    affectedSymbolCount: 5,
  });
  assert.match(md, /OpenCodeHub Verdict: `block`/);
  assert.match(md, /Blast radius:\*\* 55/);
  assert.match(md, /`review:block`/);
  assert.match(md, /Alice <alice@example.com>/);
  const lineCount = md.split("\n").length;
  assert.ok(lineCount <= 50, `markdown too long: ${lineCount} lines`);
});

test("DEFAULT_VERDICT_CONFIG: thresholds match the PRD", () => {
  assert.equal(DEFAULT_VERDICT_CONFIG.blockThreshold, 50);
  assert.equal(DEFAULT_VERDICT_CONFIG.escalationThreshold, 20);
  assert.equal(DEFAULT_VERDICT_CONFIG.warningThreshold, 5);
  assert.equal(DEFAULT_VERDICT_CONFIG.communityBoundaryThreshold, 3);
});
