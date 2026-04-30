import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSymbolDefIndex, deriveEdges, deriveIndex } from "./derive.js";
import {
  parseScipIndex,
  SCIP_ROLE_DEFINITION,
  type ScipDocument,
  type ScipIndex,
  type ScipOccurrence,
  type ScipRange,
} from "./parse.js";

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

function range(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
): ScipRange {
  return { startLine, startChar, endLine, endChar };
}

function defOcc(symbol: string, startLine: number, bodyEndLine: number): ScipOccurrence {
  return {
    symbol,
    symbolRoles: SCIP_ROLE_DEFINITION,
    range: range(startLine, 0, startLine, 10),
    enclosingRange: range(startLine, 0, bodyEndLine, 0),
  };
}

function refOcc(symbol: string, line: number, char: number): ScipOccurrence {
  return {
    symbol,
    symbolRoles: 0,
    range: range(line, char, line, char + 3),
    enclosingRange: null,
  };
}

function doc(relativePath: string, occurrences: ScipOccurrence[]): ScipDocument {
  return { relativePath, language: "typescript", occurrences, symbols: [] };
}

test("buildSymbolDefIndex: records each symbol's first DEFINITION site across documents", () => {
  const fooA = "scip-typescript npm pkg 1.0 src/a.ts/foo().";
  const fooB = "scip-typescript npm pkg 1.0 src/b.ts/foo().";
  const callerA = "scip-typescript npm pkg 1.0 src/a.ts/callerA().";

  const docA = doc("src/a.ts", [
    defOcc(callerA, 10, 30),
    defOcc(fooA, 50, 70),
    refOcc(fooB, 20, 4),
  ]);
  const docB = doc("src/b.ts", [defOcc(fooB, 5, 25)]);

  const index: ScipIndex = {
    tool: { name: "scip-typescript", version: "0.0.0" },
    projectRoot: "",
    documents: [docA, docB],
    externalSymbols: [],
  };

  const defs = buildSymbolDefIndex(index);

  const a = defs.get(fooA);
  const b = defs.get(fooB);
  assert.ok(a, "fooA must be in the def index");
  assert.ok(b, "fooB must be in the def index");
  assert.equal(a?.file, "src/a.ts");
  assert.equal(a?.line, 50);
  assert.equal(b?.file, "src/b.ts");
  assert.equal(b?.line, 5);

  const calleeEdges = deriveEdges(docA).filter((e) => e.callee === fooB);
  assert.equal(calleeEdges.length, 1, "callerA calls fooB exactly once");
  const resolved = defs.get(calleeEdges[0]!.callee);
  assert.equal(resolved?.file, "src/b.ts");
  assert.equal(resolved?.line, 5);
});

test("buildSymbolDefIndex: aliases a src-shape def under its dist-shape cross-package descriptor", () => {
  const srcSymbol = "scip-typescript npm @opencodehub/analysis 0.1.0 src/`verdict.ts`/computeVerdict().";
  const distSymbol =
    "scip-typescript npm @opencodehub/analysis 0.1.0 dist/`verdict.d.ts`/computeVerdict().";

  const analysisDoc = doc("packages/analysis/src/verdict.ts", [defOcc(srcSymbol, 42, 80)]);
  const consumerDoc = doc("packages/mcp/src/tools/verdict.ts", [refOcc(distSymbol, 12, 6)]);

  const index: ScipIndex = {
    tool: { name: "scip-typescript", version: "0.0.0" },
    projectRoot: "",
    documents: [analysisDoc, consumerDoc],
    externalSymbols: [],
  };

  const defs = buildSymbolDefIndex(index);

  const direct = defs.get(srcSymbol);
  const aliased = defs.get(distSymbol);
  assert.ok(direct, "src-shape key must resolve");
  assert.ok(aliased, "dist-shape alias must resolve");
  assert.equal(direct?.file, "packages/analysis/src/verdict.ts");
  assert.equal(direct?.line, 42);
  assert.equal(aliased?.file, "packages/analysis/src/verdict.ts");
  assert.equal(aliased?.line, 42);
});

test("buildSymbolDefIndex: dist alias preserves nested directory segments", () => {
  const srcSymbol =
    "scip-typescript npm @opencodehub/mcp 0.1.0 src/tools/`shared.ts`/toToolResult().";
  const distSymbol =
    "scip-typescript npm @opencodehub/mcp 0.1.0 dist/tools/`shared.d.ts`/toToolResult().";

  const d = doc("packages/mcp/src/tools/shared.ts", [defOcc(srcSymbol, 7, 40)]);

  const index: ScipIndex = {
    tool: { name: "scip-typescript", version: "0.0.0" },
    projectRoot: "",
    documents: [d],
    externalSymbols: [],
  };

  const defs = buildSymbolDefIndex(index);

  const direct = defs.get(srcSymbol);
  const aliased = defs.get(distSymbol);
  assert.ok(direct, "src-shape key must resolve");
  assert.ok(aliased, "nested dist-shape alias must resolve");
  assert.equal(aliased?.file, "packages/mcp/src/tools/shared.ts");
  assert.equal(aliased?.line, 7);
});

test("deriveEdges: attributes calls inside a nested local def to the enclosing non-local def", () => {
  const outer = "scip-typescript npm pkg 1.0 src/a.ts/registerFooTool().";
  const inner = "local 42";
  const callee = "scip-typescript npm pkg 1.0 src/b.ts/externalCallee().";

  const d = doc("src/a.ts", [
    defOcc(outer, 10, 30),
    defOcc(inner, 15, 25),
    refOcc(callee, 20, 4),
  ]);

  const edges = deriveEdges(d);
  assert.equal(edges.length, 1, "expected exactly one derived edge");
  assert.equal(edges[0]!.caller, outer);
  assert.equal(edges[0]!.callee, callee);
  assert.equal(edges[0]!.kind, "CALLS");
});
