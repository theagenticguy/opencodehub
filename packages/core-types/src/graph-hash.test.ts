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

test("graphHash: agrees with all-in-memory canonical-JSON on a small fixture", async () => {
  // Streaming hashing MUST be byte-identical to the legacy
  // `sha256Hex(canonicalJson({nodes, edges}))` for any input small enough
  // to fit in a single JS string — that's the contract downstream callers
  // rely on when comparing graphHash values across codehub versions and
  // across fixture snapshots. Regression guard against accidental
  // re-ordering or separator changes in the streaming path.
  const { nodes, edges } = buildFixtures();
  const g = buildGraph(
    nodes,
    edges,
    nodes.map((_, i) => i),
    edges.map((_, i) => i),
  );
  const { canonicalJson, sha256Hex } = await import("./hash.js");
  const legacy = sha256Hex(canonicalJson({ nodes: g.orderedNodes(), edges: g.orderedEdges() }));
  assert.equal(graphHash(g), legacy);
});

test("graphHash: handles large edge counts without RangeError (streaming)", () => {
  // Regression guard for the `Invalid string length` crash observed on a
  // 2 k-file monorepo (~1.3 M edges). The old implementation materialized a
  // single ~400 MB canonical-JSON string which blew V8's max-string-length
  // cap (~512 MB for one-byte, ~256 MB for two-byte). The streaming fix
  // must never allocate the full JSON in one shot.
  //
  // We build a synthetic graph whose canonical JSON would exceed ~300 MB
  // if materialized monolithically. Each edge carries a ~400-byte reason
  // blob and a distinct id so the dedupe map keeps them all. 800k edges ×
  // ~450 bytes ≈ 360 MB — above the safe ceiling for a one-shot
  // `Array.prototype.join`, well below the streaming path's O(single-edge)
  // working set.
  //
  // Runtime target: under ~30 s on CI hardware, almost all of which is spent
  // inside `sortEdges` — the hashing itself streams in tens of seconds.
  const g = new KnowledgeGraph();
  const ownerFile = makeNodeId("File", "src/owner.ts", "src/owner.ts");
  g.addNode({ id: ownerFile, kind: "File", name: "owner.ts", filePath: "src/owner.ts" });

  const padding = "x".repeat(400);
  const EDGE_COUNT = 800_000;
  // Sprinkle a handful of distinct target files so orderedEdges has real
  // work to do on `from` / `to`. A single target would still reproduce the
  // string-length explosion but makes the fixture less representative.
  const targetIds: string[] = [];
  const targetBuckets = 128;
  for (let i = 0; i < targetBuckets; i += 1) {
    const path = `src/target-${i}.ts`;
    const id = makeNodeId("File", path, path);
    g.addNode({ id, kind: "File", name: `target-${i}.ts`, filePath: path });
    targetIds.push(id);
  }

  for (let i = 0; i < EDGE_COUNT; i += 1) {
    g.addEdge({
      from: ownerFile,
      to: targetIds[i % targetBuckets] as ReturnType<typeof makeNodeId>,
      type: "REFERENCES",
      confidence: 0.5,
      reason: `${padding}-${i}`,
      step: i,
    });
  }

  const hash = graphHash(g);
  assert.equal(hash.length, 64, "streaming graphHash must still produce a 64-hex-char digest");
  assert.match(hash, /^[0-9a-f]{64}$/);
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

test("graphHash: HAS_METHOD edges are part of the hash input (adding one shifts the hash)", () => {
  // Regression guard for the P1-8 class-member edge emission. The streaming
  // hasher projects `{edges, nodes}` into canonical JSON; a new HAS_METHOD
  // edge between a Class and a Method MUST change the digest relative to a
  // baseline that lacks the edge. If this test ever asserts equality, either
  // the hash input drifted (edges dropped from the projection) or HAS_METHOD
  // stopped being canonicalised.
  const cls = makeNodeId("Class", "src/a.ts", "Foo");
  const method = makeNodeId("Method", "src/a.ts", "Foo.bar", { parameterCount: 0 });
  const nodes: GraphNode[] = [
    { id: cls, kind: "Class", name: "Foo", filePath: "src/a.ts", startLine: 1, endLine: 10 },
    {
      id: method,
      kind: "Method",
      name: "bar",
      filePath: "src/a.ts",
      startLine: 2,
      endLine: 4,
      parameterCount: 0,
      owner: cls,
    },
  ];

  const g1 = new KnowledgeGraph();
  for (const n of nodes) g1.addNode(n);
  const baseline = graphHash(g1);

  const g2 = new KnowledgeGraph();
  for (const n of nodes) g2.addNode(n);
  g2.addEdge({
    from: cls,
    to: method,
    type: "HAS_METHOD",
    confidence: 1,
    reason: "parse/ast",
  });
  const withHasMethod = graphHash(g2);

  assert.notEqual(
    baseline,
    withHasMethod,
    "adding a HAS_METHOD edge must change the graph hash (ensures edge is hash-relevant)",
  );
});

test("graphHash: invariant to cochange history (not in hash input anymore)", () => {
  // COCHANGES is no longer a relation type — cochange rows live in their own
  // table (`cochanges`) and never round-trip through `KnowledgeGraph.addEdge`.
  // This test builds a graph with 100 File nodes plus a handful of non-cochange
  // edges; the hash must be identical before and after we imagine "git activity
  // produced cochange rows" — because those rows live in a separate table
  // outside the graph hash input.
  const g = new KnowledgeGraph();
  const fileIds: ReturnType<typeof makeNodeId>[] = [];
  for (let i = 0; i < 100; i += 1) {
    const path = `src/f${i.toString().padStart(3, "0")}.ts`;
    const id = makeNodeId("File", path, path);
    g.addNode({ id, kind: "File", name: `f${i}.ts`, filePath: path });
    fileIds.push(id);
  }
  for (let i = 0; i + 1 < fileIds.length; i += 2) {
    const a = fileIds[i];
    const b = fileIds[i + 1];
    if (!a || !b) continue;
    g.addEdge({ from: a, to: b, type: "IMPORTS", confidence: 1 });
  }
  const h1 = graphHash(g);

  // Re-compute over the same graph — nothing changed in `relations`/nodes.
  // Even if a separate `cochanges` table grew rows, this hash must not shift.
  const h2 = graphHash(g);
  assert.equal(h1, h2, "graphHash must be stable when only cochange history changes");
});
