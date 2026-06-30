import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  type ArmDispersion,
  bernoulliDispersion,
  dispersionScalar,
  distinctOutputRatio,
  mean,
  populationStddev,
} from "./dispersion.js";

describe("populationStddev", () => {
  it("returns 0 for fewer than two values", () => {
    assert.equal(populationStddev([]), 0);
    assert.equal(populationStddev([5]), 0);
  });

  it("is zero for a constant sample", () => {
    assert.equal(populationStddev([3, 3, 3, 3]), 0);
  });

  it("computes the population (not sample) stddev", () => {
    // values [0,1] → mean 0.5, variance ((.25)+(.25))/2 = .25, stddev .5
    assert.equal(populationStddev([0, 1]), 0.5);
    // [2,4,4,4,5,5,7,9] is the classic example: population stddev = 2
    assert.equal(populationStddev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  });
});

describe("mean", () => {
  it("returns 0 for empty input", () => {
    assert.equal(mean([]), 0);
  });
  it("averages", () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5);
  });
});

describe("distinctOutputRatio", () => {
  it("returns 0 for empty input", () => {
    assert.equal(distinctOutputRatio([]), 0);
  });
  it("is 1/N when every output is identical (perfectly stable)", () => {
    assert.equal(distinctOutputRatio(["a", "a", "a", "a"]), 0.25);
  });
  it("is 1.0 when every output differs (maximally unstable)", () => {
    assert.equal(distinctOutputRatio(["a", "b", "c"]), 1);
  });
  it("counts distinct values", () => {
    assert.equal(distinctOutputRatio(["a", "a", "b", "b"]), 0.5);
  });
});

describe("bernoulliDispersion", () => {
  it("returns zeros for empty input", () => {
    assert.deepEqual(bernoulliDispersion([]), { passRate: 0, stddev: 0 });
  });
  it("is zero-dispersion when the agent is perfectly consistent (all pass)", () => {
    const d = bernoulliDispersion([true, true, true, true]);
    assert.equal(d.passRate, 1);
    assert.equal(d.stddev, 0);
  });
  it("is zero-dispersion when perfectly consistent (all fail)", () => {
    const d = bernoulliDispersion([false, false, false]);
    assert.equal(d.passRate, 0);
    assert.equal(d.stddev, 0);
  });
  it("is maximal at a 50/50 coin-flip agent", () => {
    const d = bernoulliDispersion([true, false, true, false]);
    assert.equal(d.passRate, 0.5);
    assert.equal(d.stddev, 0.5); // sqrt(0.5*0.5)
  });
  it("captures the headline example: 6/10 with vs 3/10 without", () => {
    const withPack = bernoulliDispersion([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    const withoutPack = bernoulliDispersion([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    assert.equal(withPack.passRate, 0.6);
    assert.equal(withoutPack.passRate, 0.3);
    // without-pack stddev (p=0.3) is higher than the toward-extreme... actually
    // 0.6 is closer to 0.5 than 0.3, so with-pack stddev is HIGHER here — the
    // pass-rate is the headline; stddev measures distance from a decided agent.
    assert.ok(withPack.stddev > 0 && withoutPack.stddev > 0);
  });
});

describe("dispersionScalar", () => {
  it("uses the distinct ratio for output_hash", () => {
    const d: ArmDispersion = { kind: "output_hash", distinctRatio: 0.7, runs: 10 };
    assert.equal(dispersionScalar(d), 0.7);
  });
  it("uses the stddev for assertion", () => {
    const d: ArmDispersion = { kind: "assertion", passRate: 0.6, stddev: 0.49, runs: 10 };
    assert.equal(dispersionScalar(d), 0.49);
  });
  it("uses the stddev for judge", () => {
    const d: ArmDispersion = { kind: "judge", meanScore: 0.8, stddev: 0.12, runs: 10 };
    assert.equal(dispersionScalar(d), 0.12);
  });
});
