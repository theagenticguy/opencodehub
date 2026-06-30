import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ByteSpan } from "./context-bom.js";
import {
  canonicalDecisionSet,
  type DecisionSet,
  decisionHash,
  decisionSetFromByteRanges,
  decisionSetFromChunks,
  diffDecisionSets,
} from "./decision-set.js";

const chunk = (path: string, startByte: number, endByte: number, tokenCount = 1) => ({
  path,
  startByte,
  endByte,
  tokenCount,
});

describe("decisionSetFromChunks", () => {
  it("groups by path, merges adjacent/overlapping spans, sorts paths", () => {
    const set = decisionSetFromChunks(
      [
        chunk("b.ts", 10, 20),
        chunk("a.ts", 0, 10),
        chunk("a.ts", 10, 25), // adjacent to [0,10) → merges to [0,25)
        chunk("b.ts", 0, 10),
      ],
      100,
    );
    assert.equal(set.budgetTokens, 100);
    assert.deepEqual(
      set.selections.map((s) => s.path),
      ["a.ts", "b.ts"],
      "paths sorted ASC",
    );
    assert.deepEqual(set.selections[0]?.ranges, [[0, 25]], "a.ts spans merged");
    assert.deepEqual(set.selections[1]?.ranges, [[0, 20]], "b.ts spans merged");
  });

  it("EXCLUDES tokenCount — a tokenCount-only drift is decision-equivalent", () => {
    const a = decisionSetFromChunks([chunk("a.ts", 0, 10, 3)], 100);
    const b = decisionSetFromChunks([chunk("a.ts", 0, 10, 999)], 100);
    assert.equal(decisionHash(a), decisionHash(b), "tokenCount not in the projection");
  });

  it("drops a path whose spans are all zero-length / inverted", () => {
    const set = decisionSetFromChunks([chunk("a.ts", 5, 5), chunk("a.ts", 9, 3)], 100);
    assert.equal(set.selections.length, 0, "no real ranges → not a selection");
  });
});

describe("decisionSetFromByteRanges (context-bom fallback)", () => {
  it("produces the same decision set as the equivalent chunks", () => {
    const fromChunks = decisionSetFromChunks([chunk("a.ts", 0, 10), chunk("a.ts", 10, 20)], 100);
    const ranges = new Map<string, ByteSpan[]>([["a.ts", [{ start: 0, end: 20 }]]]);
    const fromRanges = decisionSetFromByteRanges(ranges, 100);
    assert.equal(decisionHash(fromChunks), decisionHash(fromRanges));
  });
});

describe("decisionHash", () => {
  it("is stable across two calls (pure)", () => {
    const set = decisionSetFromChunks([chunk("a.ts", 0, 10)], 100);
    assert.equal(decisionHash(set), decisionHash(set));
  });

  it("differs when the selected byte ranges differ", () => {
    const a = decisionSetFromChunks([chunk("a.ts", 0, 10)], 100);
    const b = decisionSetFromChunks([chunk("a.ts", 0, 12)], 100);
    assert.notEqual(decisionHash(a), decisionHash(b));
  });

  it("differs when the budget differs (budget is part of the decision)", () => {
    const a = decisionSetFromChunks([chunk("a.ts", 0, 10)], 100);
    const b = decisionSetFromChunks([chunk("a.ts", 0, 10)], 200);
    assert.notEqual(decisionHash(a), decisionHash(b));
  });

  it("is independent of input chunk order (grouping is order-free)", () => {
    const a = decisionSetFromChunks([chunk("a.ts", 0, 5), chunk("b.ts", 0, 5)], 100);
    const b = decisionSetFromChunks([chunk("b.ts", 0, 5), chunk("a.ts", 0, 5)], 100);
    assert.equal(decisionHash(a), decisionHash(b));
  });
});

describe("canonicalDecisionSet", () => {
  it("serializes byte-identically for the same set", () => {
    const set: DecisionSet = {
      budgetTokens: 100,
      selections: [{ path: "a.ts", ranges: [[0, 10]] }],
    };
    assert.equal(canonicalDecisionSet(set), canonicalDecisionSet(set));
  });
});

describe("diffDecisionSets", () => {
  it("reports equivalent for identical sets", () => {
    const a = decisionSetFromChunks([chunk("a.ts", 0, 10)], 100);
    const b = decisionSetFromChunks([chunk("a.ts", 0, 10)], 100);
    const diff = diffDecisionSets(a, b);
    assert.equal(diff.equivalent, true);
    assert.equal(diff.onlyInA.length, 0);
    assert.equal(diff.onlyInB.length, 0);
    assert.equal(diff.rangeDeltas.length, 0);
  });

  it("names paths present in only one set", () => {
    const a = decisionSetFromChunks([chunk("a.ts", 0, 10), chunk("shared.ts", 0, 5)], 100);
    const b = decisionSetFromChunks([chunk("b.ts", 0, 10), chunk("shared.ts", 0, 5)], 100);
    const diff = diffDecisionSets(a, b);
    assert.equal(diff.equivalent, false);
    assert.deepEqual(diff.onlyInA, ["a.ts"]);
    assert.deepEqual(diff.onlyInB, ["b.ts"]);
    assert.equal(diff.rangeDeltas.length, 0, "shared.ts ranges match");
  });

  it("reports range deltas for a shared path whose ranges differ", () => {
    const a = decisionSetFromChunks([chunk("a.ts", 0, 10)], 100);
    const b = decisionSetFromChunks([chunk("a.ts", 0, 20)], 100);
    const diff = diffDecisionSets(a, b);
    assert.equal(diff.equivalent, false);
    assert.equal(diff.rangeDeltas.length, 1);
    assert.equal(diff.rangeDeltas[0]?.path, "a.ts");
    assert.deepEqual(diff.rangeDeltas[0]?.a, [[0, 10]]);
    assert.deepEqual(diff.rangeDeltas[0]?.b, [[0, 20]]);
  });
});
