import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deriveIndex } from "./derive.js";
import { parseScipIndex } from "./parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(): Uint8Array {
  const path = resolve(__dirname, "..", "tests", "fixtures", "calcpkg.scip");
  return readFileSync(path);
}

test("deriveIndex: produces function-level edges for the calcpkg fixture", () => {
  const idx = parseScipIndex(loadFixture());
  const derived = deriveIndex(idx);
  assert.ok(derived.edges.length > 0, "expected at least one derived edge");
  // Every edge must have function-like caller and callee (ends with `().`).
  for (const e of derived.edges) {
    assert.ok(e.caller.endsWith("()."), `non-function caller escaped the filter: ${e.caller}`);
  }
  // `add()` is the POC's leaf symbol — it should appear as a callee.
  const addCalls = derived.edges.filter((e) => e.callee.endsWith("/add()."));
  assert.ok(addCalls.length > 0, "add() should have incoming edges");
});
