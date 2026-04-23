import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolutionCandidate } from "./context.js";
import { filterByPythonAll, parsePythonAll } from "./python-all-filter.js";

test("parsePythonAll: extracts names from a list literal", () => {
  const source = `\n__all__ = ["alpha", 'beta', "gamma"]\n`;
  assert.deepEqual(parsePythonAll(source), ["alpha", "beta", "gamma"]);
});

test("parsePythonAll: extracts names from a tuple literal", () => {
  const source = `__all__ = ('alpha', 'beta')`;
  assert.deepEqual(parsePythonAll(source), ["alpha", "beta"]);
});

test("parsePythonAll: returns null when no __all__ declared", () => {
  assert.equal(parsePythonAll(`x = 1`), null);
});

test("filterByPythonAll: drops candidates not listed in __all__", () => {
  const tmp = mkdtempSync(join(tmpdir(), "all-filter-"));
  const initPath = join(tmp, "__init__.py");
  writeFileSync(
    initPath,
    `__all__ = ["public_func"]\n\ndef _helper(): pass\ndef public_func(): pass\n`,
  );

  const candidates: readonly ResolutionCandidate[] = [
    { targetId: "x", tier: "import-scoped", confidence: 0.9 },
  ];
  const kept = filterByPythonAll(candidates, initPath, "public_func");
  assert.equal(kept.length, 1);
  const dropped = filterByPythonAll(candidates, initPath, "_helper");
  assert.equal(dropped.length, 0);
});

test("filterByPythonAll: passes candidates through when __all__ absent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "all-filter-"));
  const initPath = join(tmp, "__init__.py");
  writeFileSync(initPath, `def _helper(): pass\n`);
  const candidates: readonly ResolutionCandidate[] = [
    { targetId: "x", tier: "import-scoped", confidence: 0.9 },
  ];
  const kept = filterByPythonAll(candidates, initPath, "_helper");
  assert.equal(kept.length, 1);
});

test("filterByPythonAll: passes through when target file can't be read", () => {
  const candidates: readonly ResolutionCandidate[] = [
    { targetId: "x", tier: "import-scoped", confidence: 0.9 },
  ];
  const kept = filterByPythonAll(candidates, "/nonexistent/path/__init__.py", "anything");
  assert.equal(kept.length, 1);
});
