/**
 * Cobertura parser tests (Stream Q.2).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseCobertura } from "./cobertura.js";

const FIXTURE = `<?xml version="1.0" ?>
<coverage line-rate="0.5">
  <packages>
    <package name="src">
      <classes>
        <class name="foo" filename="src/foo.py">
          <lines>
            <line number="1" hits="2"/>
            <line number="2" hits="0"/>
            <line number="3" hits="4"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`;

test("cobertura: parses <line> elements and computes ratio", () => {
  const out = parseCobertura(FIXTURE, "/repo");
  const foo = out.get("src/foo.py");
  assert.ok(foo, `expected src/foo.py, got keys: ${[...out.keys()].join(",")}`);
  assert.deepEqual(foo?.coveredLines, [1, 3]);
  assert.equal(foo?.totalLines, 3);
  assert.ok(Math.abs((foo?.coveragePercent ?? 0) - 2 / 3) < 1e-9);
});

test("cobertura: malformed xml returns empty map", () => {
  const out = parseCobertura("<not>valid", "/repo");
  assert.equal(out.size, 0);
});
