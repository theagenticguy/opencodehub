/**
 * Tests for diffSarif / applyBaselineState — fingerprint-driven snapshot
 * diffing with rename-chain continuity.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBaselineState, diffSarif } from "./baseline.js";
import type { SarifLog, SarifResult } from "./schemas.js";

interface ResultInit {
  readonly ruleId: string;
  readonly uri: string;
  readonly startLine: number;
  readonly messageText?: string;
  readonly level?: "none" | "note" | "warning" | "error";
  readonly fingerprint?: string;
  readonly primaryLocationLineHash?: string;
}

function makeResult(init: ResultInit): SarifResult {
  const pf: Record<string, string> = {};
  if (init.fingerprint !== undefined) pf["opencodehub/v1"] = init.fingerprint;
  if (init.primaryLocationLineHash !== undefined) {
    pf["primaryLocationLineHash"] = init.primaryLocationLineHash;
  }
  const out: SarifResult = {
    ruleId: init.ruleId,
    message: { text: init.messageText ?? "finding" },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: init.uri },
          region: { startLine: init.startLine },
        },
      },
    ],
    ...(Object.keys(pf).length > 0 ? { partialFingerprints: pf } : {}),
    ...(init.level !== undefined ? { level: init.level } : {}),
  };
  return out;
}

function makeLog(results: readonly ResultInit[]): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep", version: "1.0.0" } },
        results: results.map(makeResult),
      },
    ],
  };
}

test("diffSarif: identical logs bucket every result as unchanged", () => {
  const log = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
    { ruleId: "r.sqli", uri: "api/b.ts", startLine: 20, fingerprint: "b".repeat(32) },
  ]);
  const diff = diffSarif(log, log);
  assert.equal(diff.new.length, 0);
  assert.equal(diff.fixed.length, 0);
  assert.equal(diff.updated.length, 0);
  assert.equal(diff.unchanged.length, 2);
});

test("diffSarif: finding only in current is bucketed as new", () => {
  const baseline = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  const current = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
    { ruleId: "r.sqli", uri: "api/b.ts", startLine: 20, fingerprint: "b".repeat(32) },
  ]);
  const diff = diffSarif(baseline, current);
  assert.equal(diff.new.length, 1);
  assert.equal(diff.new[0]?.ruleId, "r.sqli");
  assert.equal(diff.unchanged.length, 1);
  assert.equal(diff.fixed.length, 0);
});

test("diffSarif: finding only in baseline is bucketed as fixed; applyBaselineState tags current absent-free", () => {
  const baseline = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
    { ruleId: "r.sqli", uri: "api/b.ts", startLine: 20, fingerprint: "b".repeat(32) },
  ]);
  const current = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  const diff = diffSarif(baseline, current);
  assert.equal(diff.fixed.length, 1);
  assert.equal(diff.fixed[0]?.ruleId, "r.sqli");
  assert.equal(diff.unchanged.length, 1);
  assert.equal(diff.new.length, 0);

  const tagged = applyBaselineState(current, baseline);
  const results = tagged.runs[0]?.results ?? [];
  assert.equal(results.length, 1);
  const state = (results[0] as unknown as { baselineState?: string }).baselineState;
  assert.equal(state, "unchanged");
  // We do NOT re-emit baseline-only results into the current log.
  assert.ok(results.every((r) => r?.ruleId !== "r.sqli"));
});

test("diffSarif: same fingerprint, changed message → updated", () => {
  const baseline = makeLog([
    {
      ruleId: "r.xss",
      uri: "web/a.ts",
      startLine: 10,
      fingerprint: "a".repeat(32),
      messageText: "XSS risk (old wording)",
    },
  ]);
  const current = makeLog([
    {
      ruleId: "r.xss",
      uri: "web/a.ts",
      startLine: 10,
      fingerprint: "a".repeat(32),
      messageText: "XSS risk (improved wording)",
    },
  ]);
  const diff = diffSarif(baseline, current);
  assert.equal(diff.updated.length, 1);
  assert.equal(diff.updated[0]?.message?.text, "XSS risk (improved wording)");
  assert.equal(diff.unchanged.length, 0);

  const tagged = applyBaselineState(current, baseline);
  const state = (tagged.runs[0]?.results?.[0] as unknown as { baselineState?: string })
    .baselineState;
  assert.equal(state, "updated");
});

test("diffSarif: git-mv rename — rename chain resolves URI-only changes to unchanged", () => {
  // Scenario: a scanner emits the same opencodehub/v1 fingerprint for
  // the same finding before and after a `git mv`. Fingerprint equality
  // keys them together (pass 1), but the URI change means their SARIF
  // serializations differ — by default this is bucketed as `updated`.
  // A caller-supplied `renameChainFor` that knows `web/new.ts` used to
  // be `web/old.ts` rescues it to `unchanged`.
  const baseline = makeLog([
    { ruleId: "r.xss", uri: "web/old.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  const current = makeLog([
    { ruleId: "r.xss", uri: "web/new.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);

  // Without the resolver, URI differs → `updated`.
  const withoutResolver = diffSarif(baseline, current);
  assert.equal(withoutResolver.updated.length, 1);
  assert.equal(withoutResolver.unchanged.length, 0);
  assert.equal(withoutResolver.fixed.length, 0);
  assert.equal(withoutResolver.new.length, 0);

  // With the resolver, the rename is recognized as the sole change and
  // the finding drops to `unchanged`.
  const renameChainFor = (filePath: string): readonly string[] =>
    filePath === "web/new.ts" ? ["web/old.ts"] : [];
  const withResolver = diffSarif(baseline, current, { renameChainFor });
  assert.equal(withResolver.unchanged.length, 1);
  assert.equal(withResolver.updated.length, 0);
  assert.equal(
    withResolver.unchanged[0]?.locations?.[0]?.physicalLocation?.artifactLocation.uri,
    "web/new.ts",
  );

  const tagged = applyBaselineState(current, baseline, { renameChainFor });
  const state = (tagged.runs[0]?.results?.[0] as unknown as { baselineState?: string })
    .baselineState;
  assert.equal(state, "unchanged");
});

test("diffSarif: falls back to (ruleId, uri, startLine) tuple when fingerprint absent", () => {
  const baseline = makeLog([{ ruleId: "r.sqli", uri: "api/b.ts", startLine: 20 }]);
  const currentSame = makeLog([{ ruleId: "r.sqli", uri: "api/b.ts", startLine: 20 }]);
  const currentMoved = makeLog([{ ruleId: "r.sqli", uri: "api/b.ts", startLine: 21 }]);

  const sameDiff = diffSarif(baseline, currentSame);
  assert.equal(sameDiff.unchanged.length, 1);
  assert.equal(sameDiff.new.length, 0);

  const movedDiff = diffSarif(baseline, currentMoved);
  // Different startLine with no fingerprint → distinct tuples → fixed + new.
  assert.equal(movedDiff.fixed.length, 1);
  assert.equal(movedDiff.new.length, 1);
});

test("diffSarif: output arrays are sorted by (ruleId, uri, startLine)", () => {
  const baseline = makeLog([]);
  const current = makeLog([
    { ruleId: "r.zeta", uri: "z.ts", startLine: 1, fingerprint: "1".repeat(32) },
    { ruleId: "r.alpha", uri: "b.ts", startLine: 9, fingerprint: "2".repeat(32) },
    { ruleId: "r.alpha", uri: "a.ts", startLine: 3, fingerprint: "3".repeat(32) },
  ]);
  const diff = diffSarif(baseline, current);
  assert.equal(diff.new.length, 3);
  assert.equal(diff.new[0]?.ruleId, "r.alpha");
  assert.equal(diff.new[0]?.locations?.[0]?.physicalLocation?.artifactLocation.uri, "a.ts");
  assert.equal(diff.new[1]?.ruleId, "r.alpha");
  assert.equal(diff.new[1]?.locations?.[0]?.physicalLocation?.artifactLocation.uri, "b.ts");
  assert.equal(diff.new[2]?.ruleId, "r.zeta");
});

test("applyBaselineState: does not mutate input logs", () => {
  const baseline = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  const current = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  const baselineSnap = JSON.stringify(baseline);
  const currentSnap = JSON.stringify(current);
  applyBaselineState(current, baseline);
  assert.equal(JSON.stringify(baseline), baselineSnap);
  assert.equal(JSON.stringify(current), currentSnap);
});
