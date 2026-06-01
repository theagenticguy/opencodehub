import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Guards the README against drift back to the fictional surface it once
 * documented: a single object argument with a `query` key and an `alpha`
 * fusion weight, plus a "grouped by process/community cluster" claim. The
 * shipped surface is positional `hybridSearch(store, { text, ... }, embedder?)`
 * with pure RRF fusion and no alpha.
 */
const readmePath = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const readme = readFileSync(readmePath, "utf8");

describe("README surface", () => {
  it("documents the query object with `text`, not a `query` key", () => {
    assert.match(readme, /text:\s*"authentication middleware"/);
  });

  it("does not document a non-existent `alpha` fusion weight", () => {
    // No `alpha:` field in any code example, and no "0 = BM25, 1 = vector"
    // weight semantics — fusion is pure RRF.
    assert.doesNotMatch(readme, /alpha\s*:/);
    assert.doesNotMatch(readme, /0\s*=\s*BM25/i);
  });

  it("does not claim results are grouped by process/community cluster", () => {
    assert.doesNotMatch(readme, /grouped by process/i);
  });

  it("documents the positional embedder argument and RRF fusion", () => {
    assert.match(readme, /Reciprocal Rank Fusion/);
    assert.match(readme, /omit for BM25-only/);
  });
});
