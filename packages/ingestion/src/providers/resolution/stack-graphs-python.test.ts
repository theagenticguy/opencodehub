import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageProvider } from "../types.js";
import type { SymbolIndex } from "./context.js";
import { getResolver, RESOLVER_STRATEGIES } from "./resolver-strategy.js";
import type { StackGraph } from "./stack-graphs/types.js";
import {
  clearStackGraphsForTests,
  registerStackGraphs,
  type StackGraphsHintedQuery,
  stackGraphsPythonResolver,
} from "./stack-graphs-python.js";

// Minimal provider-shaped stubs. We intentionally avoid importing the real
// `pythonProvider` / `typescriptProvider` constants here — those modules
// sit on top of a deep import graph (parse-phase, registry, extraction
// helpers) whose initialisation order can trip ES-module cycles when the
// providers add behavioural hooks (see/ ). The resolver
// reads `provider.id` only, so these stubs drive the same dispatch logic.
function pythonStub(): LanguageProvider {
  return {
    id: "python",
    extensions: [".py"],
    importSemantics: "namespace",
    mroStrategy: "c3",
    typeConfig: { structural: true, nominal: false, generics: true },
    heritageEdge: "EXTENDS",
    resolverStrategyName: "stack-graphs",
    extractDefinitions: () => [],
    extractCalls: () => [],
    extractImports: () => [],
    isExported: () => false,
    extractHeritage: () => [],
  };
}

function typescriptStub(): LanguageProvider {
  return {
    id: "typescript",
    extensions: [".ts"],
    importSemantics: "named",
    mroStrategy: "first-wins",
    typeConfig: { structural: true, nominal: false, generics: true },
    heritageEdge: "EXTENDS",
    resolverStrategyName: "stack-graphs",
    extractDefinitions: () => [],
    extractCalls: () => [],
    extractImports: () => [],
    isExported: () => false,
    extractHeritage: () => [],
  };
}

function makeIndex(overrides: Partial<SymbolIndex> = {}): SymbolIndex {
  return {
    findInFile: () => undefined,
    findInImports: () => undefined,
    findGlobal: () => [],
    ...overrides,
  };
}

test("getResolver: python provider maps to stack-graphs strategy", () => {
  const r = getResolver(pythonStub());
  assert.equal(r.name, "stack-graphs");
});

test("getResolver: typescript provider also maps to stack-graphs strategy (v2 router)", () => {
  // The router enrolls the TS family into the stack-graphs strategy.
  // The same public name dispatches internally by provider.id.
  const r = getResolver(typescriptStub());
  assert.equal(r.name, "stack-graphs");
});

test("getResolver: providers with no opt-in fall through to three-tier default", () => {
  const r = getResolver({ id: "go" });
  assert.equal(r.name, "three-tier-default");
});

test("registry exposes both strategies by name", () => {
  assert.ok(RESOLVER_STRATEGIES["three-tier-default"] !== undefined);
  assert.ok(RESOLVER_STRATEGIES["stack-graphs"] !== undefined);
});

test("stack-graphs strategy falls back to three-tier when no graphs registered", () => {
  clearStackGraphsForTests();
  const index = makeIndex({
    findInFile: (file, name) => (file === "a.py" && name === "foo" ? "sym:a.py#foo" : undefined),
  });
  const out = stackGraphsPythonResolver.resolve(
    { callerFile: "a.py", calleeName: "foo", provider: pythonStub() },
    index,
  );
  // Fallback path — three-tier returns the same-file hit at 0.95.
  assert.equal(out.length, 1);
  assert.equal(out[0]?.targetId, "sym:a.py#foo");
  assert.equal(out[0]?.confidence, 0.95);
});

test("stack-graphs strategy passes non-Python queries straight to three-tier", () => {
  clearStackGraphsForTests();
  const index = makeIndex({
    findInFile: (file, name) => (file === "a.ts" && name === "foo" ? "sym:a.ts#foo" : undefined),
  });
  const out = stackGraphsPythonResolver.resolve(
    { callerFile: "a.ts", calleeName: "foo", provider: typescriptStub() },
    index,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.tier, "same-file");
});

test("stack-graphs strategy emits hit at 0.9 confidence when graph resolves", () => {
  clearStackGraphsForTests();
  // Hand-roll a graph where a reference at (line 5, col 0) resolves to a
  // pop node with a definitionTarget.
  const file = "a.py";
  const graph: StackGraph = {
    file,
    rootNodeId: "root",
    nodes: new Map([
      ["root", { id: "root", kind: "root", file }],
      ["ref", { id: "ref", kind: "push", symbol: "bar", file }],
      [
        "def",
        {
          id: "def",
          kind: "pop",
          symbol: "bar",
          definitionTarget: "bar",
          file,
          line: 1,
        },
      ],
    ]),
    edges: [{ source: "ref", target: "def", precedence: 0 }],
    referenceIndex: new Map([["5:0", "ref"]]),
  };
  registerStackGraphs(new Map([[file, graph]]));
  const q: StackGraphsHintedQuery = {
    callerFile: file,
    calleeName: "bar",
    provider: pythonStub(),
    referenceLine: 5,
    referenceColumn: 0,
  };
  const out = stackGraphsPythonResolver.resolve(q, makeIndex());
  assert.equal(out.length, 1);
  assert.equal(out[0]?.confidence, 0.9);
  assert.equal(out[0]?.targetId, "a.py:1:bar");
  clearStackGraphsForTests();
});
