import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeRelation } from "./edges.js";
import { KnowledgeGraph } from "./graph.js";
import { graphHash } from "./graph-hash.js";
import { makeNodeId } from "./id.js";
import type { GraphNode } from "./nodes.js";

function buildFixtures(): { nodes: GraphNode[]; edges: Omit<CodeRelation, "id">[] } {
  const fileA = makeNodeId("File", "src/a.ts", "src/a.ts");
  const fileB = makeNodeId("File", "src/b.ts", "src/b.ts");
  const fnF = makeNodeId("Function", "src/a.ts", "f", { parameterCount: 0 });
  const fnG = makeNodeId("Function", "src/b.ts", "g", { parameterCount: 1 });
  const cls = makeNodeId("Class", "src/a.ts", "Foo");
  const mtBar = makeNodeId("Method", "src/a.ts", "Foo.bar", { parameterCount: 2 });
  const procP = makeNodeId("Process", "src/a.ts", "Process:proc1");
  const nodes: GraphNode[] = [
    {
      id: fileA,
      kind: "File",
      name: "a.ts",
      filePath: "src/a.ts",
      language: "typescript",
    },
    {
      id: fileB,
      kind: "File",
      name: "b.ts",
      filePath: "src/b.ts",
      language: "typescript",
    },
    {
      id: fnF,
      kind: "Function",
      name: "f",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 10,
      parameterCount: 0,
      isExported: true,
    },
    {
      id: fnG,
      kind: "Function",
      name: "g",
      filePath: "src/b.ts",
      startLine: 1,
      endLine: 5,
      parameterCount: 1,
    },
    {
      id: cls,
      kind: "Class",
      name: "Foo",
      filePath: "src/a.ts",
      startLine: 12,
      endLine: 40,
      isExported: true,
    },
    {
      id: mtBar,
      kind: "Method",
      name: "bar",
      filePath: "src/a.ts",
      startLine: 20,
      endLine: 30,
      parameterCount: 2,
      owner: cls,
    },
    {
      id: procP,
      kind: "Process",
      name: "proc1",
      filePath: "src/a.ts",
      stepCount: 2,
      inferredLabel: "handle request",
    },
  ];
  const edges: Omit<CodeRelation, "id">[] = [
    { from: fileA, to: fnF, type: "DEFINES", confidence: 1 },
    { from: fileA, to: cls, type: "DEFINES", confidence: 1 },
    { from: cls, to: mtBar, type: "HAS_METHOD", confidence: 1 },
    { from: fnF, to: fnG, type: "CALLS", confidence: 0.9, reason: "tier2" },
    { from: mtBar, to: procP, type: "PROCESS_STEP", confidence: 1, step: 1 },
    { from: fnF, to: procP, type: "PROCESS_STEP", confidence: 1, step: 2 },
    { from: fnF, to: procP, type: "ENTRY_POINT_OF", confidence: 0.85 },
  ];
  return { nodes, edges };
}

function buildGraph(
  nodes: readonly GraphNode[],
  edges: readonly Omit<CodeRelation, "id">[],
  nodeOrder: readonly number[],
  edgeOrder: readonly number[],
): KnowledgeGraph {
  const g = new KnowledgeGraph();
  for (const i of nodeOrder) {
    const n = nodes[i];
    if (n) g.addNode(n);
  }
  for (const i of edgeOrder) {
    const e = edges[i];
    if (e) g.addEdge(e);
  }
  return g;
}

function shuffled(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = idx.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = idx[i];
    const other = idx[j];
    if (tmp !== undefined && other !== undefined) {
      idx[i] = other;
      idx[j] = tmp;
    }
  }
  return idx;
}

test("graphHash: stable across 50 random insertion permutations", () => {
  const { nodes, edges } = buildFixtures();
  const reference = graphHash(
    buildGraph(
      nodes,
      edges,
      nodes.map((_, i) => i),
      edges.map((_, i) => i),
    ),
  );
  for (let i = 0; i < 50; i++) {
    const nOrder = shuffled(nodes.length, i + 1);
    const eOrder = shuffled(edges.length, 1000 + i);
    const g = buildGraph(nodes, edges, nOrder, eOrder);
    assert.equal(graphHash(g), reference, `permutation ${i} produced a different hash`);
  }
});

test("graphHash: different edge set produces different hash", () => {
  const { nodes, edges } = buildFixtures();
  const g1 = buildGraph(
    nodes,
    edges,
    nodes.map((_, i) => i),
    edges.map((_, i) => i),
  );
  const g2 = buildGraph(
    nodes,
    edges.slice(0, -1),
    nodes.map((_, i) => i),
    edges.slice(0, -1).map((_, i) => i),
  );
  assert.notEqual(graphHash(g1), graphHash(g2));
});

test("graphHash: identical confidence upgrades produce identical hash", () => {
  const { nodes, edges } = buildFixtures();
  const g1 = new KnowledgeGraph();
  for (const n of nodes) g1.addNode(n);
  for (const e of edges) g1.addEdge(e);
  const g2 = new KnowledgeGraph();
  for (const n of nodes) g2.addNode(n);
  for (const e of edges) {
    g2.addEdge({ ...e, confidence: 0.1 });
    g2.addEdge(e);
  }
  assert.equal(graphHash(g1), graphHash(g2));
});

function buildV1Fixtures(): {
  nodes: GraphNode[];
  edges: Omit<CodeRelation, "id">[];
} {
  const fileA = makeNodeId("File", "src/a.ts", "src/a.ts");
  const findingId = makeNodeId("Finding", "src/a.ts", "py-exec#1");
  const depId = makeNodeId("Dependency", ".codehub/dependencies", "npm:zod@3.22.0");
  const opId = makeNodeId("Operation", "openapi.yaml", "GET:/users/{id}");
  const contribId = makeNodeId("Contributor", ".codehub/contributors", "hash-aaa");
  const profileId = makeNodeId("ProjectProfile", ".codehub/project-profile", "project-profile");
  const nodes: GraphNode[] = [
    { id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts", language: "typescript" },
    {
      id: findingId,
      kind: "Finding",
      name: "py-exec",
      filePath: "src/a.ts",
      startLine: 10,
      endLine: 10,
      ruleId: "py-exec",
      severity: "warning",
      scannerId: "semgrep",
      message: "do not eval",
      propertiesBag: { cwe: "CWE-95" },
    },
    {
      id: depId,
      kind: "Dependency",
      name: "zod",
      filePath: ".codehub/dependencies",
      version: "3.22.0",
      ecosystem: "npm",
      lockfileSource: "pnpm-lock.yaml",
      license: "MIT",
    },
    {
      id: opId,
      kind: "Operation",
      name: "GET /users/{id}",
      filePath: "openapi.yaml",
      method: "GET",
      path: "/users/{id}",
      operationId: "getUserById",
    },
    {
      id: contribId,
      kind: "Contributor",
      name: "Alice",
      filePath: ".codehub/contributors",
      emailHash: "hash-aaa",
    },
    {
      id: profileId,
      kind: "ProjectProfile",
      name: "project-profile",
      filePath: ".codehub/project-profile",
      languages: ["typescript"],
      frameworks: ["react"],
      iacTypes: [],
      apiContracts: ["openapi"],
      manifests: ["package.json"],
      srcDirs: ["packages"],
    },
  ];
  const edges: Omit<CodeRelation, "id">[] = [
    { from: findingId, to: fileA, type: "FOUND_IN", confidence: 1 },
    { from: fileA, to: depId, type: "DEPENDS_ON", confidence: 1 },
    { from: fileA, to: contribId, type: "OWNED_BY", confidence: 0.75 },
    // Canonical COCHANGES direction: lower id as `from`.
    (() => {
      const other = makeNodeId("File", "src/b.ts", "src/b.ts");
      const [from, to] = fileA < other ? [fileA, other] : [other, fileA];
      return { from, to, type: "COCHANGES" as const, confidence: 0.8 };
    })(),
  ];
  return { nodes, edges };
}

test("graphHash: stable with v1.0 kinds + relations across 50 permutations", () => {
  const { nodes, edges } = buildV1Fixtures();
  const reference = graphHash(
    buildGraph(
      nodes,
      edges,
      nodes.map((_, i) => i),
      edges.map((_, i) => i),
    ),
  );
  for (let i = 0; i < 50; i++) {
    const nOrder = shuffled(nodes.length, i + 1);
    const eOrder = shuffled(edges.length, 2000 + i);
    const g = buildGraph(nodes, edges, nOrder, eOrder);
    assert.equal(graphHash(g), reference, `v1.0 permutation ${i} produced a different hash`);
  }
});

test("graphHash: stable for v1.0 kinds across re-require of the module", async () => {
  const { nodes, edges } = buildV1Fixtures();
  const first = graphHash(
    buildGraph(
      nodes,
      edges,
      nodes.map((_, i) => i),
      edges.map((_, i) => i),
    ),
  );
  // Re-import the ESM modules to simulate a Node restart: on a cold re-import
  // every top-level constant (NODE_KINDS, RELATION_TYPES, hash helpers) is
  // freshly evaluated, so a matching hash proves determinism beyond a single
  // process-local closure.
  const bust = `?t=${Date.now()}`;
  const graphMod = (await import(`./graph.js${bust}`)) as typeof import("./graph.js");
  const idMod = (await import(`./id.js${bust}`)) as typeof import("./id.js");
  const hashMod = (await import(`./graph-hash.js${bust}`)) as typeof import("./graph-hash.js");
  const freshFileA = idMod.makeNodeId("File", "src/a.ts", "src/a.ts");
  // Build the same v1.0 fixture against the freshly imported module and confirm
  // the hash matches the original.
  const rebuilt = new graphMod.KnowledgeGraph();
  for (const n of nodes) {
    rebuilt.addNode(n);
  }
  for (const e of edges) {
    rebuilt.addEdge(e);
  }
  const second = hashMod.graphHash(rebuilt);
  assert.equal(second, first, "graphHash drifted across module re-require");
  assert.equal(freshFileA, nodes[0]?.id);
});

test("graphHash: single v1.0 node + v1.0 edge hashes identically twice", () => {
  const fileA = makeNodeId("File", "src/a.ts", "src/a.ts");
  const findingId = makeNodeId("Finding", "src/a.ts", "rule-xyz");
  const node1: GraphNode = {
    id: findingId,
    kind: "Finding",
    name: "rule-xyz",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 1,
    ruleId: "rule-xyz",
    severity: "note",
    scannerId: "pytype",
    message: "ok",
    propertiesBag: {},
  };
  const file: GraphNode = { id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" };
  const g1 = new KnowledgeGraph();
  g1.addNode(file);
  g1.addNode(node1);
  g1.addEdge({ from: findingId, to: fileA, type: "FOUND_IN", confidence: 1 });
  const g2 = new KnowledgeGraph();
  g2.addNode(file);
  g2.addNode(node1);
  g2.addEdge({ from: findingId, to: fileA, type: "FOUND_IN", confidence: 1 });
  assert.equal(graphHash(g1), graphHash(g2));
});
