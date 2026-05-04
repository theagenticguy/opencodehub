/**
 * Zod schema tests for packages/policy/src/schemas/policy-v1.ts.
 *
 * These tests exercise the schema in isolation — no YAML parsing, no
 * filesystem — so a schema regression surfaces here first rather than in
 * load/evaluate plumbing tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PolicySchema, RuleSchema } from "./policy-v1.js";

test("PolicySchema: minimal version:1 + empty rules parses and defaults rules to []", () => {
  const parsed = PolicySchema.parse({ version: 1 });
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.rules, []);
});

test("PolicySchema: version must be the literal 1", () => {
  const res = PolicySchema.safeParse({ version: 2, rules: [] });
  assert.equal(res.success, false);
});

test("RuleSchema: license_allowlist requires id + deny", () => {
  assert.equal(
    RuleSchema.safeParse({ type: "license_allowlist", id: "x", deny: ["GPL-3.0"] }).success,
    true,
  );
  assert.equal(RuleSchema.safeParse({ type: "license_allowlist", id: "x" }).success, false);
  assert.equal(
    RuleSchema.safeParse({ type: "license_allowlist", deny: ["GPL-3.0"] }).success,
    false,
  );
});

test("RuleSchema: blast_radius_max requires an integer max_tier", () => {
  assert.equal(
    RuleSchema.safeParse({ type: "blast_radius_max", id: "r1", max_tier: 2 }).success,
    true,
  );
  assert.equal(
    RuleSchema.safeParse({ type: "blast_radius_max", id: "r1", max_tier: 2.5 }).success,
    false,
  );
  assert.equal(RuleSchema.safeParse({ type: "blast_radius_max", id: "r1" }).success, false);
});

test("RuleSchema: ownership_required requires paths and require_approval_from", () => {
  assert.equal(
    RuleSchema.safeParse({
      type: "ownership_required",
      id: "own",
      paths: ["packages/storage/**"],
      require_approval_from: ["@storage-team"],
    }).success,
    true,
  );
  assert.equal(
    RuleSchema.safeParse({
      type: "ownership_required",
      id: "own",
      paths: ["x"],
    }).success,
    false,
  );
});

test("RuleSchema: rejects unknown discriminator value", () => {
  const res = RuleSchema.safeParse({ type: "unicorn", id: "r" });
  assert.equal(res.success, false);
});

test("PolicySchema: auto_approve.require survives all three known shapes", () => {
  const parsed = PolicySchema.parse({
    version: 1,
    auto_approve: {
      require: [
        { "blast_radius.tier": ">= 3" },
        { "findings.severity_error": 0 },
        { "license_audit.violations": 0 },
      ],
    },
  });
  assert.equal(parsed.auto_approve?.require?.length, 3);
});
