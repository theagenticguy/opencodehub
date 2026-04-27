import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate,
  type CaseScore,
  confusion,
  evaluateSet,
  jaccard,
  kendallTau,
  precisionRecallF1,
} from "./metrics.js";

test("confusion: disjoint and overlap cases produce correct tp/fp/fn", () => {
  assert.deepEqual(confusion([], []), { tp: 0, fp: 0, fn: 0 });
  assert.deepEqual(confusion(["a", "b", "c"], ["d", "e"]), { tp: 0, fp: 2, fn: 3 });
  assert.deepEqual(confusion(["a", "b", "c"], ["a", "b", "c"]), { tp: 3, fp: 0, fn: 0 });
  assert.deepEqual(confusion(["a", "b", "c"], ["b", "c", "d"]), { tp: 2, fp: 1, fn: 1 });
  // Duplicates in the iterable collapse via Set semantics.
  assert.deepEqual(confusion(["a", "a", "b"], ["a", "b", "b"]), { tp: 2, fp: 0, fn: 0 });
});

test("precisionRecallF1: perfect, all-wrong, and empty cases return 0 not NaN", () => {
  assert.deepEqual(precisionRecallF1({ tp: 5, fp: 0, fn: 0 }), {
    precision: 1,
    recall: 1,
    f1: 1,
  });
  assert.deepEqual(precisionRecallF1({ tp: 0, fp: 3, fn: 4 }), {
    precision: 0,
    recall: 0,
    f1: 0,
  });
  const empty = precisionRecallF1({ tp: 0, fp: 0, fn: 0 });
  assert.equal(empty.precision, 0);
  assert.equal(empty.recall, 0);
  assert.equal(empty.f1, 0);
  assert.ok(!Number.isNaN(empty.f1));
  const noPredictions = precisionRecallF1({ tp: 0, fp: 0, fn: 5 });
  assert.equal(noPredictions.precision, 0);
  assert.equal(noPredictions.recall, 0);
  assert.equal(noPredictions.f1, 0);
  const noExpected = precisionRecallF1({ tp: 0, fp: 5, fn: 0 });
  assert.equal(noExpected.precision, 0);
  assert.equal(noExpected.recall, 0);
  assert.equal(noExpected.f1, 0);
});

test("evaluateSet: returns counts and rates combined in a single object", () => {
  const result = evaluateSet(["a", "b", "c"], ["b", "c", "d"]);
  assert.equal(result.tp, 2);
  assert.equal(result.fp, 1);
  assert.equal(result.fn, 1);
  assert.ok(Math.abs(result.precision - 2 / 3) < 1e-12);
  assert.ok(Math.abs(result.recall - 2 / 3) < 1e-12);
  assert.ok(Math.abs(result.f1 - 2 / 3) < 1e-12);
});

test("jaccard: disjoint 0, identical 1, both-empty 1, one-empty 0", () => {
  assert.equal(jaccard(["a", "b"], ["c", "d"]), 0);
  assert.equal(jaccard(["a", "b", "c"], ["a", "b", "c"]), 1);
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(["a"], []), 0);
  assert.equal(jaccard([], ["a"]), 0);
  // Partial overlap: {a,b,c} ∩ {b,c,d} = {b,c}; ∪ = {a,b,c,d}; 2/4 = 0.5.
  assert.equal(jaccard(["a", "b", "c"], ["b", "c", "d"]), 0.5);
});

test("kendallTau: perfect agreement 1, perfect disagreement -1, tied via Wikipedia example", () => {
  assert.equal(kendallTau(["a", "b", "c", "d"], ["a", "b", "c", "d"]), 1);
  assert.equal(kendallTau(["a", "b", "c"], ["c", "b", "a"]), -1);
  // Wikipedia: x=[1,2,3,4,5], y=[1,3,2,5,4] → tau-b = 0.6.
  const x = ["1", "2", "3", "4", "5"];
  const y = ["1", "3", "2", "5", "4"];
  const tau = kendallTau(x, y);
  assert.ok(Math.abs(tau - 0.6) < 1e-12, `expected ~0.6, got ${tau}`);
  // Empty-empty returns 0, not NaN.
  assert.equal(kendallTau([], []), 0);
});

test("kendallTau: items missing from actual are treated as tied-last", () => {
  // "z" present in expected, absent in actual → tied-last in actual's ranking.
  // Universe = [a, b, z]; rankX = {a:1, b:2, z:3}; rankY = {a:1, b:2, z:3 (tied-last=3)}.
  // All pairs concordant since rankings match → tau = 1.
  const tauMatch = kendallTau(["a", "b", "z"], ["a", "b"]);
  assert.equal(tauMatch, 1);

  // If expected is [z, a, b] but actual is [a, b], z is ranked first in expected
  // but tied-last in actual. Pair (z,a): rx=1-2=-1, ry=3-1=2 → discordant.
  // Pair (z,b): rx=1-3=-2, ry=3-2=1 → discordant. Pair (a,b): rx=-1, ry=-1 → concordant.
  // C=1, D=2, tiedX=0, tiedY=0. tau = (1-2)/sqrt(3*3) = -1/3.
  const tauDisagree = kendallTau(["z", "a", "b"], ["a", "b"]);
  assert.ok(Math.abs(tauDisagree - -1 / 3) < 1e-12, `expected -1/3, got ${tauDisagree}`);
});

test("aggregate: single case preserves per-case f1; multiple cases micro-average; sorted by key", () => {
  const single: CaseScore = {
    language: "python",
    tool: "scip-python@0.6.6",
    caseKind: "references",
    caseId: "case-1",
    scores: { tp: 2, fp: 1, fn: 1, precision: 2 / 3, recall: 2 / 3, f1: 2 / 3 },
    jaccard: 0.5,
    kendallTau: 0.6,
  };
  const singleRollup = aggregate([single]);
  assert.equal(singleRollup.length, 1);
  assert.equal(singleRollup[0]?.key, "python/scip-python@0.6.6/references");
  assert.equal(singleRollup[0]?.caseCount, 1);
  assert.ok(Math.abs((singleRollup[0]?.f1 ?? 0) - 2 / 3) < 1e-12);
  assert.equal(singleRollup[0]?.meanJaccard, 0.5);
  assert.equal(singleRollup[0]?.meanKendallTau, 0.6);

  // Two cases same bucket → micro-averaged: tp=5, fp=1, fn=1 → p=5/6, r=5/6.
  const second: CaseScore = {
    ...single,
    caseId: "case-2",
    scores: { tp: 3, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 },
    jaccard: 1,
    kendallTau: 1,
  };
  const twoRollup = aggregate([single, second]);
  assert.equal(twoRollup.length, 1);
  const r = twoRollup[0];
  assert.ok(r !== undefined);
  assert.equal(r.caseCount, 2);
  assert.ok(Math.abs(r.precision - 5 / 6) < 1e-12);
  assert.ok(Math.abs(r.recall - 5 / 6) < 1e-12);
  assert.ok(Math.abs(r.f1 - 5 / 6) < 1e-12);
  assert.ok(Math.abs(r.meanJaccard - 0.75) < 1e-12);
  assert.ok(Math.abs((r.meanKendallTau ?? 0) - 0.8) < 1e-12);

  // Different keys → separate rollups, sorted ascending by key.
  const other: CaseScore = {
    language: "typescript",
    tool: "scip-typescript@0.4.0",
    caseKind: "references",
    caseId: "ts-1",
    scores: { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 },
    jaccard: 1,
  };
  const multi = aggregate([other, single]);
  assert.equal(multi.length, 2);
  assert.equal(multi[0]?.key, "python/scip-python@0.6.6/references");
  assert.equal(multi[1]?.key, "typescript/scip-typescript@0.4.0/references");
  // Case without kendallTau contributes nothing to mean; undefined when none present.
  assert.equal(multi[1]?.meanKendallTau, undefined);
});
