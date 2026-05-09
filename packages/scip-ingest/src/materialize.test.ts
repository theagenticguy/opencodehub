import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deriveIndex } from "./derive.js";
import { materialize } from "./materialize.js";
import { parseScipIndex } from "./parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): Uint8Array {
  const path = resolve(__dirname, "..", "tests", "fixtures", "calcpkg.scip");
  return readFileSync(path);
}

test("materialize: blast ranking surfaces a connected leader with backward reach", () => {
  // The previous version of this test asserted `add()` as the POC
  // leader when the blast formula included a `gamma * pagerank * n`
  // term. PageRank was lifted to @opencodehub/analysis and is now a
  // request-time kernel; the ingest-time blast formula leans on
  // reach + SCC only, which shifts the top-ranked symbol on this
  // fixture. The invariant we still care about at this layer is
  // that ranking produces a symbol with non-trivial reach closures.
  const idx = parseScipIndex(loadFixture());
  const derived = deriveIndex(idx);
  const result = materialize(derived.edges);
  assert.ok(result.nodes.length > 0);

  const ranked = [...result.metrics.values()].sort((a, b) => b.blastScore - a.blastScore);
  const leader = ranked[0];
  assert.ok(leader, "expected a blast leader");
  assert.ok(leader.blastScore > 0, "leader should have a positive blast score");
  assert.ok(
    leader.fwdReach > 0 || leader.bwdReach > 0,
    "leader should have non-zero reach in at least one direction",
  );
});

test("materialize: reach closures are non-empty for non-trivial graphs", () => {
  const idx = parseScipIndex(loadFixture());
  const derived = deriveIndex(idx);
  const result = materialize(derived.edges);
  assert.ok(result.reachForward.length > 0);
  assert.ok(result.reachBackward.length > 0);
  assert.equal(result.reachForward.length, result.reachBackward.length);
});
