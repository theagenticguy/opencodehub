/**
 * Smoke test for @opencodehub/pack public entry.
 *
 * AC-M5-1 only wires the scaffold — this test asserts the public entry
 * compiles and exposes `generatePack` as a function. The stub throws at
 * runtime; exercising that throw is intentionally left to AC-M5-3+.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generatePack } from "./index.js";

describe("@opencodehub/pack public entry (AC-M5-1 scaffold)", () => {
  it("exports generatePack as a function", () => {
    assert.equal(typeof generatePack, "function");
  });

  it("generatePack is async (returns a Promise)", () => {
    // Swallow the stub's throw; we only care the return type is a Promise.
    const result = generatePack({
      repoPath: "/tmp/fixture",
      outDir: "/tmp/fixture-out",
      budgetTokens: 1024,
      tokenizerId: "anthropic:claude-opus@4.7",
    }).catch(() => undefined);
    assert.ok(result instanceof Promise);
  });
});
