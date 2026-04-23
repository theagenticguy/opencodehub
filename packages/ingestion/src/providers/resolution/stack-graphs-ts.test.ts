import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageProvider } from "../types.js";
import type { SymbolIndex } from "./context.js";
import { getResolver, RESOLVER_STRATEGIES } from "./resolver-strategy.js";
import type { StackGraph } from "./stack-graphs/types.js";
import {
  buildTsStackGraph,
  clearTsStackGraphsForTests,
  registerTsStackGraphs,
  stackGraphsTsResolver,
  type TsModuleFacts,
  type TsStackGraphsHintedQuery,
} from "./stack-graphs-ts.js";

// Minimal provider-shaped stubs. We intentionally avoid importing the real
// `typescriptProvider` / `tsxProvider` / `javascriptProvider` constants here
// — those modules sit on top of a multi-hop import graph (parse-phase,
// registry, extraction helpers) that can produce ESM initialisation cycles
// in other in-flight streams. The resolver only reads `provider.id`, so a
// tagged stub exercises the same dispatch logic with zero coupling.
function providerStub(
  id: LanguageProvider["id"],
): Pick<LanguageProvider, "id"> & { readonly resolverStrategyName?: string } {
  return { id, resolverStrategyName: "stack-graphs" };
}

const TS_PROVIDER: LanguageProvider = {
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

function makeIndex(overrides: Partial<SymbolIndex> = {}): SymbolIndex {
  return {
    findInFile: () => undefined,
    findInImports: () => undefined,
    findGlobal: () => [],
    ...overrides,
  };
}

function makeResolveModule(
  mapping: Readonly<Record<string, string>>,
): (spec: string) => string | null {
  return (spec) => (Object.hasOwn(mapping, spec) ? (mapping[spec] as string) : null);
}

// ---------------------------------------------------------------------------
// Registry / provider wiring
// ---------------------------------------------------------------------------

test("RESOLVER_STRATEGIES exposes the stack-graphs router", () => {
  assert.ok(RESOLVER_STRATEGIES["stack-graphs"] !== undefined);
  assert.equal(RESOLVER_STRATEGIES["stack-graphs"]?.name, "stack-graphs");
});

test("typescript/tsx/javascript provider stubs opt in to stack-graphs", () => {
  for (const id of ["typescript", "tsx", "javascript"] as const) {
    const r = getResolver(providerStub(id));
    assert.equal(r.name, "stack-graphs", `provider ${id} should opt in`);
  }
});

test("providers with no opt-in fall back to three-tier default", () => {
  const r = getResolver({ id: "go" });
  assert.equal(r.name, "three-tier-default");
});

// ---------------------------------------------------------------------------
// Strategy fall-back semantics
// ---------------------------------------------------------------------------

test("stack-graphs TS strategy falls back to three-tier when no graphs registered", () => {
  clearTsStackGraphsForTests();
  const index = makeIndex({
    findInFile: (file, name) =>
      file === "consumer.ts" && name === "signIn" ? "sym:consumer.ts#signIn" : undefined,
  });
  const out = stackGraphsTsResolver.resolve(
    { callerFile: "consumer.ts", calleeName: "signIn", provider: TS_PROVIDER },
    index,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.targetId, "sym:consumer.ts#signIn");
  assert.equal(out[0]?.confidence, 0.95);
});

test("stack-graphs TS strategy passes non-TS-family queries straight through", () => {
  clearTsStackGraphsForTests();
  const index = makeIndex({
    findInFile: (file, name) =>
      file === "mod.py" && name === "foo" ? "sym:mod.py#foo" : undefined,
  });
  // Passing a non-TS id (e.g. python) — TS resolver should defer to three-tier.
  const out = stackGraphsTsResolver.resolve(
    {
      callerFile: "mod.py",
      calleeName: "foo",
      provider: { ...TS_PROVIDER, id: "python" },
    },
    index,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.tier, "same-file");
});

test("stack-graphs TS strategy: unresolved reference falls back to three-tier globals", () => {
  clearTsStackGraphsForTests();
  // Register an empty graph for consumer so the backend runs but finds no
  // reference at the queried position.
  const consumerFacts: TsModuleFacts = {
    file: "consumer.ts",
    moduleKey: "consumer",
    imports: [],
    exports: [],
    localDefinitions: [],
    references: [],
    resolveModule: () => null,
  };
  const graphs = new Map<string, StackGraph>([["consumer.ts", buildTsStackGraph(consumerFacts)]]);
  registerTsStackGraphs(graphs);

  const index = makeIndex({
    findGlobal: (name) => (name === "orphan" ? ["sym:somewhere#orphan"] : []),
  });
  const q: TsStackGraphsHintedQuery = {
    callerFile: "consumer.ts",
    calleeName: "orphan",
    provider: TS_PROVIDER,
    referenceLine: 99,
    referenceColumn: 0,
  };
  const out = stackGraphsTsResolver.resolve(q, index);
  // Three-tier fallback → global tier at 0.5.
  assert.equal(out.length, 1);
  assert.equal(out[0]?.confidence, 0.5);
  clearTsStackGraphsForTests();
});

// ---------------------------------------------------------------------------
// Builder + engine: named import, default, namespace, re-exports.
// ---------------------------------------------------------------------------

function buildAndRegister(modules: readonly TsModuleFacts[]): Map<string, StackGraph> {
  const graphs = new Map<string, StackGraph>();
  for (const m of modules) graphs.set(m.file, buildTsStackGraph(m));
  registerTsStackGraphs(graphs);
  return graphs;
}

test("named import: consumer resolves signIn at 0.9 confidence via stack-graphs", () => {
  clearTsStackGraphsForTests();
  const target: TsModuleFacts = {
    file: "simple-import-target.ts",
    moduleKey: "simple-import-target",
    imports: [],
    exports: [{ kind: "named-local", name: "signIn", line: 1 }],
    localDefinitions: [{ name: "signIn", line: 1 }],
    references: [],
    resolveModule: () => null,
  };
  const consumer: TsModuleFacts = {
    file: "simple-import.ts",
    moduleKey: "simple-import",
    imports: [
      {
        kind: "named",
        name: "signIn",
        local: "signIn",
        module: "./simple-import-target",
        line: 1,
      },
    ],
    exports: [],
    localDefinitions: [{ name: "main", line: 3 }],
    references: [{ name: "signIn", line: 4, column: 2 }],
    resolveModule: makeResolveModule({
      "./simple-import-target": "simple-import-target",
    }),
  };
  buildAndRegister([target, consumer]);

  const q: TsStackGraphsHintedQuery = {
    callerFile: "simple-import.ts",
    calleeName: "signIn",
    provider: TS_PROVIDER,
    referenceLine: 4,
    referenceColumn: 2,
  };
  const out = stackGraphsTsResolver.resolve(q, makeIndex());
  assert.equal(out.length, 1);
  assert.equal(out[0]?.confidence, 0.9);
  assert.ok(
    out[0]?.targetId.includes("signIn"),
    `expected targetId to include signIn, got ${out[0]?.targetId}`,
  );
  clearTsStackGraphsForTests();
});

test("barrel re-export: consumer → index → auth/signIn resolves at 0.9 (beats 0.5 global fallback)", () => {
  clearTsStackGraphsForTests();
  const signInMod: TsModuleFacts = {
    file: "auth/signIn.ts",
    moduleKey: "auth/signIn",
    imports: [],
    exports: [{ kind: "named-local", name: "signIn", line: 1 }],
    localDefinitions: [{ name: "signIn", line: 1 }],
    references: [],
    resolveModule: () => null,
  };
  const indexMod: TsModuleFacts = {
    file: "barrel/index.ts",
    moduleKey: "barrel/index",
    imports: [],
    exports: [
      {
        kind: "named-reexport",
        name: "signIn",
        imported: "signIn",
        module: "./auth/signIn",
        line: 1,
      },
    ],
    localDefinitions: [],
    references: [],
    resolveModule: makeResolveModule({ "./auth/signIn": "auth/signIn" }),
  };
  const consumer: TsModuleFacts = {
    file: "consumer.ts",
    moduleKey: "consumer",
    imports: [
      {
        kind: "named",
        name: "signIn",
        local: "signIn",
        module: "./barrel",
        line: 1,
      },
    ],
    exports: [],
    localDefinitions: [{ name: "main", line: 3 }],
    references: [{ name: "signIn", line: 4, column: 2 }],
    resolveModule: makeResolveModule({ "./barrel": "barrel/index" }),
  };
  buildAndRegister([signInMod, indexMod, consumer]);

  const q: TsStackGraphsHintedQuery = {
    callerFile: "consumer.ts",
    calleeName: "signIn",
    provider: TS_PROVIDER,
    referenceLine: 4,
    referenceColumn: 2,
  };
  const out = stackGraphsTsResolver.resolve(q, makeIndex());
  assert.equal(out.length, 1, "expected a stack-graphs hit, not fallback");
  assert.equal(out[0]?.confidence, 0.9, "barrel chain should score 0.9, not 0.5 global");
  clearTsStackGraphsForTests();
});

test("star re-export: export * from './user' lets consumer resolve createUser", () => {
  clearTsStackGraphsForTests();
  const userMod: TsModuleFacts = {
    file: "user.ts",
    moduleKey: "user",
    imports: [],
    exports: [{ kind: "named-local", name: "createUser", line: 1 }],
    localDefinitions: [{ name: "createUser", line: 1 }],
    references: [],
    resolveModule: () => null,
  };
  const indexMod: TsModuleFacts = {
    file: "barrel-star/index.ts",
    moduleKey: "barrel-star/index",
    imports: [],
    exports: [{ kind: "star-reexport", module: "./user", line: 1 }],
    localDefinitions: [],
    references: [],
    resolveModule: makeResolveModule({ "./user": "user" }),
  };
  const consumer: TsModuleFacts = {
    file: "consumer.ts",
    moduleKey: "consumer",
    imports: [
      {
        kind: "named",
        name: "createUser",
        local: "createUser",
        module: "./barrel-star",
        line: 1,
      },
    ],
    exports: [],
    localDefinitions: [{ name: "main", line: 3 }],
    references: [{ name: "createUser", line: 4, column: 2 }],
    resolveModule: makeResolveModule({ "./barrel-star": "barrel-star/index" }),
  };
  buildAndRegister([userMod, indexMod, consumer]);

  const q: TsStackGraphsHintedQuery = {
    callerFile: "consumer.ts",
    calleeName: "createUser",
    provider: TS_PROVIDER,
    referenceLine: 4,
    referenceColumn: 2,
  };
  const out = stackGraphsTsResolver.resolve(q, makeIndex());
  assert.equal(out.length, 1);
  assert.equal(out[0]?.confidence, 0.9);
  clearTsStackGraphsForTests();
});

test('default export: consumer `import foo from "./m"` resolves via default slot', () => {
  clearTsStackGraphsForTests();
  const target: TsModuleFacts = {
    file: "default-export.ts",
    moduleKey: "default-export",
    imports: [],
    exports: [{ kind: "default-local", target: "foo", line: 1 }],
    localDefinitions: [{ name: "foo", line: 1 }],
    references: [],
    resolveModule: () => null,
  };
  const consumer: TsModuleFacts = {
    file: "default-export-consumer.ts",
    moduleKey: "default-export-consumer",
    imports: [{ kind: "default", local: "foo", module: "./default-export", line: 1 }],
    exports: [],
    localDefinitions: [{ name: "main", line: 3 }],
    references: [{ name: "foo", line: 4, column: 9 }],
    resolveModule: makeResolveModule({ "./default-export": "default-export" }),
  };
  buildAndRegister([target, consumer]);

  const q: TsStackGraphsHintedQuery = {
    callerFile: "default-export-consumer.ts",
    calleeName: "foo",
    provider: TS_PROVIDER,
    referenceLine: 4,
    referenceColumn: 9,
  };
  const out = stackGraphsTsResolver.resolve(q, makeIndex());
  assert.equal(out.length, 1);
  assert.equal(out[0]?.confidence, 0.9);
  // The resolution terminates at the local import pop; its definitionTarget
  // advertises the "default" slot of the remote module.
  assert.ok(
    out[0]?.targetId.includes("default"),
    `expected targetId to reference default slot, got ${out[0]?.targetId}`,
  );
  clearTsStackGraphsForTests();
});

test("namespace import: import * as ns resolves ns reference to remote wildcard slot", () => {
  clearTsStackGraphsForTests();
  const target: TsModuleFacts = {
    file: "ns-target.ts",
    moduleKey: "ns-target",
    imports: [],
    exports: [{ kind: "named-local", name: "greet", line: 1 }],
    localDefinitions: [{ name: "greet", line: 1 }],
    references: [],
    resolveModule: () => null,
  };
  const consumer: TsModuleFacts = {
    file: "ns-consumer.ts",
    moduleKey: "ns-consumer",
    imports: [{ kind: "namespace", local: "ns", module: "./ns-target", line: 1 }],
    exports: [],
    localDefinitions: [{ name: "main", line: 3 }],
    references: [{ name: "ns", line: 4, column: 2 }],
    resolveModule: makeResolveModule({ "./ns-target": "ns-target" }),
  };
  buildAndRegister([target, consumer]);

  const q: TsStackGraphsHintedQuery = {
    callerFile: "ns-consumer.ts",
    calleeName: "ns",
    provider: TS_PROVIDER,
    referenceLine: 4,
    referenceColumn: 2,
  };
  const out = stackGraphsTsResolver.resolve(q, makeIndex());
  assert.equal(out.length, 1);
  assert.equal(out[0]?.confidence, 0.9);
  assert.ok(
    out[0]?.targetId.includes("ns-target"),
    `expected targetId to reference ns-target, got ${out[0]?.targetId}`,
  );
  clearTsStackGraphsForTests();
});
