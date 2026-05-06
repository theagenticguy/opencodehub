/**
 * Tests for the JRE probe. Covers:
 *   - parseJreMajor() against the canonical modern output, the legacy
 *     1.x form, and unrelated strings.
 *   - requireJre17() throws JreMissingError when probe returns undefined
 *     or an older version, returns the major when JRE 17+ is reported.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JreMissingError, parseJreMajor, requireJre17 } from "./jre-probe.js";

test("parseJreMajor: modern openjdk 17 line", () => {
  const out = "openjdk 17.0.2 2022-01-18\nOpenJDK Runtime Environment";
  assert.equal(parseJreMajor(out), 17);
});

test("parseJreMajor: openjdk 21", () => {
  const out = "openjdk 21 2023-09-19";
  assert.equal(parseJreMajor(out), 21);
});

test("parseJreMajor: legacy java 8 (1.8.0 form)", () => {
  const out = 'java version "1.8.0_292"';
  assert.equal(parseJreMajor(out), 8);
});

test("parseJreMajor: java version 11.0.12", () => {
  const out = 'java version "11.0.12" 2021-07-20 LTS';
  assert.equal(parseJreMajor(out), 11);
});

test("parseJreMajor: undefined input → undefined", () => {
  assert.equal(parseJreMajor(undefined), undefined);
});

test("parseJreMajor: no version token → undefined", () => {
  assert.equal(parseJreMajor("hello world"), undefined);
});

test("requireJre17: throws when probe returns undefined", async () => {
  await assert.rejects(
    requireJre17(async () => undefined),
    (err: unknown) => {
      assert.ok(err instanceof JreMissingError);
      assert.equal((err as JreMissingError).detectedVersion, undefined);
      return true;
    },
  );
});

test("requireJre17: throws when JRE is too old (Java 11)", async () => {
  await assert.rejects(
    requireJre17(async () => 'openjdk version "11.0.19" 2023-04-18'),
    (err: unknown) => {
      assert.ok(err instanceof JreMissingError);
      assert.match((err as JreMissingError).message, /JRE 17\+/);
      return true;
    },
  );
});

test("requireJre17: returns the major when JRE 17+ is on PATH", async () => {
  const major = await requireJre17(async () => "openjdk 17.0.8 2023-07-18");
  assert.equal(major, 17);
});

test("requireJre17: accepts JRE 21", async () => {
  const major = await requireJre17(async () => "openjdk 21 2023-09-19");
  assert.equal(major, 21);
});
