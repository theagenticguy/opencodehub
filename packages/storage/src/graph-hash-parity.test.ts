/**
 * graphHash parity gate (spec 004 §AC-M3-4).
 *
 * Enforces the v1.0 roadmap's byte-identity invariant (validation constraint
 * #6) across both storage backends: for every fixture graph,
 *
 *   graphHash(graph)
 *     === graphHash(rebuildGraphFromDuckDb(duckStore))
 *     === graphHash(rebuildGraphFromGraphDb(graphDbStore))
 *
 * If these hashes diverge, one of the adapters dropped, reordered, or
 * coerced a field on the round-trip — which would silently break the
 * incremental re-index contract (T-M7-4) and the Reindex parity gate. This
 * file is the CI tripwire.
 *
 * Three fixtures exercise progressively larger shapes:
 *   - small:  ≤10 nodes, DEFINES + CALLS only (sanity shape).
 *   - medium: ~60 nodes with File / Class / Interface / Method /
 *             Contributor, mixing DEFINES / IMPLEMENTS / HAS_METHOD /
 *             CALLS / OWNED_BY so the v1.1 node + edge surface is visible.
 *   - large:  ≥500 nodes built as a long CALLS chain with shortcuts, plus
 *             a companion sweep that emits at least one edge for every
 *             entry in `getAllRelationTypes()` (24 kinds as of AC-M3-3).
 *
 * Step-zero contract (per AC-M3-3 work log): the DuckDB column is
 * `INTEGER NOT NULL DEFAULT 0`, while the graph-db column is nullable
 * `INT32`. When an edge's step is explicitly `0`, the two backends disagree
 * on readback (DuckDB returns 0, graph-db returns null). Both readers in
 * this file therefore normalise to the "drop step when it reads back as
 * zero/null" convention — mirroring `duckdb-adapter.test.ts` — so the
 * symmetric round-trip is byte-identical across backends. Fixtures avoid
 * `step: 0` anyway to keep the original-graph comparison clean.
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
import { DuckDbStore } from "./duckdb-adapter.js";
import { GraphDbStore } from "./graphdb-adapter.js";
import { getAllRelationTypes } from "./graphdb-schema.js";

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
// nullable INT32 stores 0; both readers below drop step-when-zero so the
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

// ---------------------------------------------------------------------------
// Read-back helpers — one per backend. Both drop `step` when the stored
// value is 0 (NOT NULL default in DuckDB, null in graph-db) so the rebuilt
// graphs hash identically across backends even when an edge carries an
// explicit zero in the store.
// ---------------------------------------------------------------------------

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
  ["email_hash", "emailHash", "string"],
  ["email_plain", "emailPlain", "string"],
  // Repo (AC-M6-1) — each string column round-trips verbatim. Nullable
  // fields on the interface (originUrl / defaultBranch / group) are written
  // as SQL NULL, so the reconstructed node gets the field re-attached as
  // `null` below when we see the row is a Repo. Standalone `applyNodeColumns`
  // skips NULLs here; Repo-specific nullable reconstruction happens in
  // `applyRepoNullables`.
  ["origin_url", "originUrl", "string"],
  ["repo_uri", "repoUri", "string"],
  ["default_branch", "defaultBranch", "string"],
  ["commit_sha", "commitSha", "string"],
  ["index_time", "indexTime", "string"],
  ["repo_group", "group", "string"],
  ["visibility", "visibility", "string"],
  ["indexer", "indexer", "string"],
];

/**
 * RepoNode carries three nullable-string fields. `applyNodeColumns` drops
 * null/undefined so a Repo row comes back without them, which breaks
 * canonical-JSON parity because the original fixture carries explicit
 * `null`. Re-attach them here for Repo rows only.
 */
function applyRepoNullables(rec: Record<string, unknown>, base: Record<string, unknown>): void {
  if (base["kind"] !== "Repo") return;
  for (const [col, key] of [
    ["origin_url", "originUrl"],
    ["default_branch", "defaultBranch"],
    ["repo_group", "group"],
  ] as const) {
    const v = rec[col];
    if (v === null || v === undefined) base[key] = null;
  }
  // languageStats is a JSON object, not a scalar column.
  const statsRaw = rec["language_stats_json"];
  if (typeof statsRaw === "string" && statsRaw.length > 0) {
    base["languageStats"] = JSON.parse(statsRaw);
  } else {
    base["languageStats"] = {};
  }
}

function applyNodeColumns(
  rec: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  for (const [col, key, ty] of NODE_COLUMN_MAP) {
    const v = rec[col];
    if (v === null || v === undefined) continue;
    if (ty === "number") base[key] = Number(v);
    else if (ty === "boolean") base[key] = Boolean(v);
    else base[key] = String(v);
  }
  return base;
}

async function rebuildFromDuckDb(store: DuckDbStore): Promise<KnowledgeGraph> {
  const nodeRows = await store.query(
    `SELECT id, kind, name, file_path, start_line, end_line, is_exported, signature,
            parameter_count, return_type, declared_type, owner, content_hash,
            email_hash, email_plain,
            origin_url, repo_uri, default_branch, commit_sha, index_time,
            repo_group, visibility, indexer, language_stats_json
     FROM nodes ORDER BY id`,
  );
  const edgeRows = await store.query(
    "SELECT id, from_id, to_id, type, confidence, reason, step FROM relations ORDER BY id",
  );
  const g = new KnowledgeGraph();
  for (const row of nodeRows) {
    const rec = row as Record<string, unknown>;
    const base: Record<string, unknown> = {
      id: String(rec["id"]),
      kind: String(rec["kind"]),
      name: String(rec["name"] ?? ""),
      filePath: String(rec["file_path"] ?? ""),
    };
    applyNodeColumns(rec, base);
    applyRepoNullables(rec, base);
    g.addNode(base as unknown as GraphNode);
  }
  for (const row of edgeRows) {
    const step = Number(row["step"] ?? 0);
    g.addEdge({
      from: String(row["from_id"]) as NodeId,
      to: String(row["to_id"]) as NodeId,
      type: row["type"] as RelationType,
      confidence: Number(row["confidence"] ?? 0),
      ...(row["reason"] !== null && row["reason"] !== undefined && row["reason"] !== ""
        ? { reason: String(row["reason"]) }
        : {}),
      ...(step !== 0 ? { step } : {}),
    });
  }
  return g;
}

async function rebuildFromGraphDb(store: GraphDbStore): Promise<KnowledgeGraph> {
  const nodeRows = await store.query(
    `MATCH (n:CodeNode) RETURN n.id AS id, n.kind AS kind, n.name AS name, ` +
      `n.file_path AS file_path, n.start_line AS start_line, n.end_line AS end_line, ` +
      `n.is_exported AS is_exported, n.signature AS signature, ` +
      `n.parameter_count AS parameter_count, n.return_type AS return_type, ` +
      `n.declared_type AS declared_type, n.owner AS owner, ` +
      `n.content_hash AS content_hash, n.email_hash AS email_hash, ` +
      `n.email_plain AS email_plain, ` +
      `n.origin_url AS origin_url, n.repo_uri AS repo_uri, ` +
      `n.default_branch AS default_branch, n.commit_sha AS commit_sha, ` +
      `n.index_time AS index_time, n.repo_group AS repo_group, ` +
      `n.visibility AS visibility, n.indexer AS indexer, ` +
      `n.language_stats_json AS language_stats_json ORDER BY n.id`,
  );

  const g = new KnowledgeGraph();
  for (const row of nodeRows) {
    const rec = row as Record<string, unknown>;
    const base: Record<string, unknown> = {
      id: String(rec["id"]),
      kind: String(rec["kind"]),
      name: String(rec["name"] ?? ""),
      filePath: String(rec["file_path"] ?? ""),
    };
    applyNodeColumns(rec, base);
    applyRepoNullables(rec, base);
    g.addNode(base as unknown as GraphNode);
  }

  // Mirror DuckDB's step-zero drop so the two rebuilt graphs are symmetric
  // when an edge's stored step is 0/null (AC-M3-3 sentinel contract).
  for (const kind of getAllRelationTypes()) {
    const edgeRows = await store.query(
      `MATCH (a:CodeNode)-[r:${kind}]->(b:CodeNode) ` +
        `RETURN a.id AS from_id, b.id AS to_id, ` +
        `r.id AS edge_id, r.confidence AS confidence, ` +
        `r.reason AS reason, r.step AS step ORDER BY r.id`,
    );
    for (const row of edgeRows) {
      const rec = row as Record<string, unknown>;
      const reason = rec["reason"];
      const stepRaw = rec["step"];
      const step = stepRaw === null || stepRaw === undefined ? 0 : Number(stepRaw);
      g.addEdge({
        from: String(rec["from_id"]) as NodeId,
        to: String(rec["to_id"]) as NodeId,
        type: kind as RelationType,
        confidence: Number(rec["confidence"] ?? 0),
        ...(reason !== null && reason !== undefined && reason !== ""
          ? { reason: String(reason) }
          : {}),
        ...(step !== 0 ? { step } : {}),
      });
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Round-trip runners
// ---------------------------------------------------------------------------

async function duckHash(fixture: KnowledgeGraph): Promise<string> {
  const store = new DuckDbStore(await scratchDuckPath());
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoad(fixture);
    const rebuilt = await rebuildFromDuckDb(store);
    return graphHash(rebuilt);
  } finally {
    await store.close();
  }
}

async function graphDbHash(fixture: KnowledgeGraph): Promise<string> {
  const store = new GraphDbStore(await scratchGraphDbPath());
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoad(fixture);
    const rebuilt = await rebuildFromGraphDb(store);
    return graphHash(rebuilt);
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// Parity assertion
// ---------------------------------------------------------------------------

interface ParityCheck {
  readonly name: string;
  readonly fixture: KnowledgeGraph;
}

async function assertParity({ name, fixture }: ParityCheck): Promise<void> {
  const original = graphHash(fixture);
  const duck = await duckHash(fixture);
  assert.equal(
    duck,
    original,
    `[${name}] DuckDbStore round-trip broke graphHash\n` +
      `  original: ${original}\n` +
      `  duck:     ${duck}`,
  );

  // Graph-db branch runs only when the native binding is importable — CI
  // platforms without a prebuilt binary skip cleanly rather than fail.
  if (!(await hasGraphDbBinding())) {
    return;
  }

  const graphDb = await graphDbHash(fixture);
  assert.equal(
    graphDb,
    original,
    `[${name}] GraphDbStore round-trip broke graphHash\n` +
      `  original: ${original}\n` +
      `  graphdb:  ${graphDb}`,
  );
  // Transitive check so a future regression surfaces as the parity message
  // even if one backend happened to match the original by coincidence.
  assert.equal(
    graphDb,
    duck,
    `[${name}] cross-backend parity broken — DuckDbStore vs GraphDbStore\n` +
      `  duck:    ${duck}\n` +
      `  graphdb: ${graphDb}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("graphHash parity: small fixture (≤10 nodes, DEFINES + CALLS)", async () => {
  await assertParity({ name: "small", fixture: buildSmallFixture() });
});

test("graphHash parity: medium fixture (mixed node kinds + OWNED_BY edges)", async () => {
  await assertParity({ name: "medium", fixture: buildMediumFixture() });
});

test("graphHash parity: large fixture (≥500 nodes, 24-edge-kind sweep)", async () => {
  await assertParity({ name: "large", fixture: buildLargeFixture() });
});

/**
 * AC-M6-1 addition: a fixture that includes a RepoNode exercising every
 * field — populated + explicit-null variants of `originUrl` / `defaultBranch`
 * / `group`, and a non-empty `languageStats` record. The fixture must
 * round-trip through both stores with matching graphHash, proving the new
 * Repo columns carry their payload losslessly.
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

test("graphHash parity: repo fixture (RepoNode with all attributes populated)", async () => {
  await assertParity({ name: "repo", fixture: buildRepoFixture() });
});

test("graphHash parity: repo fixture with explicit-null origin / branch / group", async () => {
  await assertParity({ name: "repo-null", fixture: buildRepoNullFixture() });
});
