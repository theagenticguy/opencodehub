import assert from "node:assert/strict";
import { test } from "node:test";
import { firstWinsStrategy } from "./first-wins.js";

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
    memo.set(id, firstWinsStrategy.linearize(id, bases, lookup));
  }
  return memo;
}

test("first-wins: linear chain preserves order", () => {
  const table: ClassTable = {
    Object: [],
    C: ["Object"],
    B: ["C"],
    A: ["B"],
  };
  const mro = linearizeAll(["Object", "C", "B", "A"], table);
  assert.deepEqual(mro.get("A"), ["A", "B", "C", "Object"]);
});

test("first-wins: simple diamond dedupes by first occurrence", () => {
  // Same classes as the C3 diamond test; first-wins does not enforce
  // monotonicity, so its answer is a pre-order walk deduped on first hit.
  //   L[D] = [D, O]
  //   L[E] = [E, O]
  //   L[F] = [F, O]
  //   L[B] = [B] + L[D] + L[E] = [B, D, O, E, O] dedup -> [B, D, O, E]
  //   L[C] = [C] + L[D] + L[F] = [C, D, O, F, O] dedup -> [C, D, O, F]
  //   L[A] = [A] + L[B] + L[C] = [A, B, D, O, E, C, D, O, F]
  //                                dedup -> [A, B, D, O, E, C, F]
  // Note this is *not* monotonic (O precedes E and C in the walk) —
  // that's the documented trade-off of first-wins vs C3.
  const table: ClassTable = {
    O: [],
    F: ["O"],
    E: ["O"],
    D: ["O"],
    C: ["D", "F"],
    B: ["D", "E"],
    A: ["B", "C"],
  };
  const mro = linearizeAll(["O", "F", "E", "D", "C", "B", "A"], table);
  assert.deepEqual(mro.get("A"), ["A", "B", "D", "O", "E", "C", "F"]);
});
