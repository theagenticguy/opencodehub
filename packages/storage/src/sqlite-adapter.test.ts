/**
 * Spike proof for {@link SqliteStore} (branch `spike/sqlite-single-file`).
 *
 * These tests are the de-risking evidence for the single-file thesis: that
 * ONE `*.sqlite` file in WAL mode, opened through Node's built-in
 * `node:sqlite` with zero native dependencies, can back the graph tier
 * (nodes, edges, traversal), the embedding tier (Float32Array vectors,
 * cosine KNN), and the temporal tier — replacing the lbug + DuckDB pair.
 *
 * The acceptance bar:
 *   - a real KnowledgeGraph bulk-loads and round-trips (nodes + edges) from
 *     one on-disk file across a close/reopen cycle;
 *   - embeddings survive as exact Float32 bytes and rank by cosine;
 *   - impact/blast-radius traversal works via recursive CTE (up + down);
 *   - the file is genuinely one file (no .lbug / .duckdb sidecars).
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type GraphNode,
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
  type RelationType,
} from "@opencodehub/core-types";

import { SqliteStore } from "./sqlite-adapter.js";

interface FixtureIds {
  readonly fileId: NodeId;
  readonly a: NodeId;
  readonly b: NodeId;
  readonly c: NodeId;
  readonly d: NodeId;
}

/** Build a small fixture: 1 file + 4 functions in a CALLS chain a→b→c, a→d. */
function fixtureGraph(): { graph: KnowledgeGraph; ids: FixtureIds } {
  const g = new KnowledgeGraph();
  const fileId = makeNodeId("File", "src/app.ts", "src/app.ts");
  g.addNode({ id: fileId, kind: "File", name: "app.ts", filePath: "src/app.ts" } as GraphNode);
  const mk = (fn: string): NodeId => {
    const id = makeNodeId("Function", "src/app.ts", fn);
    g.addNode({
      id,
      kind: "Function",
      name: fn,
      filePath: "src/app.ts",
      startLine: 1,
      signature: `function ${fn}()`,
    } as GraphNode);
    return id;
  };
  const a = mk("a");
  const b = mk("b");
  const c = mk("c");
  const d = mk("d");
  const calls = (from: NodeId, to: NodeId): void =>
    g.addEdge({ from, to, type: "CALLS" as RelationType, confidence: 1.0 });
  calls(a, b);
  calls(b, c);
  calls(a, d);
  return { graph: g, ids: { fileId, a, b, c, d } };
}

test("SqliteStore: graph + embeddings round-trip from ONE file across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "och-sqlite-spike-"));
  const dbPath = join(dir, "store.sqlite");
  try {
    const { graph, ids } = fixtureGraph();

    // ── Write phase ── (8-dim embeddings for a readable test; real default 768)
    const w = new SqliteStore(dbPath, { embeddingDim: 8 });
    await w.open();
    await w.createSchema();
    const stats = await w.bulkLoad(graph);
    assert.equal(stats.nodeCount, 5, "5 nodes loaded");
    assert.equal(stats.edgeCount, 3, "3 edges loaded");

    // 8-dim embeddings so the test is readable; real default is 768.
    const vec = (seed: number): Float32Array =>
      Float32Array.from({ length: 8 }, (_, i) => Math.sin(seed + i));
    await w.upsertEmbeddings([
      { nodeId: ids.a, chunkIndex: 0, vector: vec(0.0), contentHash: "h-a", granularity: "symbol" },
      { nodeId: ids.b, chunkIndex: 0, vector: vec(1.0), contentHash: "h-b", granularity: "symbol" },
      { nodeId: ids.c, chunkIndex: 0, vector: vec(2.0), contentHash: "h-c", granularity: "symbol" },
    ]);
    await w.close();

    // ── Prove it is literally ONE file (WAL/shm may exist transiently; no
    //    .lbug / .duckdb sidecar must ever appear). ──
    const files = await readdir(dir);
    const sidecars = files.filter((f) => f.endsWith(".lbug") || f.endsWith(".duckdb"));
    assert.deepEqual(sidecars, [], `no graph/temporal sidecars, saw: ${files.join(",")}`);

    // ── Read phase: fresh handle, read-only, over the same path ──
    const r = new SqliteStore(dbPath, { readOnly: true, embeddingDim: 8 });
    await r.open();

    // nodes survived with payload (signature lives in the JSON overflow column)
    const fnA = await r.getNode(ids.a);
    assert.equal(fnA?.kind, "Function");
    assert.equal(fnA?.name, "a");
    assert.equal((fnA as { signature?: string }).signature, "function a()");

    const all = await r.listNodes();
    assert.equal(all.length, 5, "all 5 nodes enumerable after reopen");

    // embeddings survived as exact f32 bytes
    const got = new Map<string, Float32Array>();
    for await (const row of r.listEmbeddings()) got.set(row.nodeId, row.vector);
    assert.equal(got.size, 3);
    assert.deepEqual(Array.from(got.get(ids.a)!), Array.from(vec(0.0)), "f32 bytes identical");

    // cosine KNN: query == a's vector → a ranks first with distance ~0
    const hits = await r.vectorSearch({ vector: vec(0.0), limit: 3 });
    assert.equal(hits[0]?.nodeId, ids.a, "self is nearest");
    assert.ok(hits[0]!.distance < 1e-6, "distance to self ~0");
    assert.ok(hits[0]!.distance <= hits[1]!.distance, "ordered by ascending distance");

    await r.close();
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
});

test("SqliteStore: recursive-CTE traversal does impact (up) + blast-radius (down)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "och-sqlite-spike-tr-"));
  const dbPath = join(dir, "store.sqlite");
  try {
    const { graph, ids } = fixtureGraph();
    const w = new SqliteStore(dbPath);
    await w.open();
    await w.createSchema();
    await w.bulkLoad(graph);

    // DOWN from a (callees, transitive): a→b→c and a→d  ⇒ {b,c,d}
    const down = await w.traverse({ startId: ids.a, direction: "down", maxDepth: 5 });
    assert.deepEqual(
      [...down.map((r) => r.nodeId)].sort(),
      [ids.b, ids.c, ids.d].sort(),
      "down reaches all transitive callees",
    );
    const cHit = down.find((r) => r.nodeId === ids.c);
    assert.equal(cHit?.depth, 2, "c is depth 2 (a→b→c)");
    assert.deepEqual(cHit?.path, [ids.a, ids.b, ids.c], "path is recorded a→b→c");

    // UP from c (callers, transitive = blast radius): c←b←a ⇒ {a,b}
    const up = await w.traverse({ startId: ids.c, direction: "up", maxDepth: 5 });
    assert.deepEqual(
      [...up.map((r) => r.nodeId)].sort(),
      [ids.a, ids.b].sort(),
      "up reaches all transitive callers (blast radius)",
    );

    // depth bound respected: maxDepth 1 from a ⇒ only direct {b,d}
    const shallow = await w.traverse({ startId: ids.a, direction: "down", maxDepth: 1 });
    assert.deepEqual(
      [...shallow.map((r) => r.nodeId)].sort(),
      [ids.b, ids.d].sort(),
      "maxDepth=1 yields only direct callees",
    );

    await w.close();
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
});
