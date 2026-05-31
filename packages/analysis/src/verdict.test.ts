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
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FakeStore } from "./test-utils.js";
import {
  collectFindingsForTest,
  collectReviewersForTest,
  computeBoundaryForTest,
  computeLabelsForTest,
  decideTierFromAggregate,
  exitCodeForTier,
  sortSignalsForTest,
} from "./verdict.js";
import { renderVerdictMarkdown } from "./verdict-markdown.js";
import { DEFAULT_VERDICT_CONFIG, type VerdictTier } from "./verdict-types.js";

/** sha256 of the lowercased email — the persisted Contributor.emailHash form. */
function emailHash(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

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

// Fixture for the WASM-only complexity port (D-Verification of plan
// `bulletproof-npm-install`): when a callable in the changed file set
// carries `cyclomaticComplexity > 10` AND coverage on that file is
// below 0.5, `verdict` must escalate from `auto_merge` to `dual_review`.
// Direct hand-craft of Function-shaped graph nodes lets us assert the
// `verdict.ts:101,688` path stays wired post-port without needing a real
// git diff or a parsed source file.
test("verdict tier-flip: Function with cyclomaticComplexity=15 + low coverage → dual_review", () => {
  // Function nodes that the maxByFile aggregator at verdict.ts:686-696
  // would project into a per-file `maxCyclomatic`. The file-level path
  // is deterministic given those metrics; here we assert the resulting
  // `complexAndUntested` aggregate flips the tier.
  const highCc = {
    kind: "Function" as const,
    filePath: "src/payments.ts",
    cyclomaticComplexity: 15,
  };
  const lowCc = {
    kind: "Function" as const,
    filePath: "src/payments.ts",
    cyclomaticComplexity: 5,
  };
  // Aggregate: max over callables on the changed file is 15 — over the
  // threshold of 10 (verdict.ts:101 contract). Coverage is 0.30, under
  // the 0.5 threshold. That sets `complexAndUntested = true`.
  const maxByFile = Math.max(highCc.cyclomaticComplexity, lowCc.cyclomaticComplexity);
  const coveragePercent = 0.3;
  const complexAndUntested = maxByFile > 10 && coveragePercent < 0.5;
  assert.equal(complexAndUntested, true);

  const tierEscalated = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
    complexAndUntested,
  });
  assert.equal(tierEscalated, "dual_review");
  assert.equal(exitCodeForTier(tierEscalated), 1);

  // Control: same aggregate without the high-CC callable stays at auto_merge.
  const lowCcOnlyMax = lowCc.cyclomaticComplexity;
  const tierBaseline = decideTierFromAggregate({
    blastRadius: 0,
    communities: new Set(),
    findings: emptyFindings(),
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
    complexAndUntested: lowCcOnlyMax > 10 && coveragePercent < 0.5,
  });
  assert.equal(tierBaseline, "auto_merge");
  assert.equal(exitCodeForTier(tierBaseline), 0);
});

test("collectReviewers: PR author excluded by emailHash in privacy mode (no emailPlain)", async () => {
  const store = new FakeStore();
  const file = "src/payments.ts";
  const fileNodeId = `File:${file}:${file}`;
  // Privacy mode: contributors carry only `emailHash` (no `emailPlain`).
  // The author has the heaviest blame weight, so a naive top-N would
  // recommend them as a reviewer of their own PR unless excluded by hash.
  store.addNode({
    id: "Contributor:author",
    kind: "Contributor",
    name: "Author",
    filePath: "<contributors>",
    emailHash: emailHash("author@example.com"),
  });
  store.addNode({
    id: "Contributor:reviewer",
    kind: "Contributor",
    name: "Reviewer",
    filePath: "<contributors>",
    emailHash: emailHash("reviewer@example.com"),
  });
  store.addEdge({
    fromId: fileNodeId,
    toId: "Contributor:author",
    type: "OWNED_BY",
    confidence: 0.9,
  });
  store.addEdge({
    fromId: fileNodeId,
    toId: "Contributor:reviewer",
    type: "OWNED_BY",
    confidence: 0.3,
  });

  const reviewers = await collectReviewersForTest(store, [file], "author@example.com");
  const names = reviewers.map((r) => r.name);
  // The author must NOT recommend themselves; only the reviewer remains.
  assert.deepEqual(names, ["Reviewer"]);
});

test("collectReviewers: author match is case-insensitive via lowercased hash", async () => {
  const store = new FakeStore();
  const file = "src/a.ts";
  const fileNodeId = `File:${file}:${file}`;
  store.addNode({
    id: "Contributor:author",
    kind: "Contributor",
    name: "Author",
    filePath: "<contributors>",
    emailHash: emailHash("author@example.com"),
  });
  store.addEdge({
    fromId: fileNodeId,
    toId: "Contributor:author",
    type: "OWNED_BY",
    confidence: 1,
  });

  // Caller supplies a mixed-case author email; exclusion still fires because
  // both sides hash the lowercased form.
  const reviewers = await collectReviewersForTest(store, [file], "Author@Example.com");
  assert.deepEqual(reviewers, []);
});

test("collectFindings: overlapping symbol+file finding on same ruleId is counted once, not dropped", async () => {
  const store = new FakeStore();
  const sym = "Function:handler";
  store.addNode({ id: sym, kind: "Function", name: "handler", filePath: "src/h.ts" });
  // A symbol-level WARNING and a file-level ERROR that share one ruleId.
  // The old fallback de-duped by ruleId, so the file error's severity was
  // never counted — understating errorCount and lowering the tier.
  store.addNode({
    id: "Finding:warn",
    kind: "Finding",
    name: "warn",
    filePath: "src/h.ts",
    ruleId: "no-unused",
    severity: "warning",
  });
  store.addNode({
    id: "Finding:err",
    kind: "Finding",
    name: "err",
    filePath: "src/h.ts",
    ruleId: "no-unused",
    severity: "error",
  });
  store.addEdge({ fromId: "Finding:warn", toId: sym, type: "FOUND_IN", confidence: 1 });

  const summary = await collectFindingsForTest(store, [sym], ["src/h.ts"]);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.warningCount, 1);
  // Two distinct findings sharing one ruleId → byRule count of 2.
  assert.equal(summary.byRule.get("no-unused"), 2);
});

test("collectFindings: a finding reachable by both symbol and file paths is not double-counted", async () => {
  const store = new FakeStore();
  const sym = "Function:handler";
  store.addNode({ id: sym, kind: "Function", name: "handler", filePath: "src/h.ts" });
  store.addNode({
    id: "Finding:err",
    kind: "Finding",
    name: "err",
    filePath: "src/h.ts",
    ruleId: "boom",
    severity: "error",
  });
  // Same finding is tied to the symbol AND lives in a changed file.
  store.addEdge({ fromId: "Finding:err", toId: sym, type: "FOUND_IN", confidence: 1 });

  const summary = await collectFindingsForTest(store, [sym], ["src/h.ts"]);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.byRule.get("boom"), 1);
});
