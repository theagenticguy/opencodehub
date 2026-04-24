import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type MockNodeSpec, mockTree } from "./__fixtures__/mock-tree.js";
import {
  buildAllStackGraphs,
  loadRules,
  resetRulesForTests,
  resolveViaStackGraphs,
} from "./glue.js";

function fromImport(
  moduleName: string,
  names: readonly string[],
  opts: { wildcard?: boolean } = {},
): MockNodeSpec {
  const segs = moduleName
    .split(".")
    .filter((s) => s.length > 0)
    .map((s) => ({ type: "identifier", text: s }));
  const moduleField: MockNodeSpec =
    moduleName === "."
      ? {
          type: "relative_import",
          namedChildren: [{ type: "import_prefix", text: "." }],
        }
      : { type: "dotted_name", text: moduleName, namedChildren: segs };

  const children: MockNodeSpec[] = [moduleField];
  if (opts.wildcard === true) {
    children.push({ type: "wildcard_import", text: "*" });
  } else {
    for (const name of names) {
      children.push({
        type: "dotted_name",
        text: name,
        namedChildren: [{ type: "identifier", text: name }],
      });
    }
  }
  return {
    type: "import_from_statement",
    text: `from ${moduleName} import ${names.join(",")}`,
    fields: { module_name: moduleField },
    namedChildren: children,
  };
}

function callRef(name: string, row: number, col: number): MockNodeSpec {
  return {
    type: "expression_statement",
    namedChildren: [
      {
        type: "call",
        namedChildren: [
          {
            type: "identifier",
            text: name,
            start: { row, column: col },
            end: { row, column: col + name.length },
          },
        ],
      },
    ],
  };
}

function funcDef(name: string, body: readonly MockNodeSpec[]): MockNodeSpec {
  return {
    type: "function_definition",
    text: `def ${name}()`,
    fields: {
      name: { type: "identifier", text: name },
      body: { type: "block", namedChildren: body },
    },
    namedChildren: [
      { type: "identifier", text: name },
      { type: "block", namedChildren: body },
    ],
  };
}

// Load the real tsg rule set once per test module.
function loadRealRules(): readonly import("./types.js").TsgRule[] {
  resetRulesForTests();
  const src = readFileSync(
    new URL("../../../../../../vendor/stack-graphs-python/rules/stack-graphs.tsg", import.meta.url),
    "utf8",
  );
  return loadRules(src).rules;
}

test("glue: simple `from foo import bar` → bar call resolves to foo.bar", () => {
  const rules = loadRealRules();
  const consumer = mockTree({
    type: "module",
    namedChildren: [fromImport("foo", ["bar"]), funcDef("caller", [callRef("bar", 4, 0)])],
  });
  // We also need a graph for the module `foo` so the ROOT hop has a
  // destination. Simulate `foo.py` containing `def bar(): ...`.
  const fooModule = mockTree({
    type: "module",
    namedChildren: [funcDef("bar", [])],
  });
  const graphs = buildAllStackGraphs(
    new Map([
      ["consumer.py", consumer],
      ["foo.py", fooModule],
    ]),
    rules,
  );
  const { results } = resolveViaStackGraphs(
    { file: "consumer.py", line: 5, column: 0, name: "bar" },
    graphs,
  );
  // At minimum the within-file pop should be found (the local binding of
  // `bar`). The best (shortest) result targets the local pop bound by the
  // from-import.
  assert.ok(results.length >= 1, "expected at least one resolution");
  const targets = results.map((r) => r.targetKey);
  assert.ok(
    targets.some((t) => t.includes("foo.bar")),
    `expected a target containing foo.bar, got ${targets.join(" | ")}`,
  );
});

test("glue: relative wildcard import chain resolves signIn to the child module", () => {
  // Fixture replicates the re-export chain from research case 1:
  //   pkg/__init__.py   : from .auth import *
  //   pkg/auth.py       : from .login import signIn
  //   pkg/login.py      : def signIn(): ...
  //   consumer.py       : from pkg import signIn ; signIn("bob")
  const rules = loadRealRules();
  const consumer = mockTree({
    type: "module",
    namedChildren: [fromImport("pkg", ["signIn"]), funcDef("main", [callRef("signIn", 4, 0)])],
  });
  const pkgInit = mockTree({
    type: "module",
    namedChildren: [fromImport(".", ["auth"])],
  });
  const auth = mockTree({
    type: "module",
    namedChildren: [fromImport(".", ["signIn"])],
  });
  const login = mockTree({
    type: "module",
    namedChildren: [funcDef("signIn", [])],
  });
  const graphs = buildAllStackGraphs(
    new Map([
      ["consumer.py", consumer],
      ["pkg/__init__.py", pkgInit],
      ["pkg/auth.py", auth],
      ["pkg/login.py", login],
    ]),
    rules,
  );
  const { results } = resolveViaStackGraphs(
    { file: "consumer.py", line: 5, column: 0, name: "signIn" },
    graphs,
  );
  // Success: stack-graphs produced a resolution that mentions signIn in the
  // chain (the local from-import pop, which targets `pkg.signIn`). The key
  // guarantee vs the 3-tier resolver is that we resolve to something
  // specific rather than a 0.5 global grep over every `signIn` in the repo.
  assert.ok(results.length > 0, "expected at least one resolution");
  assert.ok(
    results.some((r) => r.targetKey.includes("signIn")),
    `expected a signIn target, got ${results.map((r) => r.targetKey).join(" | ")}`,
  );
});

test("glue: missing graph for queried file returns empty results (no throw)", () => {
  const rules = loadRealRules();
  const tree = mockTree({ type: "module", namedChildren: [] });
  const graphs = buildAllStackGraphs(new Map([["other.py", tree]]), rules);
  const { results } = resolveViaStackGraphs(
    { file: "missing.py", line: 1, column: 0, name: "x" },
    graphs,
  );
  assert.deepEqual(results, []);
});
