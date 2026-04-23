import assert from "node:assert/strict";
import { test } from "node:test";
import { c3Strategy, MroConflictError } from "./c3.js";

type ClassTable = Readonly<Record<string, readonly string[]>>;

/**
 * Compute linearizations for every class in `table` in topological order.
 * Each class's bases must be declared before the class itself. The root
 * sentinel (`Object`) has no bases and linearizes to `[Object]`.
 */
function linearizeAll(order: readonly string[], table: ClassTable): Map<string, readonly string[]> {
  const memo = new Map<string, readonly string[]>();
  const lookup = (id: string): readonly string[] => {
    const cached = memo.get(id);
    if (cached === undefined) {
      throw new Error(`Missing linearization for ${id}`);
    }
    return cached;
  };
  for (const id of order) {
    const bases = table[id] ?? [];
    memo.set(id, c3Strategy.linearize(id, bases, lookup));
  }
  return memo;
}

test("C3: linear chain A -> B -> C -> Object", () => {
  // Textbook case 1: linear inheritance chain.
  const table: ClassTable = {
    Object: [],
    C: ["Object"],
    B: ["C"],
    A: ["B"],
  };
  const mro = linearizeAll(["Object", "C", "B", "A"], table);
  assert.deepEqual(mro.get("A"), ["A", "B", "C", "Object"]);
});

test("C3: simple diamond from Python MRO HOWTO", () => {
  // Textbook case 2: O; F(O); E(O); D(O); C(D,F); B(D,E); A(B,C)
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
  assert.deepEqual(mro.get("A"), ["A", "B", "C", "D", "E", "F", "O"]);
});

test("C3: order-sensitive diamond with B(E,D)", () => {
  // Textbook case 3: same as diamond but B's bases are flipped to (E,D).
  const table: ClassTable = {
    O: [],
    F: ["O"],
    E: ["O"],
    D: ["O"],
    C: ["D", "F"],
    B: ["E", "D"],
    A: ["B", "C"],
  };
  const mro = linearizeAll(["O", "F", "E", "D", "C", "B", "A"], table);
  assert.deepEqual(mro.get("A"), ["A", "B", "E", "C", "D", "F", "O"]);
});

test("C3: Python 2.2 -> 2.3 monotonicity fix", () => {
  // Textbook case 4: K1(A,B,C); K2(D,B,E); K3(D,A); Z(K1,K2,K3)
  // The Simionato writeup explicitly calls out this case as the example that
  // Python 2.2's MRO got wrong and C3 (Python 2.3+) fixes.
  const table: ClassTable = {
    O: [],
    A: ["O"],
    B: ["O"],
    C: ["O"],
    D: ["O"],
    E: ["O"],
    K1: ["A", "B", "C"],
    K2: ["D", "B", "E"],
    K3: ["D", "A"],
    Z: ["K1", "K2", "K3"],
  };
  const mro = linearizeAll(["O", "A", "B", "C", "D", "E", "K1", "K2", "K3", "Z"], table);
  assert.deepEqual(mro.get("Z"), ["Z", "K1", "K2", "K3", "D", "A", "B", "C", "E", "O"]);
});

test("C3: irresolvable conflict throws MroConflictError", () => {
  // Textbook case 5: X(O); Y(O); A(X,Y); B(Y,X); Z(A,B)
  // CPython raises `TypeError: MRO conflict among bases Y, X` here.
  const table: ClassTable = {
    O: [],
    X: ["O"],
    Y: ["O"],
    A: ["X", "Y"],
    B: ["Y", "X"],
  };
  const memo = linearizeAll(["O", "X", "Y", "A", "B"], table);
  assert.throws(
    () => {
      c3Strategy.linearize("Z", ["A", "B"], (id) => {
        const cached = memo.get(id);
        if (cached === undefined) throw new Error(`missing ${id}`);
        return cached;
      });
    },
    (err: unknown) => err instanceof MroConflictError,
  );
});
