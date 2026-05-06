/**
 * Tests for the regex fallback path. Exercises the pure-function surface:
 *   - fallbackParseFile() reparses a COBOL fixture and projects regex
 *     elements onto `CobolDeepElement` with confidence "heuristic".
 *   - fallbackParseFile() on a missing file returns an empty element list
 *     plus a read-failure note (never throws).
 *   - fallbackParseBatch() aggregates across multiple files.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fallbackParseBatch, fallbackParseFile } from "./fallback.js";

function writeFixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cobol-proleap-fallback-"));
  const path = join(dir, "fixture.cbl");
  writeFileSync(path, body, "utf8");
  return path;
}

// A tiny fixed-format COBOL fixture exercising PROGRAM-ID, a paragraph,
// and a PERFORM call-site. Columns 1-6 are sequence area; col 7 is the
// indicator area; Area A starts at col 8.
const FIXTURE = [
  "000100 IDENTIFICATION DIVISION.",
  "000200 PROGRAM-ID. HELLO.",
  "000300 PROCEDURE DIVISION.",
  "000400 MAIN-PARA.",
  "000500     PERFORM GREET.",
  "000600 GREET.",
  "000700     DISPLAY 'HELLO'.",
].join("\n");

test("fallbackParseFile: reparses a COBOL file via regex with heuristic confidence", async () => {
  const path = writeFixture(FIXTURE);
  const { elements, notes } = await fallbackParseFile(path);
  assert.ok(elements.length > 0, "expected at least one element");
  assert.ok(
    elements.every((el) => el.confidence === "heuristic"),
    "every element must be tagged heuristic",
  );
  assert.ok(
    elements.some((el) => el.kind === "program-id" && el.name === "HELLO"),
    "expected a PROGRAM-ID for HELLO",
  );
  assert.ok(
    elements.some((el) => el.kind === "perform" && el.name === "GREET"),
    "expected a PERFORM target GREET",
  );
  assert.equal(notes.length, 0, "fixture should produce no diagnostic notes");
});

test("fallbackParseFile: missing file returns empty elements + read-failure note", async () => {
  const { elements, notes } = await fallbackParseFile("/definitely-does-not-exist.cbl");
  assert.deepEqual([...elements], []);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /failed to read/);
});

test("fallbackParseBatch: aggregates elements across multiple files", async () => {
  const pathA = writeFixture(FIXTURE);
  const pathB = writeFixture(FIXTURE.replace("HELLO", "WORLD").replace("GREET", "SALUTE"));
  const { elements } = await fallbackParseBatch([pathA, pathB]);
  assert.ok(elements.some((el) => el.kind === "program-id" && el.name === "HELLO"));
  assert.ok(elements.some((el) => el.kind === "program-id" && el.name === "WORLD"));
});
