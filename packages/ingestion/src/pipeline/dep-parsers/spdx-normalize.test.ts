import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { spdxNormalize } from "./spdx-normalize.js";

describe("spdxNormalize", () => {
  it("canonicalises lowercased MIT to the SPDX id", () => {
    assert.equal(spdxNormalize("mit"), "MIT");
  });

  it("canonicalises 'Apache 2' to 'Apache-2.0'", () => {
    assert.equal(spdxNormalize("Apache 2"), "Apache-2.0");
  });

  it("returns undefined for the 'UNKNOWN' sentinel", () => {
    assert.equal(spdxNormalize("UNKNOWN"), undefined);
    assert.equal(spdxNormalize("unknown"), undefined);
  });

  it("returns undefined for empty / whitespace / nullish input", () => {
    assert.equal(spdxNormalize(""), undefined);
    assert.equal(spdxNormalize("   "), undefined);
    assert.equal(spdxNormalize(undefined), undefined);
    assert.equal(spdxNormalize(null), undefined);
  });

  it("passes through strings spdx-correct cannot normalise", () => {
    // A clearly-non-SPDX placeholder; spdx-correct returns null, we fall
    // back to the trimmed original so downstream classifiers can inspect
    // it without losing signal.
    const result = spdxNormalize("Custom-Internal-License-xyz");
    assert.equal(result, "Custom-Internal-License-xyz");
  });
});
