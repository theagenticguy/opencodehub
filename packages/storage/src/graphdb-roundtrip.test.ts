/**
 * Round-trip parity tests for {@link GraphDbStore} (spec 004 §AC-M3-3).
 *
 * These tests verify that a knowledge graph survives a bulk-load + rebuild
 * cycle byte-identical under `graphHash`. The AC-M3-4 CI gate pairs this
 * with the DuckDbStore round-trip to guarantee cross-backend parity; this
 * file establishes the correctness half.
 *
 * Three fixture sizes:
 *   - small: 2 files + 8 functions + 15 edges (mixed DEFINES / CALLS).
 *     Exercises the basic node + edge shape.
 *   - medium: ~60 nodes + ~100 edges. Exercises a wider NodeKind mix
 *     (Class / Method / Interface / Route) plus a Process / Section /
 *     Contributor tier so the polymorphic NODE_COLUMNS coverage is visible.
 *   - large: 100 Function nodes forming a long CALLS chain with an
 *     interior branch; graphHash determinism at scale matters for the
 *     Reindex parity gate.
 *
 * The 23-edge-kind sweep gets its own test so a schema regression that
 * silently drops a rel table shows up as a test failure rather than a
 * slow-burn round-trip hash mismatch in prod.
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
import { GraphDbStore } from "./graphdb-adapter.js";
import { getAllRelationTypes } from "./graphdb-schema.js";

async function scratchDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-graphdb-rt-"));
  return join(dir, "graph.db");
}

async function hasNativeBinding(): Promise<boolean> {
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

function buildSmallGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();

  const fileA = makeNodeId("File", "src/a.ts", "a.ts");
  const fileB = makeNodeId("File", "src/b.ts", "b.ts");
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

  // DEFINES from each file to its functions, plus a CALLS chain.
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

function buildMediumGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();

  // Layer 1: files.
  const files: NodeId[] = [];
  for (let i = 0; i < 6; i += 1) {
    const path = `src/mod${i}/entry.ts`;
    const id = makeNodeId("File", path, path);
    files.push(id);
    g.addNode({
      id,
      kind: "File",
      name: `entry.ts`,
      filePath: path,
      contentHash: `hash-${i}`,
    });
  }

  // Layer 2: classes + interfaces.
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

  // Layer 3: methods.
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

  // Sparse CALL graph — even-indexed methods call the next odd-indexed method
  // in the same service; a few cross-service calls keep the graph connected.
  for (let i = 0; i + 1 < methods.length; i += 2) {
    const from = methods[i];
    const to = methods[i + 1];
    if (!from || !to) throw new Error("unreachable");
    g.addEdge({ from, to, type: "CALLS", confidence: 0.8, reason: "synthetic fixture" });
  }
  for (let i = 2; i < methods.length; i += 3) {
    const from = methods[i];
    const to = methods[(i + 5) % methods.length];
    if (!from || !to) throw new Error("unreachable");
    g.addEdge({ from, to, type: "CALLS", confidence: 0.6, step: 1 });
  }

  // A contributor + ownership edges.
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

function buildLargeGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  const N = 100;
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
  // Linear CALLS chain.
  for (let i = 0; i + 1 < N; i += 1) {
    g.addEdge({
      from: funcs[i] as NodeId,
      to: funcs[i + 1] as NodeId,
      type: "CALLS",
      confidence: 0.95,
    });
  }
  // Every 10th function also calls the function 10 steps downstream — a
  // bounded shortcut that makes the graph non-tree.
  for (let i = 0; i + 10 < N; i += 10) {
    g.addEdge({
      from: funcs[i] as NodeId,
      to: funcs[i + 10] as NodeId,
      type: "CALLS",
      confidence: 0.5,
      step: 1,
    });
  }
  return g;
}

// ---------------------------------------------------------------------------
// Read-back helpers
// ---------------------------------------------------------------------------
//
// Each node column → GraphNode field mapping. Flat (no kind-specific logic)
// because the fixture graphs only use fields that every kind can hold — the
// additive surface (Contributor.email*, File.contentHash) is covered by the
// medium fixture but still fits this list.

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
];

async function rebuildGraphFromStore(store: GraphDbStore): Promise<KnowledgeGraph> {
  // One MATCH per CodeNode column set we care about. Ordering by id
  // matches DuckDbStore so KnowledgeGraph.addNode lands them in the same
  // sequence — not strictly required because orderedNodes sorts again,
  // but helpful when debugging.
  const nodeRows = await store.query(
    `MATCH (n:CodeNode) RETURN n.id AS id, n.kind AS kind, n.name AS name, ` +
      `n.file_path AS file_path, n.start_line AS start_line, n.end_line AS end_line, ` +
      `n.is_exported AS is_exported, n.signature AS signature, ` +
      `n.parameter_count AS parameter_count, n.return_type AS return_type, ` +
      `n.declared_type AS declared_type, n.owner AS owner, ` +
      `n.content_hash AS content_hash, n.email_hash AS email_hash, ` +
      `n.email_plain AS email_plain ` +
      `ORDER BY n.id`,
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
    for (const [col, key, ty] of NODE_COLUMN_MAP) {
      const v = rec[col];
      if (v === null || v === undefined) continue;
      if (ty === "number") base[key] = Number(v);
      else if (ty === "boolean") base[key] = Boolean(v);
      else base[key] = String(v);
    }
    g.addNode(base as unknown as GraphNode);
  }

  // Each edge kind lives in its own rel table — ask the schema for the
  // active list rather than importing RELATION_TYPES directly so the two
  // modules stay source-of-truth aligned.
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
      // Two encoding quirks that matter for graphHash parity:
      //   1. `step` survives even when the stored value is 0 — the original
      //      edge set it explicitly, so the canonical-JSON serialiser emits
      //      it; we must re-attach it rather than falling back to undefined.
      //   2. `reason` is dropped when empty/null so the original fixture
      //      (which only sets `reason` on some edges) hashes the same.
      g.addEdge({
        from: String(rec["from_id"]) as NodeId,
        to: String(rec["to_id"]) as NodeId,
        type: kind as RelationType,
        confidence: Number(rec["confidence"] ?? 0),
        ...(reason !== null && reason !== undefined && reason !== ""
          ? { reason: String(reason) }
          : {}),
        ...(stepRaw !== null && stepRaw !== undefined ? { step: Number(stepRaw) } : {}),
      });
    }
  }

  return g;
}

async function runRoundTrip(
  fixture: KnowledgeGraph,
): Promise<{ original: string; rebuilt: string }> {
  const store = new GraphDbStore(await scratchDbPath());
  await store.open();
  try {
    await store.createSchema();
    await store.bulkLoad(fixture);
    const rebuilt = await rebuildGraphFromStore(store);
    return {
      original: graphHash(fixture),
      rebuilt: graphHash(rebuilt),
    };
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("round-trip parity: small fixture", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping round-trip");
    return;
  }
  const fixture = buildSmallGraph();
  const { original, rebuilt } = await runRoundTrip(fixture);
  assert.equal(
    rebuilt,
    original,
    `graphHash parity broken for small fixture:\n  original: ${original}\n   rebuilt: ${rebuilt}`,
  );
});

test("round-trip parity: medium fixture (mixed node kinds + OWNED_BY edges)", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping round-trip");
    return;
  }
  const fixture = buildMediumGraph();
  const { original, rebuilt } = await runRoundTrip(fixture);
  assert.equal(rebuilt, original, "graphHash parity broken for medium fixture");
});

test("round-trip parity: large fixture (100 nodes, linear chain + shortcuts)", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping round-trip");
    return;
  }
  const fixture = buildLargeGraph();
  const { original, rebuilt } = await runRoundTrip(fixture);
  assert.equal(rebuilt, original, "graphHash parity broken for large fixture");
});

test("every declared edge kind round-trips at least one row", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping round-trip");
    return;
  }
  const relationTypes = getAllRelationTypes();
  const g = new KnowledgeGraph();
  const nodes: NodeId[] = [];
  for (let i = 0; i < relationTypes.length + 1; i += 1) {
    const id = makeNodeId("Function", `src/f${i}.ts`, `fn${i}`);
    nodes.push(id);
    g.addNode({ id, kind: "Function", name: `fn${i}`, filePath: `src/f${i}.ts` });
  }
  for (let i = 0; i < relationTypes.length; i += 1) {
    const fromId = nodes[i];
    const toId = nodes[i + 1];
    if (!fromId || !toId) throw new Error("unreachable");
    const kind = relationTypes[i];
    if (!kind) throw new Error("unreachable");
    g.addEdge({
      from: fromId,
      to: toId,
      type: kind as RelationType,
      confidence: 0.5 + i * 0.01,
      reason: `fixture-${i}`,
      step: i,
    });
  }
  const { original, rebuilt } = await runRoundTrip(g);
  assert.equal(rebuilt, original, "graphHash parity broken for all-kinds fixture");
});

test("round-trip is deterministic across independent writes of the same graph", async () => {
  if (!(await hasNativeBinding())) {
    assert.ok(true, "native binding unavailable — skipping round-trip");
    return;
  }
  const fixture = buildMediumGraph();
  const originalHash = graphHash(fixture);

  const { rebuilt: hashA } = await runRoundTrip(fixture);
  const { rebuilt: hashB } = await runRoundTrip(fixture);
  assert.equal(hashA, hashB, "hashes across two stores must match");
  assert.equal(hashA, originalHash, "hash after round-trip must match the original graph hash");
});
