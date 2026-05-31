import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSchemaVersion, SCHEMA_VERSION } from "./schema-version.js";

test("compareSchemaVersion: same version is ok", () => {
  assert.equal(compareSchemaVersion(SCHEMA_VERSION), "ok");
});

test("compareSchemaVersion: differing major is major-drift", () => {
  assert.equal(compareSchemaVersion("2.0.0"), "major-drift");
  assert.equal(compareSchemaVersion("0.9.0"), "major-drift");
});

test("compareSchemaVersion: older indexed minor is minor-drift", () => {
  assert.equal(compareSchemaVersion("1.1.0"), "minor-drift");
});

test("compareSchemaVersion: newer indexed minor is forward-incompat", () => {
  // An older binary reading a graph written by a newer-schema binary must not
  // be reported as drift-free: it may be missing fields/invariants the newer
  // minor introduced.
  assert.equal(compareSchemaVersion("1.3.0"), "forward-incompat");
});

test("compareSchemaVersion: patch differences are tolerated as ok", () => {
  assert.equal(compareSchemaVersion("1.2.9"), "ok");
  assert.equal(compareSchemaVersion("1.2"), "ok");
});

test("compareSchemaVersion: rejects malformed versions", () => {
  assert.throws(() => compareSchemaVersion("1"));
  assert.throws(() => compareSchemaVersion("x.y.z"));
});
