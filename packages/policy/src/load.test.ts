/**
 * Tests for loadPolicy — covering the EARS state machine:
 *   - missing file          → undefined
 *   - empty / all-comment    → undefined
 *   - malformed YAML         → PolicyValidationError
 *   - schema failure         → PolicyValidationError (with Zod path in msg)
 *   - good shape             → typed Policy
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy, PolicyValidationError } from "./load.js";

function writeTmp(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codehub-policy-"));
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

test("loadPolicy: returns undefined when the file does not exist", async () => {
  const policy = await loadPolicy(join(tmpdir(), "does-not-exist.policy.yaml"));
  assert.equal(policy, undefined);
});

test("loadPolicy: returns undefined for an empty YAML file", async () => {
  const path = writeTmp("empty.policy.yaml", "");
  const policy = await loadPolicy(path);
  assert.equal(policy, undefined);
});

test("loadPolicy: returns undefined for an all-comment YAML file (starter state)", async () => {
  const path = writeTmp(
    "starter.policy.yaml",
    [
      "# OpenCodeHub policy (v1 — starter)",
      "#",
      "# version: 1",
      "# rules:",
      "#   - id: no-gpl",
      "#     type: license_allowlist",
      '#     deny: ["GPL-3.0"]',
      "",
    ].join("\n"),
  );
  const policy = await loadPolicy(path);
  assert.equal(policy, undefined);
});

test("loadPolicy: throws PolicyValidationError on malformed YAML", async () => {
  const path = writeTmp(
    "bad.policy.yaml",
    // Mismatched bracket — YAML parser rejects.
    "version: 1\nrules: [\n  - foo",
  );
  await assert.rejects(loadPolicy(path), (err: unknown) => {
    assert.ok(err instanceof PolicyValidationError, "expected PolicyValidationError");
    assert.match((err as PolicyValidationError).message, /failed to parse/);
    return true;
  });
});

test("loadPolicy: throws PolicyValidationError when version != 1", async () => {
  const path = writeTmp("wrong-version.policy.yaml", ["version: 2", "rules: []", ""].join("\n"));
  await assert.rejects(loadPolicy(path), (err: unknown) => {
    assert.ok(err instanceof PolicyValidationError);
    assert.match((err as PolicyValidationError).message, /invalid policy/);
    assert.match((err as PolicyValidationError).message, /version/);
    return true;
  });
});

test("loadPolicy: throws PolicyValidationError when a rule has an unknown type", async () => {
  const path = writeTmp(
    "unknown-type.policy.yaml",
    [
      "version: 1",
      "rules:",
      "  - id: mystery",
      "    type: not_a_real_rule",
      '    deny: ["X"]',
      "",
    ].join("\n"),
  );
  await assert.rejects(loadPolicy(path), PolicyValidationError);
});

test("loadPolicy: throws PolicyValidationError when license_allowlist.deny is missing", async () => {
  const path = writeTmp(
    "missing-deny.policy.yaml",
    ["version: 1", "rules:", "  - id: no-gpl", "    type: license_allowlist", ""].join("\n"),
  );
  await assert.rejects(loadPolicy(path), (err: unknown) => {
    assert.ok(err instanceof PolicyValidationError);
    // Path should include `rules.0.deny` or similar — precise Zod message.
    assert.match((err as PolicyValidationError).message, /deny/);
    return true;
  });
});

test("loadPolicy: returns a typed Policy for a well-formed file", async () => {
  const path = writeTmp(
    "good.policy.yaml",
    [
      "version: 1",
      "auto_approve:",
      "  require:",
      '    - blast_radius.tier: ">= 3"',
      "    - findings.severity_error: 0",
      "    - license_audit.violations: 0",
      "rules:",
      "  - id: no-gpl",
      "    type: license_allowlist",
      '    deny: ["GPL-3.0", "AGPL-3.0"]',
      "  - id: radius-cap",
      "    type: blast_radius_max",
      "    max_tier: 2",
      "  - id: storage-owner",
      "    type: ownership_required",
      '    paths: ["packages/storage/**"]',
      '    require_approval_from: ["@storage-team"]',
      "",
    ].join("\n"),
  );
  const policy = await loadPolicy(path);
  assert.ok(policy);
  assert.equal(policy?.version, 1);
  assert.equal(policy?.rules.length, 3);
  assert.equal(policy?.rules[0]?.type, "license_allowlist");
  assert.equal(policy?.rules[1]?.type, "blast_radius_max");
  assert.equal(policy?.rules[2]?.type, "ownership_required");
  // auto_approve survives parse.
  assert.equal(policy?.auto_approve?.require?.length, 3);
});

test("loadPolicy: rules defaults to [] when omitted", async () => {
  const path = writeTmp("no-rules.policy.yaml", ["version: 1", ""].join("\n"));
  const policy = await loadPolicy(path);
  assert.ok(policy);
  assert.deepEqual(policy?.rules, []);
});
