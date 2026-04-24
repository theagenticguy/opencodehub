import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { busFactor, gini } from "./gini.js";

describe("gini", () => {
  it("returns 0 for empty input", () => {
    assert.equal(gini([]), 0);
  });

  it("returns 0 for all-zero input", () => {
    assert.equal(gini([0, 0, 0]), 0);
  });

  it("returns 0 for perfectly uniform distribution", () => {
    assert.ok(Math.abs(gini([5, 5, 5, 5])) < 1e-9);
  });

  it("is close to 1 for maximum skew", () => {
    const g = gini([0, 0, 0, 0, 10]);
    assert.ok(g > 0.79 && g < 0.81);
  });

  it("matches the pairwise-mean-abs-diff value for [1,2,3]", () => {
    // By hand: pairs |1-2|+|1-3|+|2-1|+|2-3|+|3-1|+|3-2| = 8
    // G = 8 / (2 * 9 * 2) = 8 / 36 ≈ 0.2222
    const g = gini([1, 2, 3]);
    assert.ok(Math.abs(g - 8 / 36) < 1e-9);
  });

  it("throws on negative input", () => {
    assert.throws(() => gini([1, -1]));
  });
});

describe("busFactor", () => {
  it("single author → 1", () => {
    assert.equal(busFactor([10]), 1);
  });

  it("two uniform authors → 2", () => {
    assert.equal(busFactor([5, 5]), 2);
  });

  it("three skewed authors [10,0,0] → 1", () => {
    // Zero-count contributors are filtered out; the one active author yields 1.
    assert.equal(busFactor([10, 0, 0]), 1);
  });

  it("three skewed with small others [10,1,1] → 2", () => {
    const bf = busFactor([10, 1, 1]);
    assert.ok(bf >= 1 && bf <= 3);
    // Gini ~ 0.55 → 1 + round(0.45 * 2) = 1 + 1 = 2
    assert.equal(bf, 2);
  });

  it("ten uniform authors → 10", () => {
    assert.equal(busFactor([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 10);
  });

  it("empty input → 1", () => {
    assert.equal(busFactor([]), 1);
  });

  it("all zero input → 1", () => {
    assert.equal(busFactor([0, 0, 0]), 1);
  });
});
