import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { classifyConventionalType, sortedHistogram } from "./conventional-commits.js";

describe("classifyConventionalType", () => {
  it("matches feat:", () => {
    assert.equal(classifyConventionalType("feat: add widget"), "feat");
  });

  it("matches fix(api):", () => {
    assert.equal(classifyConventionalType("fix(api): handle null"), "fix");
  });

  it("matches breaking feat!:", () => {
    assert.equal(classifyConventionalType("feat!: drop old API"), "feat");
  });

  it("matches scoped breaking feat(x)!:", () => {
    assert.equal(classifyConventionalType("feat(x)!: drop old API"), "feat");
  });

  it("is case-insensitive on the type token", () => {
    assert.equal(classifyConventionalType("FEAT: shouting"), "feat");
  });

  it("returns undefined on non-conforming subjects", () => {
    assert.equal(classifyConventionalType("add a thing"), undefined);
    assert.equal(classifyConventionalType('Revert "feat: x"'), undefined);
    assert.equal(classifyConventionalType("Merge branch 'main'"), undefined);
  });
});

describe("sortedHistogram", () => {
  it("produces keys in ascending order", () => {
    const src = new Map<string, number>([
      ["fix", 3],
      ["feat", 1],
      ["chore", 2],
    ]);
    const out = sortedHistogram(src);
    assert.deepEqual(Object.keys(out), ["chore", "feat", "fix"]);
    assert.equal(out["chore"], 2);
    assert.equal(out["feat"], 1);
    assert.equal(out["fix"], 3);
  });
});
