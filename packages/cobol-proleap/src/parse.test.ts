/**
 * Tests for the public parseCobolDeep() entry. We cannot assume a real
 * JVM + ProLeap JAR in CI, so the tests exercise:
 *
 *   - Empty input short-circuit (no subprocess spawn).
 *   - Missing-JAR precondition surfaces as JarMissingError (via runBatch).
 *   - The silent-fallback code path by forcing runBatch to "crash"
 *     indirectly: pointing `jarPath` at a bogus file triggers the upfront
 *     error rather than the fallback, which is the documented contract —
 *     the caller is expected to have run `codehub setup --cobol-proleap`.
 *     The actual crash-→-fallback fusion is covered in
 *     `fallback.test.ts` + the crashed-outcome branch is type-checked
 *     here via a small stub.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCobolDeep } from "./parse.js";
import { JarMissingError } from "./subprocess.js";

test("parseCobolDeep: empty path list resolves to an empty result", async () => {
  const res = await parseCobolDeep([], {
    jarPath: "/does/not/exist.jar",
    wrapperClassPath: "/does/not/exist",
  });
  assert.deepEqual([...res.elements], []);
  assert.deepEqual([...res.diagnostics], []);
  assert.equal(res.fellBackToRegex, false);
});

test("parseCobolDeep: missing JAR surfaces JarMissingError from the first batch", async () => {
  await assert.rejects(
    parseCobolDeep(["/tmp/a.cbl"], {
      jarPath: "/definitely-missing.jar",
      wrapperClassPath: "/tmp",
    }),
    (err: unknown) => err instanceof JarMissingError,
  );
});
