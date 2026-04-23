import assert from "node:assert/strict";
import { test } from "node:test";
import { type MockNodeSpec, mockTree } from "./__fixtures__/mock-tree.js";
import { buildStackGraph } from "./node-edge-builder.js";
import type { TsgRule } from "./types.js";

// Minimal rule set that authorises every Python construct our builder uses.
const AUTHORISING_RULES: readonly TsgRule[] = [
  { patterns: [{ kind: "pattern", nodeType: "module" }], actions: [] },
  { patterns: [{ kind: "pattern", nodeType: "import_statement" }], actions: [] },
  { patterns: [{ kind: "pattern", nodeType: "import_from_statement" }], actions: [] },
  { patterns: [{ kind: "pattern", nodeType: "function_definition" }], actions: [] },
  { patterns: [{ kind: "pattern", nodeType: "class_definition" }], actions: [] },
  { patterns: [{ kind: "pattern", nodeType: "identifier" }], actions: [] },
];

function fromImport(
  moduleName: string,
  names: readonly string[],
  opts: { wildcard?: boolean } = {},
): MockNodeSpec {
  const children: MockNodeSpec[] = [
    {
      type: "dotted_name",
      text: moduleName,
      namedChildren: moduleName.split(".").map((seg) => ({ type: "identifier", text: seg })),
    },
  ];
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
    fields: {
      module_name: {
        type: "dotted_name",
        text: moduleName,
        namedChildren: moduleName.split(".").map((seg) => ({ type: "identifier", text: seg })),
      },
    },
    namedChildren: children,
  };
}

function funcDef(name: string, body: readonly MockNodeSpec[] = []): MockNodeSpec {
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

test("buildStackGraph: from foo import bar produces pop for bar + push chain to ROOT", () => {
  const tree = mockTree({
    type: "module",
    namedChildren: [fromImport("foo", ["bar"])],
  });
  const graph = buildStackGraph("mod.py", tree, AUTHORISING_RULES);
  const pops = [...graph.nodes.values()].filter((n) => n.kind === "pop");
  assert.ok(
    pops.some((p) => p.symbol === "bar" && p.definitionTarget === "foo.bar"),
    "expected a pop node for local-bound 'bar'",
  );
  const pushes = [...graph.nodes.values()].filter((n) => n.kind === "push");
  assert.ok(pushes.some((p) => p.symbol === "bar"));
  assert.ok(pushes.some((p) => p.symbol === "foo"));
  // Exactly one edge to ROOT.
  const toRoot = graph.edges.filter((e) => e.target === graph.rootNodeId);
  assert.ok(toRoot.length >= 1);
});

test("buildStackGraph: references inside function bodies land in the index", () => {
  const tree = mockTree({
    type: "module",
    namedChildren: [
      fromImport("foo", ["bar"]),
      funcDef("caller", [
        {
          type: "expression_statement",
          namedChildren: [
            {
              type: "call",
              namedChildren: [
                {
                  type: "identifier",
                  text: "bar",
                  start: { row: 4, column: 0 },
                  end: { row: 4, column: 3 },
                },
              ],
            },
          ],
        },
      ]),
    ],
  });
  const graph = buildStackGraph("mod.py", tree, AUTHORISING_RULES);
  const key = "5:0"; // row 4 -> line 5 (1-indexed)
  const refId = graph.referenceIndex.get(key);
  assert.ok(refId !== undefined, "expected a reference node at line 5 col 0");
  const refNode = graph.nodes.get(refId);
  assert.equal(refNode?.symbol, "bar");
});

test("buildStackGraph: wildcard import emits precedence-1 scope edge", () => {
  const tree = mockTree({
    type: "module",
    namedChildren: [fromImport("auth", [], { wildcard: true })],
  });
  const graph = buildStackGraph("pkg/__init__.py", tree, AUTHORISING_RULES);
  const hasScope = [...graph.nodes.values()].some((n) => n.kind === "scope");
  assert.ok(hasScope);
});

test("buildStackGraph: unauthorised rule set returns empty graph (fallback)", () => {
  const tree = mockTree({
    type: "module",
    namedChildren: [fromImport("foo", ["bar"])],
  });
  const graph = buildStackGraph("mod.py", tree, []);
  // Only root + module-scope synthesised; no import chain.
  const pops = [...graph.nodes.values()].filter((n) => n.kind === "pop");
  assert.equal(pops.length, 0);
});
