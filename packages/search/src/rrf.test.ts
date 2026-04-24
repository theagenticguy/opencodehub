import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_RRF_K, DEFAULT_RRF_TOP_K, rrf } from "./rrf.js";

describe("rrf", () => {
  it("uses k=60 by default and sums 1/(k+rank) across runs", () => {
    const runA = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const runB = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const fused = rrf([runA, runB]);
    const k = DEFAULT_RRF_K;
    const byId = new Map(fused.map((f) => [f.id, f.score]));
    // a: 1/(k+1) + 1/(k+2); b: 1/(k+2) + 1/(k+3); c: 1/(k+3) + 1/(k+1)
    assert.ok(Math.abs((byId.get("a") ?? 0) - (1 / (k + 1) + 1 / (k + 2))) < 1e-12);
    assert.ok(Math.abs((byId.get("b") ?? 0) - (1 / (k + 2) + 1 / (k + 3))) < 1e-12);
    assert.ok(Math.abs((byId.get("c") ?? 0) - (1 / (k + 3) + 1 / (k + 1))) < 1e-12);
  });

  it("ranks items best-first", () => {
    const runA = [{ id: "a" }, { id: "b" }];
    const runB = [{ id: "a" }, { id: "b" }];
    const fused = rrf([runA, runB]);
    assert.equal(fused[0]?.id, "a");
    assert.equal(fused[1]?.id, "b");
  });

  it("handles items that appear in only one run", () => {
    const runA = [{ id: "a" }];
    const runB = [{ id: "b" }];
    const fused = rrf([runA, runB]);
    // Both contribute once at rank 1 — they tie on score.
    assert.equal(fused.length, 2);
    const ids = fused.map((f) => f.id).sort();
    assert.deepEqual(ids, ["a", "b"]);
  });

  it("breaks ties by first-run order (run index, then rank)", () => {
    // Two items at the same rank in different runs should prefer the
    // one that was introduced by the earlier run.
    const runA = [{ id: "x" }];
    const runB = [{ id: "y" }];
    const fused = rrf([runA, runB]);
    assert.equal(fused[0]?.id, "x", "x came from run 0, y from run 1");
    assert.equal(fused[1]?.id, "y");
  });

  it("breaks deeper ties by first-appearance rank", () => {
    // Same run index, different rank: rank 1 beats rank 2.
    const run = [{ id: "early" }, { id: "late" }];
    const fused = rrf([run]);
    assert.equal(fused[0]?.id, "early");
    assert.equal(fused[1]?.id, "late");
  });

  it("returns empty array for empty runs", () => {
    assert.deepEqual(rrf([]), []);
    assert.deepEqual(rrf([[]]), []);
    assert.deepEqual(rrf([[], []]), []);
  });

  it("respects topK", () => {
    const run = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}` }));
    const fused = rrf([run], DEFAULT_RRF_K, 3);
    assert.equal(fused.length, 3);
    assert.equal(fused[0]?.id, "n0");
  });

  it("defaults topK to 50", () => {
    const run = Array.from({ length: 75 }, (_, i) => ({ id: `n${i}` }));
    const fused = rrf([run]);
    assert.equal(fused.length, DEFAULT_RRF_TOP_K);
  });

  it("rejects non-positive k", () => {
    assert.throws(() => rrf([[{ id: "a" }]], 0));
    assert.throws(() => rrf([[{ id: "a" }]], -1));
  });

  it("accepts a single-run input (identity fusion)", () => {
    const run = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const fused = rrf([run]);
    assert.equal(fused.length, 3);
    assert.equal(fused[0]?.id, "a");
    assert.equal(fused[2]?.id, "c");
  });

  it("is deterministic for the same input across repeated calls", () => {
    const runA = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const runB = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const one = rrf([runA, runB]);
    const two = rrf([runA, runB]);
    assert.deepEqual(one, two);
  });
});
