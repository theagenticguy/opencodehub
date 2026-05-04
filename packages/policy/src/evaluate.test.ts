/**
 * Tests for evaluatePolicy.
 *
 * Covers:
 *   - empty rules list -> pass
 *   - license_allowlist pass + fail (multiple denies per run)
 *   - blast_radius_max pass (<=) + fail (>)
 *   - ownership_required:
 *       - path not under glob -> ignored
 *       - path with owner approval -> pass
 *       - path under explicit require_approval_from with approval -> pass
 *       - path with no approval -> block
 *       - path with no owners at all -> block with dedicated reason
 *   - multi-rule: violations collapse to `block`, sorted by ruleId
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePolicy, type PolicyContext } from "./evaluate.js";
import type { Policy } from "./schemas/policy-v1.js";

function emptyCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    licenseViolations: [],
    blastRadiusTier: 0,
    touchedPaths: [],
    ownersByPath: new Map(),
    approvals: [],
    ...overrides,
  };
}

test("evaluatePolicy: empty rules -> pass", () => {
  const policy: Policy = { version: 1, rules: [] };
  const decision = evaluatePolicy(policy, emptyCtx());
  assert.equal(decision.status, "pass");
  assert.deepEqual(decision.violations, []);
});

// ---- license_allowlist ---------------------------------------------------

test("license_allowlist: passes when no denied license observed", () => {
  const policy: Policy = {
    version: 1,
    rules: [{ type: "license_allowlist", id: "no-gpl", deny: ["GPL-3.0", "AGPL-3.0"] }],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({ licenseViolations: [{ license: "MIT", package: "lodash" }] }),
  );
  assert.equal(decision.status, "pass");
});

test("license_allowlist: blocks and flags every denied hit", () => {
  const policy: Policy = {
    version: 1,
    rules: [{ type: "license_allowlist", id: "no-gpl", deny: ["GPL-3.0", "AGPL-3.0"] }],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      licenseViolations: [
        { license: "GPL-3.0", package: "readline-gpl" },
        { license: "AGPL-3.0", package: "mongodb-network" },
        { license: "MIT", package: "lodash" },
      ],
    }),
  );
  assert.equal(decision.status, "block");
  assert.equal(decision.violations.length, 2);
  assert.ok(decision.violations.every((v) => v.ruleId === "no-gpl"));
});

// ---- blast_radius_max ----------------------------------------------------

test("blast_radius_max: passes when tier <= max_tier", () => {
  const policy: Policy = {
    version: 1,
    rules: [{ type: "blast_radius_max", id: "radius-cap", max_tier: 2 }],
  };
  const decision = evaluatePolicy(policy, emptyCtx({ blastRadiusTier: 2 }));
  assert.equal(decision.status, "pass");
});

test("blast_radius_max: blocks when tier > max_tier", () => {
  const policy: Policy = {
    version: 1,
    rules: [{ type: "blast_radius_max", id: "radius-cap", max_tier: 2 }],
  };
  const decision = evaluatePolicy(policy, emptyCtx({ blastRadiusTier: 4 }));
  assert.equal(decision.status, "block");
  assert.equal(decision.violations.length, 1);
  assert.equal(decision.violations[0]?.ruleId, "radius-cap");
  assert.match(decision.violations[0]?.reason ?? "", /tier 4.+max 2/);
});

// ---- ownership_required --------------------------------------------------

test("ownership_required: ignores paths outside the glob", () => {
  const policy: Policy = {
    version: 1,
    rules: [
      {
        type: "ownership_required",
        id: "storage-owner",
        paths: ["packages/storage/**"],
        require_approval_from: ["@storage-team"],
      },
    ],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      touchedPaths: ["packages/cli/src/index.ts"],
      approvals: [],
    }),
  );
  assert.equal(decision.status, "pass");
});

test("ownership_required: passes when approval comes from require_approval_from", () => {
  const policy: Policy = {
    version: 1,
    rules: [
      {
        type: "ownership_required",
        id: "storage-owner",
        paths: ["packages/storage/**"],
        require_approval_from: ["@storage-team"],
      },
    ],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      touchedPaths: ["packages/storage/src/duckdb.ts"],
      approvals: ["@storage-team"],
    }),
  );
  assert.equal(decision.status, "pass");
});

test("ownership_required: passes when approval comes from path owner", () => {
  const policy: Policy = {
    version: 1,
    rules: [
      {
        type: "ownership_required",
        id: "graph-owner",
        paths: ["packages/**"],
        require_approval_from: [],
      },
    ],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      touchedPaths: ["packages/search/src/bm25.ts"],
      ownersByPath: new Map([["packages/search/src/bm25.ts", ["alice@example.com"]]]),
      approvals: ["alice@example.com"],
    }),
  );
  assert.equal(decision.status, "pass");
});

test("ownership_required: blocks when no acceptable approval is present", () => {
  const policy: Policy = {
    version: 1,
    rules: [
      {
        type: "ownership_required",
        id: "storage-owner",
        paths: ["packages/storage/**"],
        require_approval_from: ["@storage-team"],
      },
    ],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      touchedPaths: ["packages/storage/src/duckdb.ts"],
      approvals: ["@not-storage"],
    }),
  );
  assert.equal(decision.status, "block");
  assert.equal(decision.violations.length, 1);
  assert.match(decision.violations[0]?.reason ?? "", /requires approval/);
  assert.match(decision.violations[0]?.reason ?? "", /@storage-team/);
});

test("ownership_required: blocks when no owners or explicit approvers are known for a matched path", () => {
  const policy: Policy = {
    version: 1,
    rules: [
      {
        type: "ownership_required",
        id: "graph-owner",
        paths: ["packages/**"],
        require_approval_from: [],
      },
    ],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      touchedPaths: ["packages/orphan/src/foo.ts"],
      approvals: ["alice@example.com"],
    }),
  );
  assert.equal(decision.status, "block");
  assert.match(decision.violations[0]?.reason ?? "", /no owners/);
});

test("ownership_required: matches single-segment wildcard with '*'", () => {
  const policy: Policy = {
    version: 1,
    rules: [
      {
        type: "ownership_required",
        id: "toplevel",
        paths: ["packages/*/src/index.ts"],
        require_approval_from: ["@maintainers"],
      },
    ],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      touchedPaths: ["packages/cli/src/index.ts", "packages/cli/src/nested/skip.ts"],
      approvals: [],
    }),
  );
  // Only the first path matches; second has too many segments between
  // packages/ and src/index.ts for a single `*`.
  assert.equal(decision.status, "block");
  assert.equal(decision.violations.length, 1);
});

// ---- multi-rule determinism ---------------------------------------------

test("evaluatePolicy: violations are sorted by ruleId across mixed rule types", () => {
  const policy: Policy = {
    version: 1,
    rules: [
      { type: "blast_radius_max", id: "z-radius", max_tier: 1 },
      { type: "license_allowlist", id: "a-license", deny: ["GPL-3.0"] },
      {
        type: "ownership_required",
        id: "m-owner",
        paths: ["packages/storage/**"],
        require_approval_from: ["@storage-team"],
      },
    ],
  };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      blastRadiusTier: 3,
      licenseViolations: [{ license: "GPL-3.0", package: "readline-gpl" }],
      touchedPaths: ["packages/storage/src/duckdb.ts"],
      approvals: [],
    }),
  );
  assert.equal(decision.status, "block");
  const ids = decision.violations.map((v) => v.ruleId);
  assert.deepEqual(ids, ["a-license", "m-owner", "z-radius"]);
});

test("evaluatePolicy: empty rules on an exotic context still returns pass", () => {
  const policy: Policy = { version: 1, rules: [] };
  const decision = evaluatePolicy(
    policy,
    emptyCtx({
      blastRadiusTier: 99,
      licenseViolations: [{ license: "GPL-3.0", package: "x" }],
    }),
  );
  assert.equal(decision.status, "pass");
  assert.deepEqual(decision.violations, []);
});
