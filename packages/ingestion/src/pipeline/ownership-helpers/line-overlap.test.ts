import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { LineOwner } from "./git-blame-batcher.js";
import { attributeFileOwnership, attributeSymbolOwnership } from "./line-overlap.js";

function mkLine(line: number, email: string, sha = "sha1"): LineOwner {
  return { line, email, authorName: email, sha };
}

describe("attributeSymbolOwnership", () => {
  it("returns empty on empty blame", () => {
    const out = attributeSymbolOwnership(1, 10, []);
    assert.deepEqual(out, []);
  });

  it("50/50 split across a ten-line range", () => {
    // Symbol spans lines 10-20 (11 lines). Contributor A claims 10-15 (6
    // lines); contributor B claims 16-20 (5 lines).
    const blame: LineOwner[] = [];
    for (let ln = 10; ln <= 15; ln += 1) blame.push(mkLine(ln, "a@example.com"));
    for (let ln = 16; ln <= 20; ln += 1) blame.push(mkLine(ln, "b@example.com"));
    const out = attributeSymbolOwnership(10, 20, blame);
    const a = out.find((w) => w.email === "a@example.com");
    const b = out.find((w) => w.email === "b@example.com");
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.lines, 6);
    assert.equal(b.lines, 5);
    // 6/11 and 5/11
    assert.ok(Math.abs(a.weight - 6 / 11) < 1e-9);
    assert.ok(Math.abs(b.weight - 5 / 11) < 1e-9);
    // Sorted descending by weight.
    assert.equal(out[0]?.email, "a@example.com");
  });

  it("symbol 10-20 with two halves gives weight 0.5 each when balanced", () => {
    const blame: LineOwner[] = [];
    for (let ln = 10; ln <= 14; ln += 1) blame.push(mkLine(ln, "a@example.com"));
    for (let ln = 16; ln <= 20; ln += 1) blame.push(mkLine(ln, "b@example.com"));
    // Line 15 intentionally missing — contributes to denominator only.
    const out = attributeSymbolOwnership(10, 20, blame);
    assert.equal(out.length, 2);
    const totalWeight = out.reduce((acc, w) => acc + w.weight, 0);
    assert.ok(totalWeight > 0.9 && totalWeight <= 1.0001);
  });

  it("ignores blame lines outside the range", () => {
    const blame: LineOwner[] = [mkLine(1, "outside@example.com"), mkLine(15, "inside@example.com")];
    const out = attributeSymbolOwnership(10, 20, blame);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.email, "inside@example.com");
  });
});

describe("attributeFileOwnership", () => {
  it("uses line 1 through maxLine as the range", () => {
    const blame: LineOwner[] = [
      mkLine(1, "a@example.com"),
      mkLine(2, "b@example.com"),
      mkLine(3, "a@example.com"),
    ];
    const out = attributeFileOwnership(blame);
    assert.equal(out.length, 2);
    const total = out.reduce((acc, w) => acc + w.weight, 0);
    assert.ok(Math.abs(total - 1.0) < 1e-9);
  });
});
