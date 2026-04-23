import assert from "node:assert/strict";
import { test } from "node:test";
import { singleInheritanceStrategy } from "./single-inheritance.js";

type ClassTable = Readonly<Record<string, readonly string[]>>;

function linearizeAll(order: readonly string[], table: ClassTable): Map<string, readonly string[]> {
  const memo = new Map<string, readonly string[]>();
  const lookup = (id: string): readonly string[] => {
    const cached = memo.get(id);
    if (cached === undefined) throw new Error(`missing ${id}`);
    return cached;
  };
  for (const id of order) {
    const bases = table[id] ?? [];
    memo.set(id, singleInheritanceStrategy.linearize(id, bases, lookup));
  }
  return memo;
}

test("single-inheritance: linear chain", () => {
  const table: ClassTable = {
    Object: [],
    C: ["Object"],
    B: ["C"],
    A: ["B"],
  };
  const mro = linearizeAll(["Object", "C", "B", "A"], table);
  assert.deepEqual(mro.get("A"), ["A", "B", "C", "Object"]);
});

test("single-inheritance: rejects multi-inheritance", () => {
  assert.throws(() => {
    singleInheritanceStrategy.linearize("A", ["B", "C"], () => []);
  }, /single-inheritance strategy received 2 bases/);
});

test("single-inheritance: root class with no bases", () => {
  const mro = singleInheritanceStrategy.linearize("Root", [], () => {
    throw new Error("should not be called");
  });
  assert.deepEqual(mro, ["Root"]);
});
