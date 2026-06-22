/**
 * graphHash byte-identity PARITY GATE for {@link SqliteStore}.
 *
 * This is the P2 go/no-go: a `KnowledgeGraph` bulk-loaded into a SqliteStore
 * over a real temp file and rebuilt via the PUBLIC {@link rebuildFromStore}
 * harness (`listNodes({})` + `listEdges({})`) must produce a `graphHash`
 * byte-identical to the original fixture.
 *
 * Fixtures exercise the sentinel surface that historically broke parity:
 *   - mixed node kinds: File, Function, Class, Method, Route, Dependency,
 *     Repo, Finding, Contributor, Interface — so kind-specific payload fields
 *     (severity / propertiesBag / ecosystem / languageStats / responseKeys)
 *     are round-tripped.
 *   - the sentinels: empty-`languageStats: {}`, Repo nullable `null`
 *     (originUrl/defaultBranch/group), `responseKeys: []` vs absent (the
 *     `[]`-vs-undefined canonicalJson distinction), and empty
 *     `propertiesBag: {}` on a Finding.
 *   - edges with varied step / confidence across DEFINES / CALLS / OWNED_BY /
 *     HAS_METHOD / HANDLES_ROUTE / DEPENDS_ON / FOUND_IN / IMPLEMENTS.
 *
 * STEP-ZERO CONTRACT (load-bearing — do NOT pass `step: 0` in a fixture).
 * The `stepZeroSentinel` (column-encode.ts) is a cross-adapter invariant:
 * `step: 0` is treated as IDENTICAL to an absent `step` at the storage
 * boundary, so `listEdges` drops it on read on EVERY adapter (GraphDbStore
 * drops it at listEdgesInternalGd:1694; SqliteStore at listEdges via
 * stepZeroSentinel). But `graphHash` over a KnowledgeGraph DOES emit
 * `"step":0` when an edge carries it explicitly (canonicalJson preserves the
 * finite `0`). A fixture that passes `step: 0` therefore hashes WITH `"step":0`
 * but rebuilds WITHOUT it — a guaranteed parity break on every backend, not a
 * store bug. Ingestion only ever emits `step >= 1`, so canonical fixtures must
 * use `step >= 1` or omit `step`. These fixtures honor that: every explicit
 * `step` is >= 1, and the absent-step path is also exercised.
 *
 * Idiom mirrors graphdb-roundtrip.test.ts: node:test, mkdtemp temp file,
 * open → createSchema → assertGraphParity. Embeddings are intentionally NOT
 * loaded — graphHash covers nodes + edges only.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type GraphNode,
  graphHash,
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
  type RelationType,
} from "@opencodehub/core-types";
import { assertGraphParity, rebuildFromStore } from "@opencodehub/storage/test-utils";
import { SqliteStore } from "./sqlite-adapter.js";

async function scratchDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-sqlite-parity-"));
  return join(dir, "store.sqlite");
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Small fixture — File + Function nodes with DEFINES + CALLS edges. Confidence
 * varies; some CALLS carry an explicit `step >= 1` (must survive the round-trip)
 * and some omit `step` entirely (the absent-step path).
 */
function buildSmallGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();

  const fileA = makeNodeId("File", "src/a.ts", "a.ts");
  const fileB = makeNodeId("File", "src/b.ts", "b.ts");
  g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });
  g.addNode({
    id: fileB,
    kind: "File",
    name: "b.ts",
    filePath: "src/b.ts",
    contentHash: "deadbeef",
    language: "typescript",
  });

  const funcs: NodeId[] = [];
  for (let i = 0; i < 8; i += 1) {
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
    // Mix: even hops omit `step` (absent-step path), odd hops set step:1
    // (must survive). Never an explicit step:0 — see STEP-ZERO CONTRACT.
    g.addEdge({
      from: funcs[i] as NodeId,
      to: funcs[i + 1] as NodeId,
      type: "CALLS",
      confidence: 0.9 - i * 0.05,
      ...(i % 2 === 1 ? { step: 1 } : {}),
    });
  }

  return g;
}

/**
 * Medium fixture — the full required NodeKind mix plus every sentinel.
 *   File, Function, Class, Method, Interface, Route, Dependency, Repo,
 *   Finding, Contributor.
 * Edges: DEFINES, HAS_METHOD, CALLS, IMPLEMENTS, HANDLES_ROUTE, DEPENDS_ON,
 *   FOUND_IN, OWNED_BY — with varied step + confidence.
 */
function buildMediumGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();

  // ── Repo (first-class node; sentinels: languageStats:{} on one, null
  //    origin/branch/group on another, full on the third). ──
  const repoFull = makeNodeId("Repo", "", "repo-full");
  g.addNode({
    id: repoFull,
    kind: "Repo",
    name: "github.com/acme/example",
    filePath: "",
    originUrl: "https://github.com/acme/example.git",
    repoUri: "github.com/acme/example",
    defaultBranch: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    indexTime: "2026-05-06T12:34:56Z",
    group: "acme",
    visibility: "internal",
    indexer: "opencodehub@0.1.0",
    languageStats: { go: 0.5, ts: 0.3, rs: 0.2 },
  } as unknown as GraphNode);

  const repoEmptyStats = makeNodeId("Repo", "", "repo-empty-stats");
  g.addNode({
    id: repoEmptyStats,
    kind: "Repo",
    name: "github.com/acme/empty",
    filePath: "",
    originUrl: "https://github.com/acme/empty.git",
    repoUri: "github.com/acme/empty",
    defaultBranch: "main",
    commitSha: "aaaa0000bbbb1111cccc2222dddd3333eeee4444",
    indexTime: "2026-05-06T12:34:56Z",
    group: "acme",
    visibility: "internal",
    indexer: "opencodehub@0.1.0",
    // SENTINEL: explicit empty languageStats must round-trip as {} (not absent).
    languageStats: {},
  } as unknown as GraphNode);

  const repoNoRemote = makeNodeId("Repo", "", "repo-no-remote");
  g.addNode({
    id: repoNoRemote,
    kind: "Repo",
    name: "local:abcdef012345",
    filePath: "",
    // SENTINEL: explicit nulls must round-trip as null (not absent).
    originUrl: null,
    repoUri: "local:abcdef012345",
    defaultBranch: null,
    commitSha: "5555666677778888999900001111222233334444",
    indexTime: "2026-05-06T12:34:56Z",
    group: null,
    visibility: "private",
    indexer: "opencodehub@0.1.0",
    languageStats: {},
  } as unknown as GraphNode);

  // ── Files + classes + interfaces + methods. ──
  const files: NodeId[] = [];
  const classes: NodeId[] = [];
  const methods: NodeId[] = [];
  for (let i = 0; i < 5; i += 1) {
    const path = `src/mod${i}/entry.ts`;
    const fileId = makeNodeId("File", path, path);
    files.push(fileId);
    g.addNode({
      id: fileId,
      kind: "File",
      name: "entry.ts",
      filePath: path,
      contentHash: `hash-${i}`,
      lineCount: 100 + i,
    });

    const clsId = makeNodeId("Class", path, `Service${i}`);
    classes.push(clsId);
    g.addNode({
      id: clsId,
      kind: "Class",
      name: `Service${i}`,
      filePath: path,
      startLine: 5,
      endLine: 80,
      isExported: true,
    });

    const ifaceId = makeNodeId("Interface", path, `IService${i}`);
    g.addNode({
      id: ifaceId,
      kind: "Interface",
      name: `IService${i}`,
      filePath: path,
      isExported: true,
    });

    g.addEdge({ from: fileId, to: clsId, type: "DEFINES", confidence: 1.0 });
    g.addEdge({ from: fileId, to: ifaceId, type: "DEFINES", confidence: 1.0 });
    g.addEdge({ from: clsId, to: ifaceId, type: "IMPLEMENTS", confidence: 1.0 });

    for (let j = 0; j < 3; j += 1) {
      const mId = makeNodeId("Method", path, `Service${i}.method${j}`);
      methods.push(mId);
      g.addNode({
        id: mId,
        kind: "Method",
        name: `method${j}`,
        filePath: path,
        startLine: 10 + j,
        endLine: 15 + j,
        parameterCount: j,
        signature: `method${j}()`,
        owner: `Service${i}`,
      });
      g.addEdge({ from: clsId, to: mId, type: "HAS_METHOD", confidence: 1.0 });
    }
  }

  // Sparse CALLS graph with varied step + confidence. Never an explicit
  // step:0 (see STEP-ZERO CONTRACT) — the first sweep omits `step` (absent
  // path), the second sets step:2 (must survive).
  for (let i = 0; i + 1 < methods.length; i += 2) {
    g.addEdge({
      from: methods[i] as NodeId,
      to: methods[i + 1] as NodeId,
      type: "CALLS",
      confidence: 0.8,
      reason: "synthetic fixture",
    });
  }
  for (let i = 2; i < methods.length; i += 3) {
    g.addEdge({
      from: methods[i] as NodeId,
      to: methods[(i + 5) % methods.length] as NodeId,
      type: "CALLS",
      confidence: 0.6,
      step: 2, // must survive.
    });
  }

  // ── Routes — one with responseKeys:[] (SENTINEL: [] vs absent), one with a
  //    populated responseKeys, one with none. Plus HANDLES_ROUTE edges. ──
  const routeEmpty = makeNodeId("Route", "src/mod0/entry.ts", "GET /health");
  g.addNode({
    id: routeEmpty,
    kind: "Route",
    name: "GET /health",
    filePath: "src/mod0/entry.ts",
    url: "/health",
    method: "GET",
    responseKeys: [], // SENTINEL: explicit empty array must round-trip as [].
  } as unknown as GraphNode);

  const routeKeys = makeNodeId("Route", "src/mod1/entry.ts", "POST /users");
  g.addNode({
    id: routeKeys,
    kind: "Route",
    name: "POST /users",
    filePath: "src/mod1/entry.ts",
    url: "/users",
    method: "POST",
    responseKeys: ["id", "createdAt"],
  } as unknown as GraphNode);

  const routeBare = makeNodeId("Route", "src/mod2/entry.ts", "DELETE /users/:id");
  g.addNode({
    id: routeBare,
    kind: "Route",
    name: "DELETE /users/:id",
    filePath: "src/mod2/entry.ts",
    url: "/users/:id",
    method: "DELETE",
  } as unknown as GraphNode);

  g.addEdge({ from: methods[0] as NodeId, to: routeEmpty, type: "HANDLES_ROUTE", confidence: 0.9 });
  g.addEdge({ from: methods[3] as NodeId, to: routeKeys, type: "HANDLES_ROUTE", confidence: 0.9 });
  g.addEdge({ from: methods[6] as NodeId, to: routeBare, type: "HANDLES_ROUTE", confidence: 0.9 });

  // ── Dependencies — varied ecosystem / license, DEPENDS_ON edges. ──
  const depNpm = makeNodeId("Dependency", "package.json", "react@18.2.0");
  g.addNode({
    id: depNpm,
    kind: "Dependency",
    name: "react",
    filePath: "package.json",
    version: "18.2.0",
    ecosystem: "npm",
    lockfileSource: "package-lock.json",
    license: "MIT",
  } as unknown as GraphNode);

  const depPypi = makeNodeId("Dependency", "pyproject.toml", "requests@2.31.0");
  g.addNode({
    id: depPypi,
    kind: "Dependency",
    name: "requests",
    filePath: "pyproject.toml",
    version: "2.31.0",
    ecosystem: "pypi",
    lockfileSource: "uv.lock",
    // No license — exercises an absent optional on Dependency.
  } as unknown as GraphNode);

  g.addEdge({ from: files[0] as NodeId, to: depNpm, type: "DEPENDS_ON", confidence: 1.0 });
  g.addEdge({ from: files[1] as NodeId, to: depPypi, type: "DEPENDS_ON", confidence: 1.0 });

  // ── Finding — required propertiesBag (Record), optional baselineState /
  //    partialFingerprint. FOUND_IN edge with a reason. ──
  const finding = makeNodeId("Finding", "src/mod0/entry.ts", "semgrep:logger-leak:42");
  g.addNode({
    id: finding,
    kind: "Finding",
    name: "logger-credential-leak",
    filePath: "src/mod0/entry.ts",
    startLine: 42,
    endLine: 44,
    ruleId: "logger-leak",
    severity: "warning",
    scannerId: "semgrep",
    message: "Credential may leak to logs",
    propertiesBag: { cwe: "CWE-532", tags: ["security"] },
    partialFingerprint: "fp-0001",
    baselineState: "new",
  } as unknown as GraphNode);

  const findingNoBag = makeNodeId("Finding", "src/mod1/entry.ts", "semgrep:noop:9");
  g.addNode({
    id: findingNoBag,
    kind: "Finding",
    name: "noop-finding",
    filePath: "src/mod1/entry.ts",
    startLine: 9,
    endLine: 9,
    ruleId: "noop",
    severity: "note",
    scannerId: "semgrep",
    message: "Informational",
    // SENTINEL: explicit empty propertiesBag {} must round-trip as {}.
    propertiesBag: {},
  } as unknown as GraphNode);

  g.addEdge({
    from: finding,
    to: methods[0] as NodeId,
    type: "FOUND_IN",
    confidence: 1.0,
    reason: "startLine=42;endLine=44",
  });
  g.addEdge({
    from: findingNoBag,
    to: methods[3] as NodeId,
    type: "FOUND_IN",
    confidence: 1.0,
  });

  // ── Contributor + OWNED_BY edges (varied confidence). ──
  const contributor = makeNodeId("Contributor", "<global>", "alice@example.com");
  g.addNode({
    id: contributor,
    kind: "Contributor",
    name: "alice",
    filePath: "<global>",
    emailHash: "hashed-alice",
    emailPlain: "alice@example.com",
  });
  const contributorB = makeNodeId("Contributor", "<global>", "bob@example.com");
  g.addNode({
    id: contributorB,
    kind: "Contributor",
    name: "bob",
    filePath: "<global>",
    emailHash: "hashed-bob",
    // No emailPlain — privacy default.
  });
  for (let i = 0; i < files.length; i += 1) {
    g.addEdge({
      from: files[i] as NodeId,
      to: i % 2 === 0 ? contributor : contributorB,
      type: "OWNED_BY",
      confidence: 0.25 + i * 0.1,
    });
  }

  return g;
}

// ---------------------------------------------------------------------------
// Round-trip driver
// ---------------------------------------------------------------------------

async function freshStore(): Promise<SqliteStore> {
  const store = new SqliteStore(await scratchDbPath());
  await store.open();
  await store.createSchema();
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("graphHash parity: small fixture (File + Function, DEFINES + CALLS, step>=1 and absent-step)", async () => {
  const fixture = buildSmallGraph();
  const store = await freshStore();
  try {
    await assertGraphParity(fixture, { stores: [store], label: "sqlite-small" });
  } finally {
    await store.close();
  }
});

test("graphHash parity: medium fixture (mixed kinds + sentinels)", async () => {
  const fixture = buildMediumGraph();
  const store = await freshStore();
  try {
    await assertGraphParity(fixture, { stores: [store], label: "sqlite-medium" });
  } finally {
    await store.close();
  }
});

// Explicit per-node first-mismatch diagnosis path — surfaces WHICH node/edge
// broke parity with the canonical-JSON projection, not just a hash mismatch.
test("graphHash parity: medium fixture — first-mismatch diagnosis", async () => {
  const fixture = buildMediumGraph();
  const store = await freshStore();
  try {
    await store.bulkLoad(fixture);
    const rebuilt = await rebuildFromStore(store);
    const originalHash = graphHash(fixture);
    const rebuiltHash = graphHash(rebuilt);
    if (originalHash !== rebuiltHash) {
      const origNodes = fixture.orderedNodes();
      const rebNodes = rebuilt.orderedNodes();
      let diag = "no node-level mismatch found (edge-level divergence)";
      const max = Math.max(origNodes.length, rebNodes.length);
      for (let i = 0; i < max; i += 1) {
        const a = JSON.stringify(origNodes[i] ?? null, Object.keys(origNodes[i] ?? {}).sort());
        const b = JSON.stringify(rebNodes[i] ?? null, Object.keys(rebNodes[i] ?? {}).sort());
        if (a !== b) {
          diag = `first node mismatch at index ${i}:\n  original: ${a}\n  rebuilt:  ${b}`;
          break;
        }
      }
      const origEdges = fixture.orderedEdges();
      const rebEdges = rebuilt.orderedEdges();
      let edgeDiag = "edges match";
      const emax = Math.max(origEdges.length, rebEdges.length);
      for (let i = 0; i < emax; i += 1) {
        const a = JSON.stringify(origEdges[i] ?? null, Object.keys(origEdges[i] ?? {}).sort());
        const b = JSON.stringify(rebEdges[i] ?? null, Object.keys(rebEdges[i] ?? {}).sort());
        if (a !== b) {
          edgeDiag = `first edge mismatch at index ${i}:\n  original: ${a}\n  rebuilt:  ${b}`;
          break;
        }
      }
      assert.fail(
        `graphHash parity broken for medium fixture\n` +
          `  original: ${originalHash}\n  rebuilt:  ${rebuiltHash}\n` +
          `  node counts: original=${origNodes.length} rebuilt=${rebNodes.length}\n` +
          `  edge counts: original=${origEdges.length} rebuilt=${rebEdges.length}\n` +
          `  ${diag}\n  ${edgeDiag}`,
      );
    }
    assert.equal(rebuiltHash, originalHash);
  } finally {
    await store.close();
  }
});

test("graphHash parity is deterministic across two independent stores", async () => {
  const fixture = buildMediumGraph();
  const a = await freshStore();
  const b = await freshStore();
  try {
    await assertGraphParity(fixture, { stores: [a, b], label: "sqlite-cross-store" });
  } finally {
    await a.close();
    await b.close();
  }
});

// Belt-and-suspenders: every declared edge kind round-trips at least one row,
// so a dropped type surfaces as a parity failure rather than a silent miss.
test("graphHash parity: every declared edge kind round-trips", async () => {
  const { getAllRelationTypes } = await import("./graphdb-schema.js");
  const relationTypes = getAllRelationTypes();
  const g = new KnowledgeGraph();
  const nodes: NodeId[] = [];
  for (let i = 0; i < relationTypes.length + 1; i += 1) {
    const id = makeNodeId("Function", `src/f${i}.ts`, `fn${i}`);
    nodes.push(id);
    g.addNode({ id, kind: "Function", name: `fn${i}`, filePath: `src/f${i}.ts` });
  }
  for (let i = 0; i < relationTypes.length; i += 1) {
    g.addEdge({
      from: nodes[i] as NodeId,
      to: nodes[i + 1] as NodeId,
      type: relationTypes[i] as RelationType,
      confidence: 0.5 + i * 0.01,
      reason: `fixture-${i}`,
      step: i + 1, // always >= 1 (see STEP-ZERO CONTRACT) — must survive.
    });
  }
  const store = await freshStore();
  try {
    await assertGraphParity(g, { stores: [store], label: "sqlite-all-kinds" });
  } finally {
    await store.close();
  }
});
