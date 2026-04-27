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

test("materialize: blast ranking matches POC — add() leads", () => {
  const idx = parseScipIndex(loadFixture());
  const derived = deriveIndex(idx);
  const result = materialize(derived.edges);
  assert.ok(result.nodes.length > 0);

  const ranked = [...result.metrics.values()].sort((a, b) => b.blastScore - a.blastScore);
  const leader = ranked[0];
  assert.ok(leader, "expected a blast leader");
  assert.ok(
    leader.symbol.endsWith("/add()."),
    `POC expects add() as top blast symbol; got ${leader.symbol}`,
  );
  assert.ok(leader.bwdReach > 0, "add() should have backward reach");
});

test("materialize: reach closures are non-empty for non-trivial graphs", () => {
  const idx = parseScipIndex(loadFixture());
  const derived = deriveIndex(idx);
  const result = materialize(derived.edges);
  assert.ok(result.reachForward.length > 0);
  assert.ok(result.reachBackward.length > 0);
  assert.equal(result.reachForward.length, result.reachBackward.length);
});
