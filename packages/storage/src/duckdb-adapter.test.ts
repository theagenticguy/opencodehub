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
} from "@opencodehub/core-types";
import { DuckDbStore } from "./duckdb-adapter.js";
import type { StoreMeta } from "./interface.js";

async function scratchDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-storage-duck-"));
  return join(dir, "graph.duckdb");
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildSmallGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();

  const fileA = makeNodeId("File", "src/a.ts", "a.ts");
  const fileB = makeNodeId("File", "src/b.ts", "b.ts");
  // Note: we intentionally omit fields (e.g. `language`, `contentHash`) that
  // the fixture doesn't rely on for the determinism assertion. The schema
  // stores a documented subset of node fields — rebuildGraphFromStore reads
  // the same subset back, so graphHash is stable across the round-trip.
  g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });
  g.addNode({ id: fileB, kind: "File", name: "b.ts", filePath: "src/b.ts" });

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
      signature: `function fn_${i}(${"x,".repeat(i % 3).replace(/,$/, "")})`,
      parameterCount: i % 3,
      isExported: i % 2 === 0,
    });
  }

  // Edges: DEFINES from each file to its functions, plus a CALLS chain.
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

// Read all rows back from DuckDB and rebuild a KnowledgeGraph so we can
// compare logical hashes across different writes.
// Column → GraphNode key mapping used by the hash round-trip helper. Kept
// flat (no kind-specific logic) because the fixture graph only uses File and
// Function nodes, which share a subset of these fields.
const NODE_COLUMN_MAP: readonly (readonly [string, string, "number" | "string" | "boolean"])[] = [
  ["start_line", "startLine", "number"],
  ["end_line", "endLine", "number"],
  ["is_exported", "isExported", "boolean"],
  ["signature", "signature", "string"],
  ["parameter_count", "parameterCount", "number"],
  ["return_type", "returnType", "string"],
  ["declared_type", "declaredType", "string"],
  ["owner", "owner", "string"],
  ["content_hash", "contentHash", "string"],
];

async function rebuildGraphFromStore(store: DuckDbStore): Promise<KnowledgeGraph> {
  const nodeRows = await store.query(
    `SELECT id, kind, name, file_path, start_line, end_line, is_exported, signature,
            parameter_count, return_type, declared_type, owner, content_hash
     FROM nodes ORDER BY id`,
  );
  const edgeRows = await store.query(
    "SELECT id, from_id, to_id, type, confidence, reason, step FROM relations ORDER BY id",
  );
  const g = new KnowledgeGraph();
  for (const row of nodeRows) {
    const id = String(row["id"]) as NodeId;
    const kind = String(row["kind"]);
    const base: Record<string, unknown> = {
      id,
      kind,
      name: String(row["name"] ?? ""),
      filePath: String(row["file_path"] ?? ""),
    };
    for (const [col, key, kind2] of NODE_COLUMN_MAP) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      if (kind2 === "number") base[key] = Number(v);
      else if (kind2 === "boolean") base[key] = Boolean(v);
      else base[key] = String(v);
    }
    g.addNode(base as unknown as GraphNode);
  }
  for (const row of edgeRows) {
    const step = Number(row["step"] ?? 0);
    g.addEdge({
      from: String(row["from_id"]) as NodeId,
      to: String(row["to_id"]) as NodeId,
      type: row["type"] as "CALLS" | "DEFINES",
      confidence: Number(row["confidence"] ?? 0),
      ...(row["reason"] !== null && row["reason"] !== undefined
        ? { reason: String(row["reason"]) }
        : {}),
      ...(step !== 0 ? { step } : {}),
    });
  }
  return g;
}

// ---------------------------------------------------------------------------
// Core lifecycle
// ---------------------------------------------------------------------------

test("open → createSchema → bulkLoad → counts match", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const graph = buildSmallGraph();
    const stats = await store.bulkLoad(graph);
    assert.equal(stats.nodeCount, graph.nodeCount());
    assert.equal(stats.edgeCount, graph.edgeCount());
    const nodeCountRow = await store.query("SELECT COUNT(*) AS n FROM nodes");
    const edgeCountRow = await store.query("SELECT COUNT(*) AS n FROM relations");
    assert.equal(Number(nodeCountRow[0]?.["n"]), graph.nodeCount());
    assert.equal(Number(edgeCountRow[0]?.["n"]), graph.edgeCount());
  } finally {
    await store.close();
  }
});

test("reopen read-only → same row counts", async () => {
  const dbPath = await scratchDbPath();
  const writer = new DuckDbStore(dbPath);
  await writer.open();
  await writer.createSchema();
  const graph = buildSmallGraph();
  const originalNodes = graph.nodeCount();
  const originalEdges = graph.edgeCount();
  await writer.bulkLoad(graph);
  await writer.close();

  const reader = new DuckDbStore(dbPath, { readOnly: true });
  await reader.open();
  try {
    const n = await reader.query("SELECT COUNT(*) AS n FROM nodes");
    const e = await reader.query("SELECT COUNT(*) AS n FROM relations");
    assert.equal(Number(n[0]?.["n"]), originalNodes);
    assert.equal(Number(e[0]?.["n"]), originalEdges);
  } finally {
    await reader.close();
  }
});

test("read-only connection rejects CREATE TABLE", async () => {
  const dbPath = await scratchDbPath();
  const writer = new DuckDbStore(dbPath);
  await writer.open();
  await writer.createSchema();
  await writer.close();

  const reader = new DuckDbStore(dbPath, { readOnly: true });
  await reader.open();
  try {
    // Bypass the guard by checking the engine itself; the guard test suite
    // covers guard rejection separately. We push a raw run through the
    // adapter's query() API which routes through the guard, so instead reach
    // in and run directly via the connection by re-opening + writing a table.
    // A simpler check: the guard should reject CREATE upfront.
    await assert.rejects(async () => {
      await reader.query("CREATE TABLE x (a INT)");
    }, /CREATE/);
  } finally {
    await reader.close();
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("logical graphHash matches across two independent bulk loads", async () => {
  const graph = buildSmallGraph();
  const originalHash = graphHash(graph);

  const pathA = await scratchDbPath();
  const storeA = new DuckDbStore(pathA);
  await storeA.open();
  await storeA.createSchema();
  await storeA.bulkLoad(graph);
  const rebuiltA = await rebuildGraphFromStore(storeA);
  await storeA.close();

  const pathB = await scratchDbPath();
  const storeB = new DuckDbStore(pathB);
  await storeB.open();
  await storeB.createSchema();
  await storeB.bulkLoad(graph);
  const rebuiltB = await rebuildGraphFromStore(storeB);
  await storeB.close();

  const hashA = graphHash(rebuiltA);
  const hashB = graphHash(rebuiltB);
  assert.equal(hashA, hashB, "hashes across the two stores must match");
  assert.equal(hashA, originalHash, "hash after round-trip must match the original graph hash");
});

// ---------------------------------------------------------------------------
// FTS / BM25
// ---------------------------------------------------------------------------

test("search: BM25 index finds a distinct symbol name", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const ids = [
      makeNodeId("Function", "src/user.ts", "parseUserProfile"),
      makeNodeId("Function", "src/view.ts", "renderMarkdownView"),
      makeNodeId("Function", "src/router.ts", "registerHttpRoute"),
    ];
    const names = ["parseUserProfile", "renderMarkdownView", "registerHttpRoute"];
    for (let i = 0; i < ids.length; i += 1) {
      g.addNode({
        id: ids[i] as NodeId,
        kind: "Function",
        name: names[i] ?? "",
        filePath: `src/f${i}.ts`,
        signature: `function ${names[i]}()`,
      });
    }
    await store.bulkLoad(g);

    const results = await store.search({ text: "parseUserProfile", limit: 5 });
    assert.ok(results.length >= 1, "search should return at least one row");
    const top = results[0];
    assert.ok(top, "top row exists");
    assert.equal(top.nodeId, ids[0]);
    assert.equal(top.name, "parseUserProfile");
    assert.ok(top.score > 0, "BM25 score should be positive");
  } finally {
    await store.close();
  }
});

test("search: identical queries return deterministic order when scores tie", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    // Seven functions with the same name in different files will all match
    // the same BM25 query string and are likely to tie on score. The
    // tiebreaker in ORDER BY (id ASC, file_path ASC, name ASC) must produce
    // an identical ordering across repeated calls.
    const files = [
      "src/a/alpha.ts",
      "src/b/alpha.ts",
      "src/c/alpha.ts",
      "src/d/alpha.ts",
      "src/e/alpha.ts",
      "src/f/alpha.ts",
      "src/g/alpha.ts",
    ];
    for (const file of files) {
      const id = makeNodeId("Function", file, "eventLoopCycle");
      g.addNode({
        id,
        kind: "Function",
        name: "eventLoopCycle",
        filePath: file,
        signature: "function eventLoopCycle()",
      });
    }
    await store.bulkLoad(g);

    const run1 = await store.search({ text: "eventLoopCycle", limit: 10 });
    const run2 = await store.search({ text: "eventLoopCycle", limit: 10 });
    const run3 = await store.search({ text: "eventLoopCycle", limit: 10 });

    assert.ok(run1.length >= files.length, "should return all matching rows");
    const ids1 = run1.map((r) => r.nodeId);
    const ids2 = run2.map((r) => r.nodeId);
    const ids3 = run3.map((r) => r.nodeId);
    assert.deepEqual(ids1, ids2, "back-to-back search runs must return identical order");
    assert.deepEqual(ids2, ids3, "three consecutive runs must all agree");

    // Among rows that tie on score, the tiebreakers must produce a
    // lexicographic order: sorting by (id, file_path, name) reproduces the
    // actual result order within each score bucket.
    type Row = (typeof run1)[number];
    const byScore = new Map<number, Row[]>();
    for (const r of run1) {
      const bucket = byScore.get(r.score) ?? [];
      bucket.push(r);
      byScore.set(r.score, bucket);
    }
    for (const bucket of byScore.values()) {
      if (bucket.length < 2) continue;
      const sorted = [...bucket].sort((a, b) => {
        if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
        if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return 0;
      });
      assert.deepEqual(
        bucket.map((r) => r.nodeId),
        sorted.map((r) => r.nodeId),
        "tied-score rows must be ordered by (id, file_path, name) ascending",
      );
    }
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Granularity migration + filter tests (P03)
// ---------------------------------------------------------------------------

test("embeddings rows default to granularity='symbol' when not set", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath, { embeddingDim: 4 });
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const id = makeNodeId("Function", "src/a.ts", "a");
    g.addNode({
      id,
      kind: "Function",
      name: "a",
      filePath: "src/a.ts",
    });
    await store.bulkLoad(g);
    // Legacy caller: no `granularity` field. The adapter passes an explicit
    // 'symbol' fallback so the row always has a tier on disk.
    await store.upsertEmbeddings([
      {
        nodeId: id,
        chunkIndex: 0,
        vector: new Float32Array([1, 0, 0, 0]),
        contentHash: "h",
      },
    ]);
    const rows = await store.query("SELECT granularity FROM embeddings WHERE node_id = ?", [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["granularity"], "symbol");
  } finally {
    await store.close();
  }
});

test("vectorSearch with granularity filter restricts to that tier", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath, { embeddingDim: 4 });
  await store.open();
  const warning = store.getExtensionWarning();
  if (warning?.startsWith("No HNSW")) {
    await store.close();
    assert.ok(true, "no HNSW extension available — test skipped");
    return;
  }
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const fnId = makeNodeId("Function", "src/a.ts", "a");
    const fileId = makeNodeId("File", "src/a.ts", "src/a.ts");
    const commId = makeNodeId("Community", "<global>", "community-0");
    g.addNode({ id: fnId, kind: "Function", name: "a", filePath: "src/a.ts" });
    g.addNode({ id: fileId, kind: "File", name: "a.ts", filePath: "src/a.ts" });
    g.addNode({
      id: commId,
      kind: "Community",
      name: "community-0",
      filePath: "<global>",
      symbolCount: 3,
      cohesion: 1,
    });
    await store.bulkLoad(g);
    await store.upsertEmbeddings([
      {
        nodeId: fnId,
        granularity: "symbol",
        chunkIndex: 0,
        vector: new Float32Array([1, 0, 0, 0]),
        contentHash: "h-sym",
      },
      {
        nodeId: fileId,
        granularity: "file",
        chunkIndex: 0,
        vector: new Float32Array([0.9, 0.1, 0, 0]),
        contentHash: "h-file",
      },
      {
        nodeId: commId,
        granularity: "community",
        chunkIndex: 0,
        vector: new Float32Array([0.8, 0.2, 0, 0]),
        contentHash: "h-comm",
      },
    ]);

    const fileHits = await store.vectorSearch({
      vector: new Float32Array([1, 0, 0, 0]),
      granularity: "file",
      limit: 10,
    });
    assert.equal(fileHits.length, 1);
    assert.equal(fileHits[0]?.nodeId, fileId);

    const commHits = await store.vectorSearch({
      vector: new Float32Array([1, 0, 0, 0]),
      granularity: "community",
      limit: 10,
    });
    assert.equal(commHits.length, 1);
    assert.equal(commHits[0]?.nodeId, commId);

    const multi = await store.vectorSearch({
      vector: new Float32Array([1, 0, 0, 0]),
      granularity: ["symbol", "community"],
      limit: 10,
    });
    const ids = new Set(multi.map((r) => r.nodeId));
    assert.ok(ids.has(fnId));
    assert.ok(ids.has(commId));
    assert.ok(!ids.has(fileId));
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

test("vectorSearch with HNSW filters by WHERE clause", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath, { embeddingDim: 4 });
  await store.open();

  // If neither hnsw_acorn nor vss loaded (e.g. offline), the vector search is
  // disabled and the test skips rather than fails — see anti-goal in the PRD.
  const warning = store.getExtensionWarning();
  if (warning?.startsWith("No HNSW")) {
    await store.close();
    assert.ok(true, "no HNSW extension available — test skipped");
    return;
  }

  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const ids: NodeId[] = [];
    const languages = ["python", "python", "python", "javascript", "javascript"];
    const vectors = [
      [1.0, 0.0, 0.0, 0.0],
      [0.9, 0.1, 0.0, 0.0],
      [0.8, 0.2, 0.0, 0.0],
      [0.0, 1.0, 0.0, 0.0],
      [0.0, 0.9, 0.1, 0.0],
    ];
    for (let i = 0; i < 5; i += 1) {
      const id = makeNodeId("File", `src/f${i}.${i < 3 ? "py" : "js"}`, `f${i}`);
      ids.push(id);
      g.addNode({
        id,
        kind: "File",
        name: `f${i}`,
        filePath: `src/f${i}.${i < 3 ? "py" : "js"}`,
        language: languages[i] ?? "",
      });
    }
    await store.bulkLoad(g);
    await store.upsertEmbeddings(
      ids.map((id, i) => ({
        nodeId: id,
        chunkIndex: 0,
        vector: new Float32Array(vectors[i] ?? []),
        contentHash: `h${i}`,
      })),
    );

    const results = await store.vectorSearch({
      vector: new Float32Array([1.0, 0.0, 0.0, 0.0]),
      whereClause: "n.file_path LIKE ?",
      params: ["%.py"],
      limit: 10,
    });
    assert.ok(results.length <= 3, `filter should cap results at 3, got ${results.length}`);
    for (const r of results) {
      assert.ok(
        r.nodeId.includes(".py"),
        `filtered result ${r.nodeId} should come from a python file`,
      );
    }
    const first = results[0];
    assert.ok(first, "at least one match expected");
    assert.equal(first.nodeId, ids[0], "nearest should be the identical vector");
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

test("traverse (down): reaches transitive children within depth bound", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const a = makeNodeId("Function", "x.ts", "A");
    const b = makeNodeId("Function", "x.ts", "B");
    const c = makeNodeId("Function", "x.ts", "C");
    const d = makeNodeId("Function", "x.ts", "D");
    for (const [id, name] of [
      [a, "A"],
      [b, "B"],
      [c, "C"],
      [d, "D"],
    ] as const) {
      g.addNode({ id, kind: "Function", name, filePath: "x.ts" });
    }
    g.addEdge({ from: a, to: b, type: "CALLS", confidence: 1.0 });
    g.addEdge({ from: b, to: c, type: "CALLS", confidence: 1.0 });
    g.addEdge({ from: c, to: d, type: "CALLS", confidence: 1.0 });
    await store.bulkLoad(g);

    const downDepth2 = await store.traverse({
      startId: a,
      direction: "down",
      maxDepth: 2,
      relationTypes: ["CALLS"],
    });
    const reachedIds = new Set(downDepth2.map((r) => r.nodeId));
    assert.ok(reachedIds.has(b), "B should be reached at depth 1");
    assert.ok(reachedIds.has(c), "C should be reached at depth 2");
    assert.ok(!reachedIds.has(d), "D must be pruned by depth bound");

    const upFromD = await store.traverse({
      startId: d,
      direction: "up",
      maxDepth: 3,
      relationTypes: ["CALLS"],
    });
    const upIds = new Set(upFromD.map((r) => r.nodeId));
    assert.ok(upIds.has(c) && upIds.has(b) && upIds.has(a), "up traversal reaches A");
  } finally {
    await store.close();
  }
});

test("traverse (both): reaches upstream and downstream neighbors without duplicates", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    // Graph: A -> B -> C, and D -> B (so B has an upstream caller D besides A).
    const a = makeNodeId("Function", "x.ts", "A");
    const b = makeNodeId("Function", "x.ts", "B");
    const c = makeNodeId("Function", "x.ts", "C");
    const d = makeNodeId("Function", "x.ts", "D");
    for (const [id, name] of [
      [a, "A"],
      [b, "B"],
      [c, "C"],
      [d, "D"],
    ] as const) {
      g.addNode({ id, kind: "Function", name, filePath: "x.ts" });
    }
    g.addEdge({ from: a, to: b, type: "CALLS", confidence: 1.0 });
    g.addEdge({ from: b, to: c, type: "CALLS", confidence: 1.0 });
    g.addEdge({ from: d, to: b, type: "CALLS", confidence: 1.0 });
    await store.bulkLoad(g);

    const both = await store.traverse({
      startId: b,
      direction: "both",
      maxDepth: 2,
      relationTypes: ["CALLS"],
    });
    const ids = both.map((r) => r.nodeId);
    const idSet = new Set(ids);
    // Forward reach: C (B -> C) and backward reach: A, D (A -> B, D -> B).
    assert.ok(idSet.has(a), "both traversal must reach upstream caller A");
    assert.ok(idSet.has(c), "both traversal must reach downstream callee C");
    assert.ok(idSet.has(d), "both traversal must reach upstream caller D");
    // USING KEY collapses duplicate visits so each node_id appears at most once.
    assert.equal(ids.length, idSet.size, "no duplicate node_ids in traverse result");
    // Start node must not appear (WHERE depth > 0).
    assert.ok(!idSet.has(b), "start node B must be excluded from result set");
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Meta + health
// ---------------------------------------------------------------------------

test("setMeta / getMeta round-trips including stats", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const meta: StoreMeta = {
      schemaVersion: "1.0.0",
      lastCommit: "deadbeef",
      indexedAt: "2026-04-18T09:00:00Z",
      nodeCount: 100,
      edgeCount: 250,
      stats: { files: 12, functions: 88 },
    };
    await store.setMeta(meta);
    const readBack = await store.getMeta();
    assert.deepEqual(readBack, meta);
  } finally {
    await store.close();
  }
});

test("healthCheck returns ok after open", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const h = await store.healthCheck();
    assert.equal(h.ok, true);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// v1.1 NodeKinds round-trip
// ---------------------------------------------------------------------------

test("bulkLoad stores Finding / Dependency / Operation / Contributor / ProjectProfile columns", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();

    const findingId = makeNodeId("Finding", "src/a.ts", "rule-x#1");
    g.addNode({
      id: findingId,
      kind: "Finding",
      name: "rule-x#1",
      filePath: "src/a.ts",
      startLine: 10,
      endLine: 12,
      ruleId: "rule-x",
      severity: "warning",
      scannerId: "semgrep",
      message: "Possible XSS sink",
      propertiesBag: { cwe: "CWE-79", confidence: "HIGH" },
    } as unknown as GraphNode);

    const depId = makeNodeId("Dependency", "package-lock.json", "react@18.2.0");
    g.addNode({
      id: depId,
      kind: "Dependency",
      name: "react",
      filePath: "package-lock.json",
      version: "18.2.0",
      ecosystem: "npm",
      lockfileSource: "package-lock.json",
      license: "MIT",
    } as unknown as GraphNode);

    const opId = makeNodeId("Operation", "openapi.yaml", "GET /users/{id}");
    g.addNode({
      id: opId,
      kind: "Operation",
      name: "getUserById",
      filePath: "openapi.yaml",
      method: "GET",
      path: "/users/{id}",
      summary: "Fetch one user by id",
      operationId: "getUserById",
    } as unknown as GraphNode);

    const contribId = makeNodeId("Contributor", "", "7a0f...");
    g.addNode({
      id: contribId,
      kind: "Contributor",
      name: "Alice Example",
      filePath: "",
      emailHash: "7a0fcafedeadbeef",
      emailPlain: "alice@example.com",
    } as unknown as GraphNode);

    const profileId = makeNodeId("ProjectProfile", "", "repo");
    g.addNode({
      id: profileId,
      kind: "ProjectProfile",
      name: "repo",
      filePath: "",
      languages: ["typescript", "python"],
      frameworks: ["react", "fastapi"],
      iacTypes: ["terraform"],
      apiContracts: ["openapi"],
      manifests: ["package.json", "pyproject.toml"],
      srcDirs: ["src", "packages"],
    } as unknown as GraphNode);

    await store.bulkLoad(g);

    const fRow = await store.query(
      `SELECT severity, rule_id, scanner_id, message, properties_bag
       FROM nodes WHERE id = ?`,
      [findingId],
    );
    const fr = fRow[0];
    assert.ok(fr);
    assert.equal(fr["severity"], "warning");
    assert.equal(fr["rule_id"], "rule-x");
    assert.equal(fr["scanner_id"], "semgrep");
    assert.equal(fr["message"], "Possible XSS sink");
    const bag = JSON.parse(String(fr["properties_bag"])) as Record<string, unknown>;
    assert.equal(bag["cwe"], "CWE-79");
    assert.equal(bag["confidence"], "HIGH");

    const dRow = await store.query(
      "SELECT version, license, lockfile_source, ecosystem FROM nodes WHERE id = ?",
      [depId],
    );
    const dr = dRow[0];
    assert.ok(dr);
    assert.equal(dr["version"], "18.2.0");
    assert.equal(dr["license"], "MIT");
    assert.equal(dr["lockfile_source"], "package-lock.json");
    assert.equal(dr["ecosystem"], "npm");

    const oRow = await store.query(
      "SELECT http_method, http_path, summary, operation_id, method FROM nodes WHERE id = ?",
      [opId],
    );
    const or = oRow[0];
    assert.ok(or);
    assert.equal(or["http_method"], "GET");
    assert.equal(or["http_path"], "/users/{id}");
    assert.equal(or["summary"], "Fetch one user by id");
    assert.equal(or["operation_id"], "getUserById");
    // OperationNode.method must NOT leak into the route-scoped `method` column.
    assert.equal(or["method"], null);

    const cRow = await store.query("SELECT email_hash, email_plain FROM nodes WHERE id = ?", [
      contribId,
    ]);
    const cr = cRow[0];
    assert.ok(cr);
    assert.equal(cr["email_hash"], "7a0fcafedeadbeef");
    assert.equal(cr["email_plain"], "alice@example.com");

    const pRow = await store.query(
      `SELECT languages_json, frameworks_json, iac_types_json,
              api_contracts_json, manifests_json, src_dirs_json
       FROM nodes WHERE id = ?`,
      [profileId],
    );
    const pr = pRow[0];
    assert.ok(pr);
    assert.deepEqual(JSON.parse(String(pr["languages_json"])), ["typescript", "python"]);
    assert.deepEqual(JSON.parse(String(pr["frameworks_json"])), ["react", "fastapi"]);
    assert.deepEqual(JSON.parse(String(pr["iac_types_json"])), ["terraform"]);
    assert.deepEqual(JSON.parse(String(pr["api_contracts_json"])), ["openapi"]);
    assert.deepEqual(JSON.parse(String(pr["manifests_json"])), ["package.json", "pyproject.toml"]);
    assert.deepEqual(JSON.parse(String(pr["src_dirs_json"])), ["src", "packages"]);
  } finally {
    await store.close();
  }
});

test("bulkLoad stores FOUND_IN / DEPENDS_ON / OWNED_BY relation types", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();

    const fileA = makeNodeId("File", "src/a.ts", "a.ts");
    const fnA = makeNodeId("Function", "src/a.ts", "alpha");
    const findingX = makeNodeId("Finding", "src/a.ts", "X#1");
    const depY = makeNodeId("Dependency", "package-lock.json", "react@18.2.0");
    const contribZ = makeNodeId("Contributor", "", "hashZ");

    g.addNode({ id: fileA, kind: "File", name: "a.ts", filePath: "src/a.ts" });
    g.addNode({ id: fnA, kind: "Function", name: "alpha", filePath: "src/a.ts" });
    g.addNode({
      id: findingX,
      kind: "Finding",
      name: "X#1",
      filePath: "src/a.ts",
      ruleId: "X",
      severity: "error",
      scannerId: "s",
      message: "bad",
      propertiesBag: {},
    } as unknown as GraphNode);
    g.addNode({
      id: depY,
      kind: "Dependency",
      name: "react",
      filePath: "package-lock.json",
      version: "18.2.0",
      ecosystem: "npm",
      lockfileSource: "package-lock.json",
    } as unknown as GraphNode);
    g.addNode({
      id: contribZ,
      kind: "Contributor",
      name: "Z",
      filePath: "",
      emailHash: "hashZ",
    } as unknown as GraphNode);

    g.addEdge({ from: findingX, to: fileA, type: "FOUND_IN", confidence: 1.0 });
    g.addEdge({ from: fileA, to: depY, type: "DEPENDS_ON", confidence: 0.9 });
    g.addEdge({ from: fnA, to: contribZ, type: "OWNED_BY", confidence: 0.8 });

    await store.bulkLoad(g);

    const rows = await store.query(
      "SELECT type, COUNT(*) AS n FROM relations GROUP BY type ORDER BY type",
    );
    const byType = new Map<string, number>();
    for (const r of rows) byType.set(String(r["type"]), Number(r["n"]));
    assert.equal(byType.get("FOUND_IN"), 1);
    assert.equal(byType.get("DEPENDS_ON"), 1);
    assert.equal(byType.get("OWNED_BY"), 1);
    // COCHANGES must never appear in `relations` after the table split.
    assert.equal(byType.get("COCHANGES"), undefined);

    // Traversal must default-include the new types when no filter is passed.
    const down = await store.traverse({
      startId: findingX,
      direction: "down",
      maxDepth: 1,
    });
    assert.ok(
      down.some((r) => r.nodeId === fileA),
      "FOUND_IN edge must be reachable via default traverse()",
    );
  } finally {
    await store.close();
  }
});

test("bulkLoadCochanges: replaces rows and sorts insertion deterministically", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    await store.bulkLoadCochanges([
      {
        sourceFile: "src/a.ts",
        targetFile: "src/b.ts",
        cocommitCount: 10,
        totalCommitsSource: 20,
        totalCommitsTarget: 15,
        lastCocommitAt: "2026-01-01T00:00:00.000Z",
        lift: 2.5,
      },
      {
        sourceFile: "src/a.ts",
        targetFile: "src/c.ts",
        cocommitCount: 3,
        totalCommitsSource: 20,
        totalCommitsTarget: 30,
        lastCocommitAt: "2026-02-01T00:00:00.000Z",
        lift: 0.7,
      },
    ]);

    const rows = await store.query(
      "SELECT source_file, target_file, cocommit_count, lift FROM cochanges ORDER BY source_file, target_file",
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.["target_file"], "src/b.ts");
    assert.equal(rows[1]?.["target_file"], "src/c.ts");

    // Second bulk load fully replaces prior contents.
    await store.bulkLoadCochanges([
      {
        sourceFile: "src/x.ts",
        targetFile: "src/y.ts",
        cocommitCount: 2,
        totalCommitsSource: 4,
        totalCommitsTarget: 5,
        lastCocommitAt: "2026-03-01T00:00:00.000Z",
        lift: 5.0,
      },
    ]);
    const after = await store.query("SELECT source_file FROM cochanges");
    assert.equal(after.length, 1);
    assert.equal(after[0]?.["source_file"], "src/x.ts");
  } finally {
    await store.close();
  }
});

test("lookupCochangesForFile: ranks by lift and filters below minLift", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    await store.bulkLoadCochanges([
      {
        sourceFile: "src/a.ts",
        targetFile: "src/b.ts",
        cocommitCount: 8,
        totalCommitsSource: 10,
        totalCommitsTarget: 12,
        lastCocommitAt: "2026-01-01T00:00:00.000Z",
        lift: 3.2,
      },
      {
        sourceFile: "src/a.ts",
        targetFile: "src/c.ts",
        cocommitCount: 1,
        totalCommitsSource: 10,
        totalCommitsTarget: 50,
        lastCocommitAt: "2026-01-02T00:00:00.000Z",
        lift: 0.4,
      },
      {
        sourceFile: "src/d.ts",
        targetFile: "src/a.ts",
        cocommitCount: 5,
        totalCommitsSource: 7,
        totalCommitsTarget: 10,
        lastCocommitAt: "2026-01-03T00:00:00.000Z",
        lift: 1.8,
      },
    ]);

    const defaults = await store.lookupCochangesForFile("src/a.ts");
    // Defaults: minLift=1.0, drops the 0.4 row; sorted by lift DESC.
    assert.equal(defaults.length, 2);
    assert.equal(defaults[0]?.lift, 3.2);
    assert.equal(defaults[0]?.targetFile, "src/b.ts");
    assert.equal(defaults[1]?.sourceFile, "src/d.ts");

    const weak = await store.lookupCochangesForFile("src/a.ts", { minLift: 0 });
    assert.equal(weak.length, 3);

    const capped = await store.lookupCochangesForFile("src/a.ts", { limit: 1 });
    assert.equal(capped.length, 1);
    assert.equal(capped[0]?.targetFile, "src/b.ts");
  } finally {
    await store.close();
  }
});

test("lookupCochangesBetween: returns the row in either ordering", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoadCochanges([
      {
        sourceFile: "src/a.ts",
        targetFile: "src/b.ts",
        cocommitCount: 4,
        totalCommitsSource: 6,
        totalCommitsTarget: 6,
        lastCocommitAt: "2026-01-01T00:00:00.000Z",
        lift: 2.0,
      },
    ]);
    const forward = await store.lookupCochangesBetween("src/a.ts", "src/b.ts");
    const reverse = await store.lookupCochangesBetween("src/b.ts", "src/a.ts");
    assert.ok(forward);
    assert.ok(reverse);
    assert.equal(forward?.lift, 2.0);
    assert.equal(reverse?.lift, 2.0);

    const missing = await store.lookupCochangesBetween("src/a.ts", "src/zzz.ts");
    assert.equal(missing, undefined);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Symbol summaries
// ---------------------------------------------------------------------------

test("bulkLoadSymbolSummaries: inserts rows and supports single-row lookup", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "hash-a",
        promptVersion: "1",
        modelId: "anthropic.claude-haiku-4-5",
        summaryText: "Do the alpha thing.",
        signatureSummary: "(x: int) -> int",
        returnsTypeSummary: "the alpha count",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/b.ts:beta",
        contentHash: "hash-b",
        promptVersion: "1",
        modelId: "anthropic.claude-haiku-4-5",
        summaryText: "Do the beta thing.",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    const hit = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-a", "1");
    assert.ok(hit);
    assert.equal(hit?.summaryText, "Do the alpha thing.");
    assert.equal(hit?.signatureSummary, "(x: int) -> int");
    assert.equal(hit?.returnsTypeSummary, "the alpha count");

    // Cache miss on any slot of the composite key → undefined.
    const missHash = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-x", "1");
    assert.equal(missHash, undefined);
    const missPrompt = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-a", "2");
    assert.equal(missPrompt, undefined);
    const missNode = await store.lookupSymbolSummary("Function:src/a.ts:zeta", "hash-a", "1");
    assert.equal(missNode, undefined);
  } finally {
    await store.close();
  }
});

test("bulkLoadSymbolSummaries: re-insert on same composite key overwrites row", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "hash-a",
        promptVersion: "1",
        modelId: "m1",
        summaryText: "first",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "hash-a",
        promptVersion: "1",
        modelId: "m2",
        summaryText: "second",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    const hit = await store.lookupSymbolSummary("Function:src/a.ts:alpha", "hash-a", "1");
    assert.equal(hit?.summaryText, "second");
    assert.equal(hit?.modelId, "m2");
  } finally {
    await store.close();
  }
});

test("lookupSymbolSummariesByNode: returns rows for every requested node, ordered deterministically", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoadSymbolSummaries([
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "h1",
        promptVersion: "2",
        modelId: "m",
        summaryText: "alpha v2",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/a.ts:alpha",
        contentHash: "h1",
        promptVersion: "1",
        modelId: "m",
        summaryText: "alpha v1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/b.ts:beta",
        contentHash: "h2",
        promptVersion: "1",
        modelId: "m",
        summaryText: "beta",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        nodeId: "Function:src/c.ts:gamma",
        contentHash: "h3",
        promptVersion: "1",
        modelId: "m",
        summaryText: "gamma",
        createdAt: "2026-01-04T00:00:00.000Z",
      },
    ]);
    const hits = await store.lookupSymbolSummariesByNode([
      "Function:src/a.ts:alpha",
      "Function:src/b.ts:beta",
    ]);
    assert.equal(hits.length, 3);
    // Ordered by (node_id ASC, prompt_version ASC, content_hash ASC).
    assert.equal(hits[0]?.nodeId, "Function:src/a.ts:alpha");
    assert.equal(hits[0]?.promptVersion, "1");
    assert.equal(hits[1]?.nodeId, "Function:src/a.ts:alpha");
    assert.equal(hits[1]?.promptVersion, "2");
    assert.equal(hits[2]?.nodeId, "Function:src/b.ts:beta");

    const empty = await store.lookupSymbolSummariesByNode([]);
    assert.equal(empty.length, 0);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// UPSERT mode ( incremental indexing)
// ---------------------------------------------------------------------------

test("bulkLoad(mode=upsert): second batch overwrites overlap, preserves non-overlap", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    // Batch A: 4 functions in two files.
    const batchA = new KnowledgeGraph();
    const idA = makeNodeId("Function", "src/x.ts", "fnA");
    const idB = makeNodeId("Function", "src/x.ts", "fnB");
    const idC = makeNodeId("Function", "src/y.ts", "fnC");
    const idD = makeNodeId("Function", "src/y.ts", "fnD");
    batchA.addNode({
      id: idA,
      kind: "Function",
      name: "fnA",
      filePath: "src/x.ts",
      signature: "v1_A",
    });
    batchA.addNode({
      id: idB,
      kind: "Function",
      name: "fnB",
      filePath: "src/x.ts",
      signature: "v1_B",
    });
    batchA.addNode({
      id: idC,
      kind: "Function",
      name: "fnC",
      filePath: "src/y.ts",
      signature: "v1_C",
    });
    batchA.addNode({
      id: idD,
      kind: "Function",
      name: "fnD",
      filePath: "src/y.ts",
      signature: "v1_D",
    });
    await store.bulkLoad(batchA, { mode: "replace" });

    // Batch B: 50% overlap (fnB, fnC updated) + 50% new (fnE, fnF). UPSERT
    // must keep fnA + fnD intact and replace signature for fnB + fnC.
    const batchB = new KnowledgeGraph();
    batchB.addNode({
      id: idB,
      kind: "Function",
      name: "fnB",
      filePath: "src/x.ts",
      signature: "v2_B",
    });
    batchB.addNode({
      id: idC,
      kind: "Function",
      name: "fnC",
      filePath: "src/y.ts",
      signature: "v2_C",
    });
    const idE = makeNodeId("Function", "src/z.ts", "fnE");
    const idF = makeNodeId("Function", "src/z.ts", "fnF");
    batchB.addNode({
      id: idE,
      kind: "Function",
      name: "fnE",
      filePath: "src/z.ts",
      signature: "v2_E",
    });
    batchB.addNode({
      id: idF,
      kind: "Function",
      name: "fnF",
      filePath: "src/z.ts",
      signature: "v2_F",
    });
    await store.bulkLoad(batchB, { mode: "upsert" });

    const total = await store.query("SELECT COUNT(*) AS n FROM nodes");
    assert.equal(Number(total[0]?.["n"]), 6, "A-only + overlap-updated + B-only = 6 rows");

    const rows = await store.query(
      "SELECT id, signature FROM nodes WHERE kind = 'Function' ORDER BY id",
    );
    const sigById = new Map<string, string>();
    for (const r of rows) sigById.set(String(r["id"]), String(r["signature"]));
    assert.equal(sigById.get(idA), "v1_A", "non-overlap A-side row must be preserved");
    assert.equal(sigById.get(idD), "v1_D", "non-overlap A-side row must be preserved");
    assert.equal(sigById.get(idB), "v2_B", "overlap row must be updated to batch-B value");
    assert.equal(sigById.get(idC), "v2_C", "overlap row must be updated to batch-B value");
    assert.equal(sigById.get(idE), "v2_E", "new B-only row must be inserted");
    assert.equal(sigById.get(idF), "v2_F", "new B-only row must be inserted");
  } finally {
    await store.close();
  }
});

test("bulkLoad(mode=upsert): issue 8147 guard — duplicate ids in one batch keep last value", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();

    // KnowledgeGraph's addNode uses definedFieldCount for its own dedupe, so
    // to smuggle a true duplicate through to the adapter we build an ordered
    // node list manually with different field counts — the LAST occurrence
    // (with more fields) must win, matching the adapter's dedupeLastById.
    const graph = new KnowledgeGraph();
    const id = makeNodeId("Function", "src/dup.ts", "fnDup");
    // First addNode: signature v1 (stored because no existing node).
    graph.addNode({
      id,
      kind: "Function",
      name: "fnDup",
      filePath: "src/dup.ts",
      signature: "v1",
    });
    // Second addNode: richer field set → replaces the previous in the map.
    graph.addNode({
      id,
      kind: "Function",
      name: "fnDup",
      filePath: "src/dup.ts",
      signature: "v2",
      parameterCount: 3,
      isExported: true,
    });

    await store.bulkLoad(graph, { mode: "upsert" });
    const rows = await store.query("SELECT signature, parameter_count FROM nodes WHERE id = ?", [
      id,
    ]);
    assert.equal(rows.length, 1, "single row for duplicate id");
    assert.equal(rows[0]?.["signature"], "v2", "last occurrence wins on dedupe");
    assert.equal(Number(rows[0]?.["parameter_count"]), 3);
  } finally {
    await store.close();
  }
});

test("bulkLoad(mode=upsert): propertiesBag round-trips as JSON and languages as array", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const findingId = makeNodeId("Finding", "src/a.ts", "rule-a#1");
    const bag = { cwe: "CWE-79", nested: { score: 7.4 }, tags: ["xss", "http"] };
    g.addNode({
      id: findingId,
      kind: "Finding",
      name: "rule-a#1",
      filePath: "src/a.ts",
      ruleId: "rule-a",
      severity: "error",
      scannerId: "semgrep",
      message: "hi",
      propertiesBag: bag,
    } as unknown as GraphNode);

    const profileId = makeNodeId("ProjectProfile", "", "repo");
    g.addNode({
      id: profileId,
      kind: "ProjectProfile",
      name: "repo",
      filePath: "",
      languages: ["typescript", "python", "go"],
      frameworks: [],
      iacTypes: [],
      apiContracts: [],
      manifests: [],
      srcDirs: [],
    } as unknown as GraphNode);

    await store.bulkLoad(g, { mode: "upsert" });

    const frow = await store.query("SELECT properties_bag FROM nodes WHERE id = ?", [findingId]);
    assert.deepEqual(JSON.parse(String(frow[0]?.["properties_bag"])), bag);

    const prow = await store.query("SELECT languages_json FROM nodes WHERE id = ?", [profileId]);
    assert.deepEqual(JSON.parse(String(prow[0]?.["languages_json"])), [
      "typescript",
      "python",
      "go",
    ]);
  } finally {
    await store.close();
  }
});

test("setMeta / getMeta round-trips cacheHitRatio / cacheSizeBytes / lastCompaction", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const meta: StoreMeta = {
      schemaVersion: "1.1.0",
      lastCommit: "cafebabe",
      indexedAt: "2026-04-18T11:00:00Z",
      nodeCount: 10,
      edgeCount: 20,
      cacheHitRatio: 0.73,
      cacheSizeBytes: 1048576,
      lastCompaction: "2026-04-18T09:30:00Z",
    };
    await store.setMeta(meta);
    const readBack = await store.getMeta();
    assert.deepEqual(readBack, meta);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// v1.2 reserved columns (P08)
// ---------------------------------------------------------------------------

test("v1.2: reserved columns round-trip through nodes table", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.ts", "complex");
    // Callable carrying every v1.2 reserved column.
    g.addNode({
      id: funcId,
      kind: "Function",
      name: "complex",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 20,
      cyclomaticComplexity: 7,
      nestingDepth: 3,
      nloc: 15,
      halsteadVolume: 42.5,
      deadness: "live",
      coveragePercent: 0.83,
      coveredLinesJson: JSON.stringify([1, 2, 3, 5, 8, 13]),
    });
    const toolId = makeNodeId("Tool", "tools/echo.ts", "echo");
    g.addNode({
      id: toolId,
      kind: "Tool",
      name: "echo",
      filePath: "tools/echo.ts",
      toolName: "echo",
      inputSchemaJson: '{"properties":{"s":{"type":"string"}},"type":"object"}',
    });
    const findingId = makeNodeId("Finding", "src/a.ts", "semgrep:rule:5");
    g.addNode({
      id: findingId,
      kind: "Finding",
      name: "semgrep:rule",
      filePath: "src/a.ts",
      ruleId: "rule",
      severity: "error",
      scannerId: "semgrep",
      message: "boom",
      propertiesBag: {},
      startLine: 5,
      partialFingerprint: "ab".repeat(16),
      baselineState: "new",
      suppressedJson: '[{"kind":"external","justification":"accepted"}]',
    });
    await store.bulkLoad(g);

    const rows = await store.query(
      `SELECT id, cyclomatic_complexity, nesting_depth, nloc, halstead_volume,
              deadness, coverage_percent, covered_lines_json,
              input_schema_json, partial_fingerprint, baseline_state,
              suppressed_json
       FROM nodes
       WHERE id = ? OR id = ? OR id = ?
       ORDER BY id`,
      [findingId, funcId, toolId],
    );
    assert.equal(rows.length, 3);
    const byId = new Map(rows.map((r) => [String(r["id"]), r]));
    const funcRow = byId.get(funcId);
    const toolRow = byId.get(toolId);
    const findingRow = byId.get(findingId);
    assert.ok(funcRow && toolRow && findingRow);
    assert.equal(Number(funcRow["cyclomatic_complexity"]), 7);
    assert.equal(Number(funcRow["nesting_depth"]), 3);
    assert.equal(Number(funcRow["nloc"]), 15);
    assert.equal(Number(funcRow["halstead_volume"]), 42.5);
    assert.equal(funcRow["deadness"], "live");
    assert.equal(Number(funcRow["coverage_percent"]), 0.83);
    assert.equal(funcRow["covered_lines_json"], JSON.stringify([1, 2, 3, 5, 8, 13]));
    assert.equal(
      toolRow["input_schema_json"],
      '{"properties":{"s":{"type":"string"}},"type":"object"}',
    );
    assert.equal(findingRow["partial_fingerprint"], "ab".repeat(16));
    assert.equal(findingRow["baseline_state"], "new");
    assert.equal(findingRow["suppressed_json"], '[{"kind":"external","justification":"accepted"}]');
  } finally {
    await store.close();
  }
});

test("v1.2: nodes without reserved fields round-trip to NULL (v1.0-style graph)", async () => {
  const dbPath = await scratchDbPath();
  const writer = new DuckDbStore(dbPath);
  await writer.open();
  try {
    await writer.createSchema();
    const g = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.ts", "plain");
    g.addNode({
      id: funcId,
      kind: "Function",
      name: "plain",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 3,
    });
    await writer.bulkLoad(g);
  } finally {
    await writer.close();
  }

  // Reopen with a fresh adapter (mimics "v1.0 graph opened by v1.2 reader").
  const reader = new DuckDbStore(dbPath, { readOnly: true });
  await reader.open();
  try {
    const rows = await reader.query(
      `SELECT cyclomatic_complexity, nesting_depth, nloc, halstead_volume,
              deadness, coverage_percent, covered_lines_json,
              input_schema_json, partial_fingerprint, baseline_state,
              suppressed_json
       FROM nodes WHERE kind = 'Function'`,
    );
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.ok(r);
    for (const col of [
      "cyclomatic_complexity",
      "nesting_depth",
      "nloc",
      "halstead_volume",
      "deadness",
      "coverage_percent",
      "covered_lines_json",
      "input_schema_json",
      "partial_fingerprint",
      "baseline_state",
      "suppressed_json",
    ]) {
      assert.equal(r[col], null, `column ${col} must be NULL on a plain node`);
    }
  } finally {
    await reader.close();
  }
});

test("v1.2: dead-code hyphen verdict maps to underscored column value", async () => {
  const dbPath = await scratchDbPath();
  const store = new DuckDbStore(dbPath);
  await store.open();
  try {
    await store.createSchema();
    const g = new KnowledgeGraph();
    const funcId = makeNodeId("Function", "src/a.ts", "exported");
    // The analysis helper emits "unreachable-export" (hyphen); the column
    // schema and core-types enum use "unreachable_export" (underscore). The
    // adapter's normaliser must bridge the two forms.
    g.addNode({
      id: funcId,
      kind: "Function",
      name: "exported",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 3,
      // Cast through unknown because the in-memory graph tolerates the
      // hyphen form, but the persistent enum uses underscore.
      ...({ deadness: "unreachable-export" } as unknown as { deadness: "unreachable_export" }),
    });
    await store.bulkLoad(g);
    const rows = await store.query("SELECT deadness FROM nodes WHERE id = ?", [funcId]);
    assert.equal(rows[0]?.["deadness"], "unreachable_export");
  } finally {
    await store.close();
  }
});

test("v1.2: graphHash stays deterministic when reserved fields are populated", async () => {
  const g1 = new KnowledgeGraph();
  const g2 = new KnowledgeGraph();
  const funcId = makeNodeId("Function", "src/a.ts", "graphHashed");
  // Build two graphs with the SAME set of fields but declared in different
  // literal orders — canonical JSON must re-sort keys so both hashes agree.
  g1.addNode({
    id: funcId,
    kind: "Function",
    name: "graphHashed",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 10,
    cyclomaticComplexity: 4,
    halsteadVolume: 17.25,
    nestingDepth: 2,
    nloc: 8,
    deadness: "live",
    coveragePercent: 0.5,
    coveredLinesJson: JSON.stringify([1, 2]),
  });
  g2.addNode({
    id: funcId,
    kind: "Function",
    name: "graphHashed",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 10,
    // Different insertion order, same values.
    coveredLinesJson: JSON.stringify([1, 2]),
    coveragePercent: 0.5,
    deadness: "live",
    nloc: 8,
    nestingDepth: 2,
    halsteadVolume: 17.25,
    cyclomaticComplexity: 4,
  });
  assert.equal(graphHash(g1), graphHash(g2));

  // Re-hashing the same graph twice must produce a stable hex string.
  const h1 = graphHash(g1);
  const h2 = graphHash(g1);
  assert.equal(h1, h2);
  assert.ok(/^[0-9a-f]{64}$/.test(h1), "graphHash must be a 64-char hex sha256");
});
