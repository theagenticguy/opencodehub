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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCobolDeep } from "./parse.js";
import { JarMissingError, type RunOutcome } from "./subprocess.js";

const STUB_OPTS = { jarPath: "/unused.jar", wrapperClassPath: "/unused" };

// A tiny fixed-format COBOL fixture the regex fallback can parse.
const FIXTURE = [
  "000100 IDENTIFICATION DIVISION.",
  "000200 PROGRAM-ID. WORLD.",
  "000300 PROCEDURE DIVISION.",
  "000400 MAIN-PARA.",
  "000500     PERFORM SALUTE.",
  "000600 SALUTE.",
  "000700     DISPLAY 'WORLD'.",
].join("\n");

function writeFixture(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cobol-proleap-parse-"));
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

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

test("parseCobolDeep: a crashed batch salvages partial parse records and only re-parses uncovered files", async () => {
  const covered = writeFixture("covered.cbl", FIXTURE);
  const uncovered = writeFixture("uncovered.cbl", FIXTURE.replace(/WORLD/g, "HELLO"));

  // The JVM finished `covered` (emitting an authoritative program-id record)
  // and then timed out before reaching `uncovered`.
  const crashed: RunOutcome = {
    kind: "crashed",
    reason: "JVM subprocess timed out after 60000ms",
    partial: [{ kind: "program-id", name: "WORLD", filePath: covered, startLine: 2, endLine: 2 }],
  };

  const res = await parseCobolDeep([covered, uncovered], STUB_OPTS, async () => crashed);

  assert.equal(res.fellBackToRegex, true);

  // The salvaged record is preserved at "parse" confidence and NOT re-derived.
  const coveredEls = res.elements.filter((el) => el.filePath === covered);
  assert.ok(
    coveredEls.some((el) => el.kind === "program-id" && el.name === "WORLD"),
    "expected the salvaged WORLD program-id",
  );
  assert.ok(
    coveredEls.every((el) => el.confidence === "parse"),
    "covered file keeps authoritative parse confidence and is not re-parsed",
  );

  // The uncovered file is re-derived through the regex fallback.
  const uncoveredEls = res.elements.filter((el) => el.filePath === uncovered);
  assert.ok(
    uncoveredEls.some((el) => el.kind === "program-id" && el.name === "HELLO"),
    "expected the uncovered file to be regex-reparsed",
  );
  assert.ok(
    uncoveredEls.every((el) => el.confidence === "heuristic"),
    "uncovered file is downgraded to heuristic confidence",
  );

  assert.ok(
    res.diagnostics.some((d) => /salvaged 1 file\(s\)/.test(d)),
    "the crash note reports the salvage count",
  );
});

test("parseCobolDeep: a partial diagnostic falls back to regex for that path", async () => {
  const flagged = writeFixture("flagged.cbl", FIXTURE);
  const crashed: RunOutcome = {
    kind: "crashed",
    reason: "JVM exited 1. Stderr tail: boom",
    partial: [{ kind: "diagnostic", filePath: flagged, message: "ASG walker NPE" }],
  };

  const res = await parseCobolDeep([flagged], STUB_OPTS, async () => crashed);

  assert.equal(res.fellBackToRegex, true);
  // A diagnostic-only path is NOT treated as covered — it is regex-reparsed.
  assert.ok(
    res.elements.some((el) => el.kind === "program-id" && el.confidence === "heuristic"),
    "diagnostic path is re-derived via regex",
  );
  assert.ok(res.diagnostics.some((d) => /ASG crash on .*flagged\.cbl/.test(d)));
});
