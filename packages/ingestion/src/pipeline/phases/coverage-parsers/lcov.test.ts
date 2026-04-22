/**
 * lcov parser tests (Stream Q.2).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseLcov } from "./lcov.js";

test("lcov: parses DA records and treats hits > 0 as covered", () => {
  const raw = [
    "TN:",
    "SF:src/foo.ts",
    "DA:1,2",
    "DA:2,0",
    "DA:3,5",
    "DA:4,0",
    "LF:4",
    "LH:2",
    "end_of_record",
  ].join("\n");
  const out = parseLcov(raw, "/repo");
  const foo = out.get("src/foo.ts");
  assert.ok(foo, "expected entry for src/foo.ts");
  assert.deepEqual(foo?.coveredLines, [1, 3]);
  assert.equal(foo?.totalLines, 4);
  assert.equal(foo?.coveragePercent, 0.5);
});

test("lcov: strips repoRoot prefix from absolute SF paths", () => {
  const raw = ["SF:/repo/src/bar.ts", "DA:1,1", "end_of_record"].join("\n");
  const out = parseLcov(raw, "/repo");
  assert.ok(out.has("src/bar.ts"), `keys: ${[...out.keys()].join(",")}`);
});

test("lcov: handles multiple files in one trace", () => {
  const raw = [
    "SF:a.ts",
    "DA:1,1",
    "end_of_record",
    "SF:b.ts",
    "DA:1,0",
    "DA:2,1",
    "end_of_record",
  ].join("\n");
  const out = parseLcov(raw, "/repo");
  assert.equal(out.size, 2);
  assert.equal(out.get("a.ts")?.coveragePercent, 1);
  assert.equal(out.get("b.ts")?.coveragePercent, 0.5);
});
