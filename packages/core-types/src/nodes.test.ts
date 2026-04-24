import assert from "node:assert/strict";
import { test } from "node:test";
import { KnowledgeGraph } from "./graph.js";
import { graphHash } from "./graph-hash.js";
import { makeNodeId } from "./id.js";
import type {
  ContributorNode,
  DependencyNode,
  FindingNode,
  GraphNode,
  NodeKind,
  OperationNode,
  ProjectProfileNode,
} from "./nodes.js";
import { NODE_KINDS } from "./nodes.js";

test("NODE_KINDS: contains all five v1.0 additions (append-only)", () => {
  assert.ok(NODE_KINDS.includes("Finding"));
  assert.ok(NODE_KINDS.includes("Dependency"));
  assert.ok(NODE_KINDS.includes("Operation"));
  assert.ok(NODE_KINDS.includes("Contributor"));
  assert.ok(NODE_KINDS.includes("ProjectProfile"));
  // Appended, not inserted: the original last MVP kind stays at its prior slot.
  const firstNewIdx = NODE_KINDS.indexOf("Finding");
  assert.equal(NODE_KINDS[firstNewIdx - 1], "Section");
  // Appended in the spec order.
  assert.deepEqual(NODE_KINDS.slice(firstNewIdx), [
    "Finding",
    "Dependency",
    "Operation",
    "Contributor",
    "ProjectProfile",
  ]);
});

test("type-level exhaustiveness: every NodeKind has a sample shape", () => {
  // The `satisfies Record<NodeKind, unknown>` enforces that adding a NodeKind
  // without updating this map fails typecheck, proving enumerability.
  const samples = {
    File: {},
    Folder: {},
    Function: {},
    Class: {},
    Method: {},
    Interface: {},
    Constructor: {},
    Struct: {},
    Enum: {},
    Macro: {},
    Typedef: {},
    Union: {},
    Namespace: {},
    Trait: {},
    Impl: {},
    TypeAlias: {},
    Const: {},
    Static: {},
    Variable: {},
    Property: {},
    Record: {},
    Delegate: {},
    Annotation: {},
    Template: {},
    Module: {},
    CodeElement: {},
    Community: {},
    Process: {},
    Route: {},
    Tool: {},
    Section: {},
    Finding: {},
    Dependency: {},
    Operation: {},
    Contributor: {},
    ProjectProfile: {},
  } satisfies Record<NodeKind, unknown>;
  assert.equal(Object.keys(samples).length, NODE_KINDS.length);
});

test("Finding: node id + insertion into KnowledgeGraph", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("Finding", "src/a.ts", "semgrep-py-exec-10");
  const node: FindingNode = {
    id,
    kind: "Finding",
    name: "Use of eval",
    filePath: "src/a.ts",
    startLine: 42,
    endLine: 42,
    ruleId: "py-exec",
    severity: "warning",
    scannerId: "semgrep",
    message: "Avoid eval on untrusted input",
    propertiesBag: { tags: ["cwe-95"], precision: "high" },
  };
  g.addNode(node);
  assert.equal(g.nodeCount(), 1);
  assert.ok(id.startsWith("Finding:"));
  assert.equal(g.getNode(id)?.name, "Use of eval");
});

test("Dependency: node id + insertion into KnowledgeGraph", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("Dependency", ".codehub/dependencies", "npm:lodash@4.17.21");
  const node: DependencyNode = {
    id,
    kind: "Dependency",
    name: "lodash",
    filePath: ".codehub/dependencies",
    version: "4.17.21",
    ecosystem: "npm",
    lockfileSource: "pnpm-lock.yaml",
    license: "MIT",
  };
  g.addNode(node);
  assert.equal(g.nodeCount(), 1);
  assert.ok(id.startsWith("Dependency:"));
});

test("Operation: node id + insertion into KnowledgeGraph", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("Operation", "openapi.yaml", "GET:/users/{id}");
  const node: OperationNode = {
    id,
    kind: "Operation",
    name: "GET /users/{id}",
    filePath: "openapi.yaml",
    method: "GET",
    path: "/users/{id}",
    summary: "Fetch a user",
    operationId: "getUserById",
  };
  g.addNode(node);
  assert.equal(g.nodeCount(), 1);
  assert.ok(id.startsWith("Operation:"));
});

test("Contributor: privacy default keeps emailPlain absent", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("Contributor", ".codehub/contributors", "abc123");
  const node: ContributorNode = {
    id,
    kind: "Contributor",
    name: "Alice",
    filePath: ".codehub/contributors",
    emailHash: "abc123",
  };
  g.addNode(node);
  const stored = g.getNode(id) as ContributorNode | undefined;
  assert.ok(stored);
  assert.equal(stored?.emailHash, "abc123");
  assert.equal(stored?.emailPlain, undefined);
});

test("ProjectProfile: readonly arrays round-trip through the graph", () => {
  const g = new KnowledgeGraph();
  const id = makeNodeId("ProjectProfile", ".codehub/project-profile", "project-profile");
  const node: ProjectProfileNode = {
    id,
    kind: "ProjectProfile",
    name: "project-profile",
    filePath: ".codehub/project-profile",
    languages: ["typescript", "python"],
    frameworks: ["react", "fastapi"],
    iacTypes: ["terraform"],
    apiContracts: ["openapi"],
    manifests: ["package.json", "pyproject.toml"],
    srcDirs: ["src", "packages"],
  };
  g.addNode(node);
  const stored = g.getNode(id) as ProjectProfileNode | undefined;
  assert.ok(stored);
  assert.deepEqual([...(stored?.languages ?? [])], ["typescript", "python"]);
});

test("round-trip: orderedNodes returns all five new kinds deterministically", () => {
  const finding: FindingNode = {
    id: makeNodeId("Finding", "src/a.ts", "r1"),
    kind: "Finding",
    name: "f",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 1,
    ruleId: "r1",
    severity: "note",
    scannerId: "s",
    message: "m",
    propertiesBag: {},
  };
  const dep: DependencyNode = {
    id: makeNodeId("Dependency", ".codehub/dependencies", "npm:zod@3"),
    kind: "Dependency",
    name: "zod",
    filePath: ".codehub/dependencies",
    version: "3",
    ecosystem: "npm",
    lockfileSource: "pnpm-lock.yaml",
  };
  const op: OperationNode = {
    id: makeNodeId("Operation", "openapi.yaml", "POST:/items"),
    kind: "Operation",
    name: "POST /items",
    filePath: "openapi.yaml",
    method: "POST",
    path: "/items",
  };
  const contrib: ContributorNode = {
    id: makeNodeId("Contributor", ".codehub/contributors", "hash-aaa"),
    kind: "Contributor",
    name: "anon",
    filePath: ".codehub/contributors",
    emailHash: "hash-aaa",
  };
  const profile: ProjectProfileNode = {
    id: makeNodeId("ProjectProfile", ".codehub/project-profile", "project-profile"),
    kind: "ProjectProfile",
    name: "project-profile",
    filePath: ".codehub/project-profile",
    languages: ["go"],
    frameworks: [],
    iacTypes: [],
    apiContracts: [],
    manifests: ["go.mod"],
    srcDirs: ["cmd"],
  };

  const insertions: readonly GraphNode[][] = [
    [finding, dep, op, contrib, profile],
    [profile, contrib, op, dep, finding],
    [op, finding, profile, dep, contrib],
  ];
  const hashes = insertions.map((order) => {
    const graph = new KnowledgeGraph();
    for (const n of order) graph.addNode(n);
    return graphHash(graph);
  });
  // Hash equal regardless of insertion order.
  assert.equal(hashes[0], hashes[1]);
  assert.equal(hashes[1], hashes[2]);

  const ref = new KnowledgeGraph();
  for (const n of insertions[0] ?? []) ref.addNode(n);
  const orderedIds = ref.orderedNodes().map((n) => n.id);
  const sortedCopy = [...orderedIds].sort();
  assert.deepEqual(orderedIds, sortedCopy);
  assert.equal(ref.nodeCount(), 5);
});
