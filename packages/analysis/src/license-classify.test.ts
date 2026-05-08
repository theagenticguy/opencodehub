/**
 * Unit tests for the pure `classifyDependencies` helper. Mirrors the
 * coverage that previously lived in
 * `@opencodehub/mcp/src/tools/license-audit.test.ts` so the lifted
 * implementation has its own, package-local regression suite.
 *
 * Covered cases:
 *   1. All MIT/Apache → tier=OK.
 *   2. One UNKNOWN + nothing else flagged → tier=WARN.
 *   3. Empty license string → tier=WARN (treated as UNKNOWN).
 *   4. One GPL-3.0 → tier=BLOCK (even if others are OK).
 *   5. One PROPRIETARY → tier=BLOCK.
 *   6. AGPL / SSPL / EUPL / CPAL / OSL / RPL all route to copyleft.
 *   7. LGPL does NOT match copyleft (intentional — weak copyleft is
 *      categorised separately, currently OK at v1.0).
 *   8. Case-insensitive copyleft match.
 *   9. BLOCK wins over WARN when both are present.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { DependencyRef } from "./license-classify.js";
import { classifyDependencies } from "./license-classify.js";

function dep(name: string, license: string): DependencyRef {
  return {
    id: `Dependency:npm:${name}@1.0.0`,
    name,
    version: "1.0.0",
    ecosystem: "npm",
    license,
    lockfileSource: "package.json",
  };
}

describe("classifyDependencies", () => {
  it("returns tier=OK when every license is permissive", () => {
    const r = classifyDependencies([dep("lodash", "MIT"), dep("axios", "Apache-2.0")]);
    assert.equal(r.tier, "OK");
    assert.equal(r.summary.okCount, 2);
    assert.equal(r.summary.flaggedCount, 0);
    assert.equal(r.flagged.copyleft.length, 0);
    assert.equal(r.flagged.unknown.length, 0);
    assert.equal(r.flagged.proprietary.length, 0);
  });

  it("returns tier=WARN when only UNKNOWN licenses are flagged", () => {
    const r = classifyDependencies([dep("mystery", "UNKNOWN"), dep("good", "MIT")]);
    assert.equal(r.tier, "WARN");
    assert.equal(r.summary.total, 2);
    assert.equal(r.summary.okCount, 1);
    assert.equal(r.flagged.unknown.length, 1);
    assert.equal(r.flagged.unknown[0]?.name, "mystery");
  });

  it("returns tier=WARN for empty license string (treated as UNKNOWN)", () => {
    const r = classifyDependencies([dep("bare", "")]);
    assert.equal(r.tier, "WARN");
    assert.equal(r.flagged.unknown.length, 1);
  });

  it("returns tier=BLOCK with a single GPL-3.0 dep", () => {
    const r = classifyDependencies([dep("readline", "GPL-3.0"), dep("good", "MIT")]);
    assert.equal(r.tier, "BLOCK");
    assert.equal(r.flagged.copyleft.length, 1);
    assert.equal(r.flagged.copyleft[0]?.name, "readline");
  });

  it("returns tier=BLOCK for a PROPRIETARY dep", () => {
    const r = classifyDependencies([dep("secret", "PROPRIETARY")]);
    assert.equal(r.tier, "BLOCK");
    assert.equal(r.flagged.proprietary.length, 1);
    assert.equal(r.flagged.copyleft.length, 0);
  });

  it("flags AGPL / SSPL / EUPL / CPAL / OSL / RPL as copyleft", () => {
    const r = classifyDependencies([
      dep("a", "AGPL-3.0"),
      dep("b", "SSPL-1.0"),
      dep("c", "EUPL-1.2"),
      dep("d", "CPAL-1.0"),
      dep("e", "OSL-3.0"),
      dep("f", "RPL-1.5"),
    ]);
    assert.equal(r.tier, "BLOCK");
    assert.equal(r.flagged.copyleft.length, 6);
  });

  it("does NOT classify LGPL as copyleft at v1.0", () => {
    // Weak copyleft: the v1 policy routes this through neither copyleft
    // nor unknown (LGPL-3.0 is an acknowledged license). The regression
    // guard below asserts the non-BLOCK outcome so future widening of the
    // copyleft set is an explicit decision.
    const r = classifyDependencies([dep("libz", "LGPL-3.0")]);
    assert.equal(r.tier, "OK");
    assert.equal(r.flagged.copyleft.length, 0);
  });

  it("case-insensitive match for copyleft patterns", () => {
    const r = classifyDependencies([dep("lowercase", "gpl-3.0")]);
    assert.equal(r.tier, "BLOCK");
    assert.equal(r.flagged.copyleft.length, 1);
  });

  it("BLOCK wins over WARN when both are present", () => {
    const r = classifyDependencies([dep("x", "UNKNOWN"), dep("y", "GPL-2.0"), dep("z", "MIT")]);
    assert.equal(r.tier, "BLOCK");
    assert.equal(r.flagged.unknown.length, 1);
    assert.equal(r.flagged.copyleft.length, 1);
    assert.equal(r.summary.flaggedCount, 2);
    assert.equal(r.summary.okCount, 1);
  });
});
