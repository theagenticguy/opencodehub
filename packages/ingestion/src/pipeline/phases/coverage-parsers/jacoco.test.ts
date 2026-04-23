/**
 * JaCoCo parser tests.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseJacoco } from "./jacoco.js";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<report name="example">
  <package name="com/foo">
    <sourcefile name="Bar.java">
      <line nr="1" mi="0" ci="2" mb="0" cb="0"/>
      <line nr="2" mi="1" ci="0" mb="0" cb="0"/>
      <line nr="3" mi="0" ci="3" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>
`;

test("jacoco: treats ci > 0 as covered", () => {
  const out = parseJacoco(FIXTURE, "/repo", { sourceRoot: "src/main/java" });
  const bar = out.get("src/main/java/com/foo/Bar.java");
  assert.ok(bar, `expected src/main/java/com/foo/Bar.java, got keys: ${[...out.keys()].join(",")}`);
  assert.deepEqual(bar?.coveredLines, [1, 3]);
  assert.equal(bar?.totalLines, 3);
  assert.ok(Math.abs((bar?.coveragePercent ?? 0) - 2 / 3) < 1e-9);
});

test("jacoco: without sourceRoot emits <package>/<sourcefile> path", () => {
  const out = parseJacoco(FIXTURE, "/repo");
  assert.ok(out.has("com/foo/Bar.java"));
});
