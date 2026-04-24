import assert from "node:assert/strict";
import { test } from "node:test";
import { RELATION_TYPES, type RelationType } from "./edges.js";
import { KnowledgeGraph } from "./graph.js";
import { makeNodeId } from "./id.js";
import type { GraphNode } from "./nodes.js";

test("RELATION_TYPES: length is 24 after COCHANGES extraction (21 MVP + 3 new)", () => {
  assert.equal(RELATION_TYPES.length, 24);
});

test("RELATION_TYPES: contains the three remaining v1.0 additions (append-only)", () => {
  for (const t of ["FOUND_IN", "DEPENDS_ON", "OWNED_BY"] as const) {
    assert.ok(RELATION_TYPES.includes(t), `RELATION_TYPES missing ${t}`);
  }
  const firstNewIdx = RELATION_TYPES.indexOf("FOUND_IN");
  assert.equal(RELATION_TYPES[firstNewIdx - 1], "REFERENCES");
  assert.deepEqual(RELATION_TYPES.slice(firstNewIdx), ["FOUND_IN", "DEPENDS_ON", "OWNED_BY"]);
});

test("RELATION_TYPES: COCHANGES is NOT a relation type (moved to cochanges table)", () => {
  assert.ok(!RELATION_TYPES.includes("COCHANGES" as RelationType));
});

test("type-level exhaustiveness: every RelationType appears in RELATION_TYPES", () => {
  const flags: Record<RelationType, true> = {
    CONTAINS: true,
    DEFINES: true,
    IMPORTS: true,
    CALLS: true,
    EXTENDS: true,
    IMPLEMENTS: true,
    HAS_METHOD: true,
    HAS_PROPERTY: true,
    ACCESSES: true,
    METHOD_OVERRIDES: true,
    OVERRIDES: true,
    METHOD_IMPLEMENTS: true,
    MEMBER_OF: true,
    PROCESS_STEP: true,
    HANDLES_ROUTE: true,
    FETCHES: true,
    HANDLES_TOOL: true,
    ENTRY_POINT_OF: true,
    WRAPS: true,
    QUERIES: true,
    REFERENCES: true,
    FOUND_IN: true,
    DEPENDS_ON: true,
    OWNED_BY: true,
  };
  for (const t of RELATION_TYPES) {
    assert.equal(flags[t], true, `RELATION_TYPES contains ${t} but type-check map does not`);
  }
});

test("FOUND_IN: edge added from Finding to File", () => {
  const g = new KnowledgeGraph();
  const fileId = makeNodeId("File", "src/a.ts", "src/a.ts");
  const findingId = makeNodeId("Finding", "src/a.ts", "r-1");
  const file: GraphNode = {
    id: fileId,
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
  };
  const finding: GraphNode = {
    id: findingId,
    kind: "Finding",
    name: "rule fired",
    filePath: "src/a.ts",
    startLine: 10,
    endLine: 10,
    ruleId: "r-1",
    severity: "error",
    scannerId: "semgrep",
    message: "bad",
    propertiesBag: {},
  };
  g.addNode(file);
  g.addNode(finding);
  g.addEdge({ from: findingId, to: fileId, type: "FOUND_IN", confidence: 1 });
  assert.equal(g.edgeCount(), 1);
  const [only] = [...g.edges()];
  assert.ok(only);
  assert.equal(only.type, "FOUND_IN");
});

test("DEPENDS_ON: edge added from File to Dependency", () => {
  const g = new KnowledgeGraph();
  const fileId = makeNodeId("File", "src/a.ts", "src/a.ts");
  const depId = makeNodeId("Dependency", ".codehub/dependencies", "npm:zod@3.22.0");
  g.addEdge({ from: fileId, to: depId, type: "DEPENDS_ON", confidence: 1 });
  assert.equal(g.edgeCount(), 1);
});

test("OWNED_BY: edge weight lives in confidence (normalized blame share)", () => {
  const g = new KnowledgeGraph();
  const fileId = makeNodeId("File", "src/a.ts", "src/a.ts");
  const contribA = makeNodeId("Contributor", ".codehub/contributors", "hash-aaa");
  const contribB = makeNodeId("Contributor", ".codehub/contributors", "hash-bbb");
  // Primary owner gets higher confidence (0.75), secondary lower (0.25).
  g.addEdge({ from: fileId, to: contribA, type: "OWNED_BY", confidence: 0.75 });
  g.addEdge({ from: fileId, to: contribB, type: "OWNED_BY", confidence: 0.25 });
  assert.equal(g.edgeCount(), 2);
  // Dedup tie-break (higher confidence wins) still applies.
  g.addEdge({ from: fileId, to: contribA, type: "OWNED_BY", confidence: 0.1 });
  assert.equal(g.edgeCount(), 2);
  const edges = [...g.edges()];
  const primary = edges.find((e) => e.to === contribA);
  assert.ok(primary);
  assert.equal(primary?.confidence, 0.75);
});
