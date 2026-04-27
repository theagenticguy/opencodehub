import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseScipIndex, SCIP_ROLE_DEFINITION } from "./parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): Uint8Array {
  // The fixture is under tests/fixtures relative to package root. When
  // compiled, dist/ mirrors src/ so the relative path is the same.
  const path = resolve(__dirname, "..", "tests", "fixtures", "calcpkg.scip");
  return readFileSync(path);
}

test("parseScipIndex: decodes the calcpkg fixture metadata", () => {
  const idx = parseScipIndex(loadFixture());
  assert.equal(idx.tool.name, "scip-python");
  assert.ok(idx.tool.version.length > 0, "tool version should be present");
  assert.ok(idx.projectRoot.length > 0, "project root URI should be present");
  assert.ok(idx.documents.length >= 5, `expected 5+ documents, got ${idx.documents.length}`);
});

test("parseScipIndex: documents include relative_path + language", () => {
  const idx = parseScipIndex(loadFixture());
  for (const doc of idx.documents) {
    assert.ok(doc.relativePath.length > 0);
    assert.ok(doc.occurrences.length > 0, `document ${doc.relativePath} has occurrences`);
  }
  // At least one occurrence should be flagged as a definition.
  const defs = idx.documents.flatMap((d) =>
    d.occurrences.filter((o) => (o.symbolRoles & SCIP_ROLE_DEFINITION) !== 0),
  );
  assert.ok(defs.length > 0, "calcpkg should have definition occurrences");
});

test("parseScipIndex: enclosing_range is populated for some definitions", () => {
  const idx = parseScipIndex(loadFixture());
  const withEnclosing = idx.documents.flatMap((d) =>
    d.occurrences.filter((o) => o.enclosingRange !== null),
  );
  assert.ok(withEnclosing.length > 0, "scip-python emits enclosing_range for function definitions");
});
