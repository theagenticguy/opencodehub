import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageProvider } from "../types.js";
import type { SymbolIndex } from "./context.js";
import { CONFIDENCE_BY_TIER, resolve } from "./context.js";

// Minimal provider stub. We avoid importing the real `typescriptProvider`
// here because that module transitively reaches the parse-phase → registry
// graph; during ESM initialisation that can race with sibling provider
// modules (see Stream O). The resolver only reads `provider.id`, so a stub
// exercises the same dispatch logic without the cycle risk.
const typescriptProvider: LanguageProvider = {
  id: "typescript",
  extensions: [".ts"],
  importSemantics: "named",
  mroStrategy: "first-wins",
  typeConfig: { structural: true, nominal: false, generics: true },
  heritageEdge: "EXTENDS",
  extractDefinitions: () => [],
  extractCalls: () => [],
  extractImports: () => [],
  isExported: () => false,
  extractHeritage: () => [],
};

function makeIndex(overrides: Partial<SymbolIndex> = {}): SymbolIndex {
  return {
    findInFile: () => undefined,
    findInImports: () => undefined,
    findGlobal: () => [],
    ...overrides,
  };
}

test("resolve: same-file hit returns a single 0.95 candidate", () => {
  const index = makeIndex({
    findInFile: (file, name) => (file === "a.ts" && name === "foo" ? "sym:a.ts#foo" : undefined),
    findInImports: () => "sym:other",
    findGlobal: () => ["sym:global1", "sym:global2"],
  });
  const out = resolve(
    { callerFile: "a.ts", calleeName: "foo", provider: typescriptProvider },
    index,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.targetId, "sym:a.ts#foo");
  assert.equal(out[0]?.tier, "same-file");
  assert.equal(out[0]?.confidence, CONFIDENCE_BY_TIER["same-file"]);
  assert.equal(out[0]?.confidence, 0.95);
});

test("resolve: import-scoped hit returns a single 0.9 candidate", () => {
  const index = makeIndex({
    findInImports: (file, name) =>
      file === "a.ts" && name === "bar" ? "sym:imported#bar" : undefined,
    findGlobal: () => ["sym:global1", "sym:global2"],
  });
  const out = resolve(
    { callerFile: "a.ts", calleeName: "bar", provider: typescriptProvider },
    index,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.targetId, "sym:imported#bar");
  assert.equal(out[0]?.tier, "import-scoped");
  assert.equal(out[0]?.confidence, 0.9);
});

test("resolve: global with two candidates returns two 0.5 results", () => {
  const index = makeIndex({
    findGlobal: (name) => (name === "baz" ? ["sym:pkg-a#baz", "sym:pkg-b#baz"] : []),
  });
  const out = resolve(
    { callerFile: "a.ts", calleeName: "baz", provider: typescriptProvider },
    index,
  );
  assert.equal(out.length, 2);
  for (const c of out) {
    assert.equal(c.tier, "global");
    assert.equal(c.confidence, 0.5);
  }
  const ids = out.map((c) => c.targetId).sort();
  assert.deepEqual(ids, ["sym:pkg-a#baz", "sym:pkg-b#baz"]);
});

test("resolve: no matches at any tier returns empty array", () => {
  const out = resolve(
    { callerFile: "a.ts", calleeName: "missing", provider: typescriptProvider },
    makeIndex(),
  );
  assert.deepEqual(out, []);
});
