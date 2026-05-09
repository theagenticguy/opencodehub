/**
 * graphHash parity gate (architecture-revised.md §AC-A-7).
 *
 * Enforces the v1.0 byte-identity invariant (validation constraint #6)
 * across every IGraphStore backend: for every fixture graph,
 *
 *   graphHash(graph)
 *     === graphHash(rebuildFromStore(duckGraph))
 *     === graphHash(rebuildFromStore(graphDbGraph))
 *
 * If these hashes diverge, one of the adapters dropped, reordered, or
 * coerced a field on the round-trip — which would silently break the
 * incremental re-index contract (T-M7-4) and the Reindex parity gate.
 * This file is the CI tripwire.
 *
 * AC-A-7 hoisted the per-backend rebuilders into
 * `./test-utils/parity-harness.ts`. The parity harness now uses ONLY
 * `IGraphStore.listNodes({})` + `IGraphStore.listEdges({})` — a third-
 * party AGE / Memgraph / Neo4j / Neptune adapter can prove conformance
 * by importing `assertGraphParity` from `@opencodehub/storage/test-utils`
 * and running it against its own adapter. This test reduces to fixture
 * builders + a single `assertGraphParity` call per fixture.
 *
 * Three fixtures exercise progressively larger shapes:
 *   - small:  ≤10 nodes, DEFINES + CALLS only (sanity shape).
 *   - medium: ~60 nodes with File / Class / Interface / Method /
 *             Contributor, mixing DEFINES / IMPLEMENTS / HAS_METHOD /
 *             CALLS / OWNED_BY so the v1.1 node + edge surface is visible.
 *   - large:  ≥500 nodes built as a long CALLS chain with shortcuts, plus
 *             a companion sweep that emits at least one edge for every
 *             entry in `getAllRelationTypes()` (24 kinds as of AC-M3-3).
 *   - repo / repo-null: AC-M6-1 RepoNode round-trip — populated AND
 *             explicit-null variants of `originUrl` / `defaultBranch` /
 *             `group`.
 *
 * Step-zero contract (AC-M3-3 + AC-A-2): both adapters' read paths drop
 * `step` when the stored value reads back as 0/null so the rebuilt graph
 * is byte-identical across backends. Fixtures avoid `step: 0` anyway to
 * keep the original-graph comparison clean.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
  type RelationType,
} from "@opencodehub/core-types";
import { DuckDbStore } from "./duckdb-adapter.js";
import { GraphDbStore } from "./graphdb-adapter.js";
import { getAllRelationTypes } from "./graphdb-schema.js";
import type { IGraphStore } from "./interface.js";
import { assertGraphParity } from "./test-utils/parity-harness.js";

// ---------------------------------------------------------------------------
// Scratch path helpers
// ---------------------------------------------------------------------------

async function scratchDuckPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-parity-duck-"));
  return join(dir, "graph.duckdb");
}

async function scratchGraphDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-parity-graphdb-"));
  return join(dir, "graph.db");
}

async function hasGraphDbBinding(): Promise<boolean> {
  try {
    await import("@ladybugdb/core");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
//
// Fixtures deliberately avoid `step: 0` — when an edge's step is explicitly
// zero the DuckDB INTEGER NOT NULL column stores 0 while the graph-db
// nullable INT32 stores 0; the adapters drop step-when-zero on read so the
// rebuilt graph is symmetric, but the ORIGINAL graph would still carry
// `step: 0` and canonical-JSON would emit it, breaking the original ===
// rebuilt assertion. Using step ≥ 1 everywhere sidesteps this.

function buildSmallFixture(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  const fileA = makeNodeId("File", "src/a.ts", "a.ts");
  const fileB = makeNodeId("File", "src/b.ts", "b.ts");
  g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });
  g.addNode({ id: fileB, kind: "File", name: "b.ts", filePath: "src/b.ts" });

  const funcs: NodeId[] = [];
  for (let i = 0; i < 6; i += 1) {
    const file = i % 2 === 0 ? "src/a.ts" : "src/b.ts";
    const id = makeNodeId("Function", file, `fn_${i}`, { parameterCount: i % 3 });
    funcs.push(id);
    g.addNode({
      id,
      kind: "Function",
      name: `fn_${i}`,
      filePath: file,
      startLine: 10 + i,
      endLine: 20 + i,
      signature: `function fn_${i}()`,
      parameterCount: i % 3,
      isExported: i % 2 === 0,
    });
  }
  for (let i = 0; i < funcs.length; i += 1) {
    const from = i % 2 === 0 ? fileA : fileB;
    g.addEdge({ from, to: funcs[i] as NodeId, type: "DEFINES", confidence: 1.0 });
  }
  for (let i = 0; i + 1 < funcs.length; i += 1) {
    g.addEdge({
      from: funcs[i] as NodeId,
      to: funcs[i + 1] as NodeId,
      type: "CALLS",
      confidence: 0.9,
    });
  }
  return g;
}

function buildMediumFixture(): KnowledgeGraph {
  const g = new KnowledgeGraph();

  const files: NodeId[] = [];
  for (let i = 0; i < 6; i += 1) {
    const path = `src/mod${i}/entry.ts`;
    const id = makeNodeId("File", path, path);
    files.push(id);
    g.addNode({
      id,
      kind: "File",
      name: "entry.ts",
      filePath: path,
      contentHash: `hash-${i}`,
    });
  }

  const classes: NodeId[] = [];
  for (let i = 0; i < 6; i += 1) {
    const file = `src/mod${i}/entry.ts`;
    const clsId = makeNodeId("Class", file, `Service${i}`);
    classes.push(clsId);
    g.addNode({
      id: clsId,
      kind: "Class",
      name: `Service${i}`,
      filePath: file,
      startLine: 5,
      endLine: 40,
      isExported: true,
    });
    const ifaceId = makeNodeId("Interface", file, `IService${i}`);
    g.addNode({
      id: ifaceId,
      kind: "Interface",
      name: `IService${i}`,
      filePath: file,
      isExported: true,
    });
    const fileId = files[i];
    if (!fileId) throw new Error("unreachable");
    g.addEdge({ from: fileId, to: clsId, type: "DEFINES", confidence: 1.0 });
    g.addEdge({ from: fileId, to: ifaceId, type: "DEFINES", confidence: 1.0 });
    g.addEdge({ from: clsId, to: ifaceId, type: "IMPLEMENTS", confidence: 1.0 });
  }

  const methods: NodeId[] = [];
  for (let i = 0; i < 6; i += 1) {
    const file = `src/mod${i}/entry.ts`;
    for (let j = 0; j < 3; j += 1) {
      const mId = makeNodeId("Method", file, `Service${i}.method${j}`);
      methods.push(mId);
      g.addNode({
        id: mId,
        kind: "Method",
        name: `method${j}`,
        filePath: file,
        startLine: 10 + j,
        endLine: 15 + j,
        parameterCount: j,
        signature: `method${j}()`,
      });
      const clsId = classes[i];
      if (!clsId) throw new Error("unreachable");
      g.addEdge({ from: clsId, to: mId, type: "HAS_METHOD", confidence: 1.0 });
    }
  }

  // Cross-method CALLS with reason + step ≥ 1.
  for (let i = 0; i + 1 < methods.length; i += 2) {
    const from = methods[i];
    const to = methods[i + 1];
    if (!from || !to) throw new Error("unreachable");
    g.addEdge({ from, to, type: "CALLS", confidence: 0.8, reason: "fixture" });
  }
  for (let i = 2; i < methods.length; i += 3) {
    const from = methods[i];
    const to = methods[(i + 5) % methods.length];
    if (!from || !to) throw new Error("unreachable");
    g.addEdge({ from, to, type: "CALLS", confidence: 0.6, step: 1 });
  }

  // Contributor + ownership.
  const contributor = makeNodeId("Contributor", "<global>", "alice@example.com");
  g.addNode({
    id: contributor,
    kind: "Contributor",
    name: "alice",
    filePath: "<global>",
    emailHash: "hashed",
    emailPlain: "alice@example.com",
  });
  for (const file of files) {
    g.addEdge({ from: file, to: contributor, type: "OWNED_BY", confidence: 1.0 });
  }

  return g;
}

/**
 * Large fixture with ≥500 nodes AND at least one edge for every declared
 * relation type. Built as one File + 500 Functions in a long DEFINES fan
 * and a CALLS chain with shortcuts, plus a follow-up sweep that attaches
 * one edge of every `getAllRelationTypes()` kind between dedicated anchor
 * nodes — so a schema regression that silently drops a rel table surfaces
 * as a hash mismatch.
 */
function buildLargeFixture(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  const N = 500;
  const file = makeNodeId("File", "src/chain.ts", "chain.ts");
  g.addNode({ id: file, kind: "File", name: "chain.ts", filePath: "src/chain.ts" });

  const funcs: NodeId[] = [];
  for (let i = 0; i < N; i += 1) {
    const id = makeNodeId("Function", "src/chain.ts", `step_${i}`);
    funcs.push(id);
    g.addNode({
      id,
      kind: "Function",
      name: `step_${i}`,
      filePath: "src/chain.ts",
      startLine: 10 + i,
      endLine: 12 + i,
      signature: `function step_${i}()`,
      parameterCount: i % 4,
      isExported: i === 0 || i === N - 1,
    });
    g.addEdge({ from: file, to: id, type: "DEFINES", confidence: 1.0 });
  }
  for (let i = 0; i + 1 < N; i += 1) {
    g.addEdge({
      from: funcs[i] as NodeId,
      to: funcs[i + 1] as NodeId,
      type: "CALLS",
      confidence: 0.95,
    });
  }
  // Non-tree shortcuts with explicit step ≥ 1.
  for (let i = 0; i + 10 < N; i += 10) {
    g.addEdge({
      from: funcs[i] as NodeId,
      to: funcs[i + 10] as NodeId,
      type: "CALLS",
      confidence: 0.5,
      step: 1,
    });
  }

  // All-kinds sweep. One anchor node per edge — we build N_rel + 1 anchors
  // and emit anchor[i] --kind[i]--> anchor[i+1]. Anchors live in their own
  // file so they don't collide with the chain Functions above. Step starts
  // at 1 to dodge the step-zero sentinel.
  const relationTypes = getAllRelationTypes();
  const anchors: NodeId[] = [];
  for (let i = 0; i < relationTypes.length + 1; i += 1) {
    const id = makeNodeId("Function", `src/anchors/a${i}.ts`, `anchor_${i}`);
    anchors.push(id);
    g.addNode({ id, kind: "Function", name: `anchor_${i}`, filePath: `src/anchors/a${i}.ts` });
  }
  for (let i = 0; i < relationTypes.length; i += 1) {
    const from = anchors[i];
    const to = anchors[i + 1];
    const kind = relationTypes[i];
    if (!from || !to || !kind) throw new Error("unreachable");
    g.addEdge({
      from,
      to,
      type: kind as RelationType,
      confidence: 0.5 + i * 0.01,
      reason: `fixture-${i}`,
      step: i + 1,
    });
  }

  return g;
}

/**
 * AC-M6-1 fixture: a RepoNode exercising every field — populated +
 * explicit-null variants of `originUrl` / `defaultBranch` / `group`, and
 * a non-empty `languageStats` record. The fixture must round-trip
 * through both stores with matching graphHash, proving the new Repo
 * columns carry their payload losslessly.
 */
function buildRepoFixture(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  const fileA = makeNodeId("File", "src/a.ts", "a.ts");
  g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });

  // Populated Repo node: every attribute carries a concrete value so the
  // round-trip exercises each column.
  const repoId = makeNodeId("Repo", "", "repo");
  g.addNode({
    id: repoId,
    kind: "Repo",
    name: "github.com/acme/example",
    filePath: "",
    originUrl: "https://github.com/acme/example.git",
    repoUri: "github.com/acme/example",
    defaultBranch: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    indexTime: "2026-05-06T12:34:56Z",
    group: "acme",
    visibility: "private",
    indexer: "opencodehub@0.1.0",
    languageStats: { ts: 0.83, py: 0.14, md: 0.03 },
  });
  return g;
}

/**
 * Parallel RepoNode fixture with the nullable string fields explicitly set
 * to `null` — covers the S-M6-1 "no remote" branch where originUrl is
 * absent, defaultBranch is unknown, and the repo is group-less. Empty
 * languageStats ({}) is normalised to NULL on the wire; the reader
 * reconstructs it as `{}` so canonical-JSON parity holds.
 */
function buildRepoNullFixture(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  const fileA = makeNodeId("File", "src/a.ts", "a.ts");
  g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });

  const repoId = makeNodeId("Repo", "", "repo");
  g.addNode({
    id: repoId,
    kind: "Repo",
    name: "local:abcdef012345",
    filePath: "",
    originUrl: null,
    repoUri: "local:abcdef012345",
    defaultBranch: null,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    indexTime: "2026-05-06T12:34:56Z",
    group: null,
    visibility: "private",
    indexer: "opencodehub@0.1.0",
    languageStats: {},
  });
  return g;
}

// ---------------------------------------------------------------------------
// Parity runner — opens both stores (skipping graph-db if its native binding
// is missing) and delegates to the public-interface harness.
// ---------------------------------------------------------------------------

interface ParityCheck {
  readonly name: string;
  readonly fixture: KnowledgeGraph;
}

async function runParity({ name, fixture }: ParityCheck): Promise<void> {
  const duck = new DuckDbStore(await scratchDuckPath());
  await duck.open();
  await duck.createSchema();
  const stores: IGraphStore[] = [duck];

  // Graph-db branch runs only when the native binding is importable — CI
  // platforms without a prebuilt binary skip cleanly rather than fail.
  let graphDb: GraphDbStore | undefined;
  if (await hasGraphDbBinding()) {
    graphDb = new GraphDbStore(await scratchGraphDbPath());
    await graphDb.open();
    await graphDb.createSchema();
    stores.push(graphDb);
  }

  try {
    await assertGraphParity(fixture, { stores, label: name });
  } finally {
    await duck.close();
    if (graphDb) await graphDb.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("graphHash parity: small fixture (≤10 nodes, DEFINES + CALLS)", async () => {
  await runParity({ name: "small", fixture: buildSmallFixture() });
});

test("graphHash parity: medium fixture (mixed node kinds + OWNED_BY edges)", async () => {
  await runParity({ name: "medium", fixture: buildMediumFixture() });
});

test("graphHash parity: large fixture (≥500 nodes, 24-edge-kind sweep)", async () => {
  await runParity({ name: "large", fixture: buildLargeFixture() });
});

test("graphHash parity: repo fixture (RepoNode with all attributes populated)", async () => {
  await runParity({ name: "repo", fixture: buildRepoFixture() });
});

test("graphHash parity: repo fixture with explicit-null origin / branch / group", async () => {
  await runParity({ name: "repo-null", fixture: buildRepoNullFixture() });
});
