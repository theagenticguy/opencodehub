import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decayWeight } from "./churn-decay.js";

const SEC_PER_DAY = 86_400;

describe("decayWeight", () => {
  it("is 1.0 at age 0", () => {
    const now = 1_700_000_000;
    assert.ok(Math.abs(decayWeight(now, now, 90) - 1) < 1e-9);
  });

  it("is 0.5 at age = halfLife", () => {
    const now = 1_700_000_000;
    const t = now - 90 * SEC_PER_DAY;
    const w = decayWeight(t, now, 90);
    assert.ok(Math.abs(w - 0.5) < 1e-9);
  });

  it("is 0.25 at age = 2 * halfLife", () => {
    const now = 1_700_000_000;
    const t = now - 180 * SEC_PER_DAY;
    const w = decayWeight(t, now, 90);
    assert.ok(Math.abs(w - 0.25) < 1e-9);
  });

  it("clamps future-dated commits to weight 1", () => {
    const now = 1_700_000_000;
    const future = now + 10 * SEC_PER_DAY;
    assert.ok(Math.abs(decayWeight(future, now, 90) - 1) < 1e-9);
  });

  it("throws for non-positive halfLife", () => {
    assert.throws(() => decayWeight(0, 0, 0));
    assert.throws(() => decayWeight(0, 0, -5));
  });

  it("configurable halfLife: 30 days yields 0.5 at 30-day age", () => {
    const now = 1_700_000_000;
    const t = now - 30 * SEC_PER_DAY;
    assert.ok(Math.abs(decayWeight(t, now, 30) - 0.5) < 1e-9);
  });
});
