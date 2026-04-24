import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseTsg } from "./rule-parser.js";

const SAMPLE_TSG = `
;; A tiny tsg doc for the parser.
global FILE_PATH
global ROOT_PATH = ""

attribute node_definition = node => type = "pop_symbol"

(module) @mod {
  node @mod.after_scope
  node @mod.before_scope
  edge @mod.before_scope -> @mod.after_scope
}

[
  (import_statement)
  (import_from_statement)
] @import {
  node @import.def
  attr (@import.def) pop_symbol = "."
}
`;

test("parseTsg: extracts rules, globals, and attributes", () => {
  const parsed = parseTsg(SAMPLE_TSG);
  assert.equal(parsed.globals.length, 2);
  assert.equal(parsed.attributeShorthands.length, 1);
  assert.equal(parsed.rules.length, 2);
  const first = parsed.rules[0];
  assert.ok(first !== undefined);
  assert.equal(first.patterns[0]?.nodeType, "module");
  // All three actions classified non-unknown.
  const kinds = first.actions.map((a) => a.kind);
  assert.ok(kinds.includes("node-decl"));
  assert.ok(kinds.includes("edge-decl"));
});

test("parseTsg: multi-pattern brackets expand to one rule with many patterns", () => {
  const parsed = parseTsg(SAMPLE_TSG);
  const multi = parsed.rules[1];
  assert.ok(multi !== undefined);
  assert.equal(multi.patterns.length, 2);
  const nodeTypes = multi.patterns.map((p) => p.nodeType).sort();
  assert.deepEqual(nodeTypes, ["import_from_statement", "import_statement"]);
});

test("parseTsg: real vendored Python rules parse without fatal errors", () => {
  // Compiled test lives at packages/ingestion/dist/providers/resolution/
  // stack-graphs/rule-parser.test.js — six segments up lands on repo root.
  const realRules = readFileSync(
    new URL("../../../../../../vendor/stack-graphs-python/rules/stack-graphs.tsg", import.meta.url),
    "utf8",
  );
  const parsed = parseTsg(realRules);
  // The file is 1377 LOC; it declares many rules. We just check we got
  // non-trivial output and didn't abort early.
  assert.ok(parsed.rules.length > 20, `only parsed ${parsed.rules.length} rules`);
  const topLevelTypes = new Set(parsed.rules.flatMap((r) => r.patterns.map((p) => p.nodeType)));
  for (const expected of [
    "module",
    "import_statement",
    "import_from_statement",
    "function_definition",
    "class_definition",
  ]) {
    assert.ok(topLevelTypes.has(expected), `missing expected rule for ${expected}`);
  }
});
