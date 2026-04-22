/**
 * coverage.py JSON parser tests (Stream Q.2).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseCoveragePy } from "./coverage-py.js";

const FIXTURE = JSON.stringify({
  meta: { version: "7.4.0" },
  files: {
    "src/foo.py": {
      executed_lines: [1, 2, 3],
      missing_lines: [4],
      summary: { covered_lines: 3, num_statements: 4, percent_covered: 75.0 },
    },
    "src/empty.py": {
      executed_lines: [],
      missing_lines: [],
    },
  },
});

test("coverage.py: uses executed_lines ∪ missing_lines for total", () => {
  const out = parseCoveragePy(FIXTURE, "/repo");
  const foo = out.get("src/foo.py");
  assert.ok(foo, `expected src/foo.py, got keys: ${[...out.keys()].join(",")}`);
  assert.deepEqual(foo?.coveredLines, [1, 2, 3]);
  assert.equal(foo?.totalLines, 4);
  assert.equal(foo?.coveragePercent, 0.75);
});

test("coverage.py: skips files with zero instrumented lines", () => {
  const out = parseCoveragePy(FIXTURE, "/repo");
  assert.ok(!out.has("src/empty.py"));
});

test("coverage.py: malformed json returns empty map", () => {
  const out = parseCoveragePy("{not json", "/repo");
  assert.equal(out.size, 0);
});
