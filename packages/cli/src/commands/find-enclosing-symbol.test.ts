import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeId } from "@opencodehub/core-types";
import {
  ENCLOSING_SYMBOL_KINDS,
  findEnclosingSymbolId,
  indexNodesByFile,
  type NodeRow,
} from "./find-enclosing-symbol.js";

function row(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  kind: NodeRow["kind"],
): NodeRow {
  return { id: id as NodeId, filePath, startLine, endLine, kind };
}

test("findEnclosingSymbolId returns the only enclosing symbol when unambiguous", () => {
  const idx = indexNodesByFile([row("Function:a.ts:foo", "a.ts", 10, 30, "Function")]);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 15), "Function:a.ts:foo");
});

test("findEnclosingSymbolId picks the tightest span for nested symbols", () => {
  // Class(1-50) wraps Method(20-40) wraps ... line 25.
  const idx = indexNodesByFile([
    row("Class:a.ts:Foo", "a.ts", 1, 50, "Class"),
    row("Method:a.ts:Foo.bar", "a.ts", 20, 40, "Method"),
  ]);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 25), "Method:a.ts:Foo.bar");
});

test("findEnclosingSymbolId tie-breaks by first-seen when spans are equal", () => {
  // Two identical spans — deterministic order after sort puts the first
  // row encountered during index insertion ahead when startLine/endLine
  // match exactly.
  const idx = indexNodesByFile([
    row("Function:a.ts:foo", "a.ts", 5, 10, "Function"),
    row("Function:a.ts:bar", "a.ts", 5, 10, "Function"),
  ]);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 7), "Function:a.ts:foo");
});

test("findEnclosingSymbolId handles boundary lines inclusively", () => {
  const idx = indexNodesByFile([row("Function:a.ts:foo", "a.ts", 10, 30, "Function")]);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 10), "Function:a.ts:foo");
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 30), "Function:a.ts:foo");
});

test("findEnclosingSymbolId returns undefined for out-of-range lines", () => {
  const idx = indexNodesByFile([row("Function:a.ts:foo", "a.ts", 10, 30, "Function")]);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 9), undefined);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 31), undefined);
});

test("findEnclosingSymbolId returns undefined for unknown files", () => {
  const idx = indexNodesByFile([row("Function:a.ts:foo", "a.ts", 10, 30, "Function")]);
  assert.equal(findEnclosingSymbolId(idx, "b.ts", 15), undefined);
});

test("indexNodesByFile filters out disallowed kinds", () => {
  const idx = indexNodesByFile([
    row("File:a.ts:a.ts", "a.ts", 1, 100, "File"),
    row("Variable:a.ts:x", "a.ts", 5, 5, "Variable"),
    row("Function:a.ts:foo", "a.ts", 10, 30, "Function"),
  ]);
  // Only the Function row survives; a line inside the Variable span
  // resolves to the Function (since it also encloses that line).
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 5), undefined);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 15), "Function:a.ts:foo");
});

test("indexNodesByFile accepts every kind in the allow set", () => {
  // Sanity: every declared kind survives the filter and can be found.
  const kinds: NodeRow["kind"][] = [
    "Function",
    "Method",
    "Constructor",
    "Class",
    "Interface",
    "Struct",
    "Enum",
    "Trait",
  ];
  const rows = kinds.map((k, i) =>
    row(`${k}:a.ts:${k.toLowerCase()}`, "a.ts", i * 10 + 1, i * 10 + 5, k),
  );
  const idx = indexNodesByFile(rows);
  for (let i = 0; i < kinds.length; i += 1) {
    const expected = `${kinds[i]}:a.ts:${(kinds[i] as string).toLowerCase()}`;
    assert.equal(findEnclosingSymbolId(idx, "a.ts", i * 10 + 3), expected);
  }
  assert.equal(ENCLOSING_SYMBOL_KINDS.size, kinds.length);
});

test("findEnclosingSymbolId short-circuits once startLine passes the target", () => {
  // Two non-overlapping functions on the same file. A line before the
  // first one must resolve to undefined without matching the second.
  const idx = indexNodesByFile([
    row("Function:a.ts:foo", "a.ts", 10, 30, "Function"),
    row("Function:a.ts:bar", "a.ts", 50, 70, "Function"),
  ]);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 5), undefined);
  assert.equal(findEnclosingSymbolId(idx, "a.ts", 60), "Function:a.ts:bar");
});
