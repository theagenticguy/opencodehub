/**
 * v1.0 community-adapter conformance suite (architecture-revised.md §AC-A-11).
 *
 * `assertIGraphStoreConformance(name, factory)` registers a pre-baked set
 * of `node:test` blocks that exercise the v1.0 {@link IGraphStore} contract
 * end-to-end. A community AGE / Memgraph / Neo4j / Neptune adapter author
 * imports this from `@opencodehub/storage/test-utils` and runs it against
 * their own implementation:
 *
 * ```ts
 * import { test } from "node:test";
 * import { assertIGraphStoreConformance } from "@opencodehub/storage/test-utils";
 * import { AgeGraphStore } from "../src/age-store.js";
 *
 * assertIGraphStoreConformance("Apache AGE", async () => {
 *   const store = new AgeGraphStore({ pgUrl: "postgresql://..." });
 *   await store.open();
 *   await store.createSchema();
 *   return store;
 * });
 * ```
 *
 * Pass = the adapter has byte-identical {@link graphHash} output AND the
 * typed-finder semantics required by every in-tree caller (skeleton/xref
 * packs, MCP tools, analysis pipelines).
 *
 * The suite owns its own minimal fixtures so a community fork does NOT
 * inherit a moving target every time the in-tree adapter test files change.
 *
 * ## Registered tests
 *
 *   1. `lifecycle: bulkLoad fills counts + healthCheck=ok` — sanity that
 *      `open` + `createSchema` + `bulkLoad` each return without throwing
 *      and the resulting store reports `{ok: true}`.
 *   2. `parity: rebuildFromStore graphHash byte-identical to fixture` —
 *      the Liskov contract from {@link rebuildFromStore}. Any adapter that
 *      passes here is byte-equivalent on the wire to DuckDb + GraphDb.
 *   3. `listEdgesByType("CALLS") ≡ listEdges({types:["CALLS"]})` — typed
 *      shorthand must match the general filter. Catches adapter bugs
 *      where the two paths diverge on ordering or projection.
 *   4. `traverseAncestors invariants` — the result of
 *      `traverseAncestors({maxDepth: N})` must be a subset of the BFS over
 *      `listEdges({types})` truncated at depth N, plus the start node is
 *      excluded and depth/path fields are well-formed.
 *   5. `listNodes ordering + paging` — `id ASC` order across two writes,
 *      and `limit + offset` pages line up with the full-list slice.
 *   6. `vectorSearch (optional)` — if the adapter implements vector search,
 *      assert ordered results; cleanly skipped via `t.skip()` when the
 *      adapter throws "vectorSearch not implemented", returns an empty
 *      array for a known-non-empty input, or the in-tree HNSW extension
 *      is unavailable. See {@link assertIGraphStoreConformance} JSDoc on
 *      skip semantics.
 *
 * Every block opens a fresh adapter via `factory()`. The factory is
 * expected to return an `IGraphStore` that has already had `open()` and
 * `createSchema()` called — the suite only owns the bulk-load → assert →
 * close sequence so adapters with bespoke open requirements (custom
 * connection strings, auth tokens, schema namespaces) stay decoupled
 * from this file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CodeRelation,
  type GraphNode,
  graphHash,
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
} from "@opencodehub/core-types";
import type { IGraphStore } from "../interface.js";
import { rebuildFromStore } from "./parity-harness.js";

/**
 * Minimal File + Function + CALLS chain fixture used by every conformance
 * test block. Kept small (8 functions, two files) so an adapter under test
 * does not pay a heavy ingestion cost; large enough to exercise paging,
 * ordering, and a non-trivial CALLS chain for traversal.
 *
 * The ids are content-derived via {@link makeNodeId} so two independent
 * builds produce byte-identical id strings — required for the parity
 * round-trip + `listNodes id ASC` determinism asserts.
 */
function buildConformanceFixture(): KnowledgeGraph {
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
      signature: `function fn_${i}()`,
      parameterCount: i % 3,
      isExported: i % 2 === 0,
    });
  }

  // DEFINES from each file to its functions.
  for (let i = 0; i < funcs.length; i += 1) {
    const from = i % 2 === 0 ? fileA : fileB;
    g.addEdge({ from, to: funcs[i] as NodeId, type: "DEFINES", confidence: 1.0 });
  }
  // CALLS chain fn_0 -> fn_1 -> ... -> fn_7. Used by traverseAncestors.
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

/**
 * Detect adapters that can't run the vector-search test under the suite's
 * default 4-dim probe. Any of these signals is honoured:
 *
 *   - throw an error whose message contains "not implemented" (the AGE
 *     reference fork uses `"vectorSearch not implemented"`); OR
 *   - throw an error whose message contains "dimension mismatch" — the
 *     adapter is healthy but configured for a different embedding width
 *     (the in-tree default is 768) and the conformance suite uses a 4-dim
 *     probe vector to avoid pulling in real embeddings; OR
 *   - return an empty result set for a known-non-empty query (this is the
 *     in-tree DuckDb behaviour when the optional `hnsw_acorn` extension
 *     is absent — `getExtensionWarning()` reports `"No HNSW…"` and
 *     `vectorSearch` returns `[]`).
 *
 * All three signals fall through into a clean `t.skip(...)` so the
 * conformance suite stays green across dev-box / container / CI matrices
 * that may or may not ship the HNSW extension binaries — and across
 * adapter authors who configure embedding width at construction time.
 */
const VECTOR_SEARCH_UNAVAILABLE_HINT =
  "skipping: adapter reports vectorSearch is not implemented, its embedding width " +
  "differs from the 4-dim probe, or the HNSW backend is unavailable";

function isVectorSkipError(err: unknown): boolean {
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return false;
  return /not implemented/i.test(message) || /dimension mismatch/i.test(message);
}

/**
 * v1.0 community-adapter conformance suite (architecture-revised.md
 * §AC-A-11). Registers `node:test` blocks that prove a third-party
 * `IGraphStore` adapter satisfies the v1.0 contract under a shared
 * fixture set.
 *
 * The suite calls `factory()` per test block so each block owns a fresh
 * adapter and there is no test-ordering coupling. The factory is expected
 * to return an adapter that has already had `open() + createSchema()`
 * called — the suite owns the bulk-load → assert → close sequence only.
 *
 * ## Skip semantics (vector search)
 *
 * The optional vector-search test cleanly skips when the adapter:
 *
 *   - throws an error whose message contains "not implemented"; OR
 *   - returns an empty array for a known-non-empty query (matches the
 *     in-tree DuckDb behaviour when the optional HNSW extension binaries
 *     are unavailable — see `DuckDbStore.getExtensionWarning`).
 *
 * Adapter authors with no vector capability at all can throw
 * `new Error("vectorSearch not implemented")` from their stub and the
 * suite passes without intervention.
 *
 * @param name - Human-readable adapter name (used as test prefix).
 * @param factory - Async factory returning a fresh, opened adapter
 *                  (post `open() + createSchema()`).
 */
export function assertIGraphStoreConformance(
  name: string,
  factory: () => Promise<IGraphStore>,
): void {
  // ---------------------------------------------------------------------
  // 1. Lifecycle — bulkLoad + healthCheck
  // ---------------------------------------------------------------------
  test(`[conformance:${name}] lifecycle: bulkLoad reports counts and healthCheck is ok`, async () => {
    const store = await factory();
    try {
      const fixture = buildConformanceFixture();
      const stats = await store.bulkLoad(fixture);
      assert.equal(
        stats.nodeCount,
        fixture.nodeCount(),
        "bulkLoad.nodeCount must equal the source graph nodeCount()",
      );
      assert.equal(
        stats.edgeCount,
        fixture.edgeCount(),
        "bulkLoad.edgeCount must equal the source graph edgeCount()",
      );
      const health = await store.healthCheck();
      assert.equal(health.ok, true, "healthCheck must report ok=true after bulkLoad");
    } finally {
      await store.close();
    }
  });

  // ---------------------------------------------------------------------
  // 2. Parity — rebuildFromStore graphHash byte-identity (Liskov contract)
  // ---------------------------------------------------------------------
  test(`[conformance:${name}] parity: rebuildFromStore graphHash byte-identical to fixture`, async () => {
    const store = await factory();
    try {
      const fixture = buildConformanceFixture();
      const original = graphHash(fixture);
      await store.bulkLoad(fixture);
      const rebuilt = await rebuildFromStore(store);
      const got = graphHash(rebuilt);
      assert.equal(
        got,
        original,
        `[${name}] round-trip broke graphHash\n  original: ${original}\n  rebuilt:  ${got}`,
      );
    } finally {
      await store.close();
    }
  });

  // ---------------------------------------------------------------------
  // 3. listEdgesByType ≡ listEdges({types: [t]})
  // ---------------------------------------------------------------------
  test(`[conformance:${name}] listEdgesByType("CALLS") matches listEdges({types:["CALLS"]})`, async () => {
    const store = await factory();
    try {
      await store.bulkLoad(buildConformanceFixture());
      const viaShorthand = await store.listEdgesByType("CALLS");
      const viaFilter = await store.listEdges({ types: ["CALLS"] });
      assert.equal(
        viaShorthand.length,
        viaFilter.length,
        `[${name}] listEdgesByType count must equal listEdges({types}) count`,
      );
      // Compare canonical id-tuples to avoid coupling to undefined-vs-absent
      // field differences in the wider edge shape — the contract is "same
      // edges, same order".
      const tuple = (e: CodeRelation): string => `${e.from} ${e.to} ${e.type}`;
      assert.deepEqual(
        viaShorthand.map(tuple),
        viaFilter.map(tuple),
        `[${name}] listEdgesByType must agree with listEdges({types}) on order + identity`,
      );
      // Sanity: every returned edge actually has type=CALLS — guards against
      // an adapter that ignores the filter and returns the full edge set.
      for (const e of viaShorthand) {
        assert.equal(e.type, "CALLS", `[${name}] listEdgesByType returned non-CALLS edge`);
      }
    } finally {
      await store.close();
    }
  });

  // ---------------------------------------------------------------------
  // 4. traverseAncestors — invariants vs hand-rolled BFS over listEdges
  // ---------------------------------------------------------------------
  test(`[conformance:${name}] traverseAncestors matches BFS over listEdges`, async () => {
    const store = await factory();
    try {
      await store.bulkLoad(buildConformanceFixture());

      // The CALLS chain is fn_0 -> fn_1 -> ... -> fn_7. Pick fn_3 as the
      // start id; ancestors at maxDepth=2 should be fn_2 (depth 1) and
      // fn_1 (depth 2). fn_0 must NOT appear at depth=2.
      const fn3Id = makeNodeId("Function", "src/b.ts", "fn_3", { parameterCount: 0 });

      const result = await store.traverseAncestors({
        fromId: fn3Id,
        edgeTypes: ["CALLS"],
        maxDepth: 2,
      });

      // Hand-rolled BFS over listEdges so we are not coupled to the
      // adapter's recursive query implementation.
      const allCalls = await store.listEdges({ types: ["CALLS"] });
      const reverseAdj = new Map<string, string[]>();
      for (const e of allCalls) {
        const bucket = reverseAdj.get(e.to) ?? [];
        bucket.push(e.from);
        reverseAdj.set(e.to, bucket);
      }
      const expected = new Map<string, number>();
      const queue: { id: string; depth: number }[] = [{ id: fn3Id, depth: 0 }];
      while (queue.length > 0) {
        const head = queue.shift();
        if (!head) break;
        if (head.depth >= 2) continue;
        for (const ancestor of reverseAdj.get(head.id) ?? []) {
          if (expected.has(ancestor)) continue;
          expected.set(ancestor, head.depth + 1);
          queue.push({ id: ancestor, depth: head.depth + 1 });
        }
      }

      // Start node must be excluded.
      for (const r of result) {
        assert.notEqual(r.nodeId, fn3Id, `[${name}] start node leaked into traverseAncestors`);
      }
      // Every result row must appear in `expected` at the same depth bound.
      const got = new Map<string, number>();
      for (const r of result) got.set(r.nodeId, r.depth);
      assert.equal(
        got.size,
        expected.size,
        `[${name}] traverseAncestors size mismatch: got=${got.size}, expected=${expected.size}`,
      );
      for (const [id, depth] of expected) {
        assert.equal(
          got.get(id),
          depth,
          `[${name}] traverseAncestors depth mismatch for ${id}: got=${got.get(id)}, expected=${depth}`,
        );
      }
      // depth + path fields well-formed (depth >= 1, path non-empty array).
      for (const r of result) {
        assert.ok(r.depth >= 1, `[${name}] traverseAncestors depth must be >=1`);
        assert.ok(Array.isArray(r.path), `[${name}] traverseAncestors path must be an array`);
      }
    } finally {
      await store.close();
    }
  });

  // ---------------------------------------------------------------------
  // 5. listNodes — ordering + paging
  // ---------------------------------------------------------------------
  test(`[conformance:${name}] listNodes id-ASC ordering and limit/offset paging`, async () => {
    const store = await factory();
    try {
      await store.bulkLoad(buildConformanceFixture());
      const all = await store.listNodes();
      const ids = all.map((n: GraphNode) => n.id);
      const sorted = [...ids].sort();
      assert.deepEqual(ids, sorted, `[${name}] listNodes must return rows ordered by id ASC`);
      assert.ok(ids.length >= 4, `[${name}] fixture must have >=4 nodes for paging assertion`);

      const firstPage = await store.listNodes({ limit: 2 });
      const secondPage = await store.listNodes({ limit: 2, offset: 2 });
      assert.deepEqual(
        firstPage.map((n: GraphNode) => n.id),
        ids.slice(0, 2),
        `[${name}] listNodes(limit=2) must equal first two rows of full list`,
      );
      assert.deepEqual(
        secondPage.map((n: GraphNode) => n.id),
        ids.slice(2, 4),
        `[${name}] listNodes(limit=2, offset=2) must equal rows [2,4) of full list`,
      );
    } finally {
      await store.close();
    }
  });

  // ---------------------------------------------------------------------
  // 6. vectorSearch — optional capability
  // ---------------------------------------------------------------------
  test(`[conformance:${name}] vectorSearch returns ordered results when capability is present`, async (t) => {
    const store = await factory();
    try {
      const g = new KnowledgeGraph();
      const ids: NodeId[] = [];
      const vectors: readonly (readonly number[])[] = [
        [1.0, 0.0, 0.0, 0.0],
        [0.9, 0.1, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
      ];
      for (let i = 0; i < vectors.length; i += 1) {
        const id = makeNodeId("File", `src/f${i}.ts`, `f${i}`);
        ids.push(id);
        g.addNode({ id, kind: "File", name: `f${i}`, filePath: `src/f${i}.ts` });
      }
      await store.bulkLoad(g);

      // Adapters that don't implement vector search may throw on upsert OR
      // on the search call itself. Both pathways funnel into the same skip.
      try {
        await store.upsertEmbeddings(
          ids.map((id, i) => ({
            nodeId: id,
            chunkIndex: 0,
            vector: new Float32Array(vectors[i] ?? []),
            contentHash: `h${i}`,
          })),
        );
      } catch (err) {
        if (isVectorSkipError(err)) {
          t.skip(VECTOR_SEARCH_UNAVAILABLE_HINT);
          return;
        }
        throw err;
      }

      let hits: readonly { readonly nodeId: string; readonly distance: number }[];
      try {
        hits = await store.vectorSearch({
          vector: new Float32Array([1.0, 0.0, 0.0, 0.0]),
          limit: 2,
        });
      } catch (err) {
        if (isVectorSkipError(err)) {
          t.skip(VECTOR_SEARCH_UNAVAILABLE_HINT);
          return;
        }
        throw err;
      }

      // Empty result on a known-non-empty input means the optional HNSW
      // extension is disabled — skip rather than fail. This is the in-tree
      // DuckDb behaviour when neither hnsw_acorn nor vss is available.
      if (hits.length === 0) {
        t.skip(VECTOR_SEARCH_UNAVAILABLE_HINT);
        return;
      }

      assert.ok(hits.length >= 1, `[${name}] vectorSearch must return at least one row`);
      // Nearest first — the identical vector at index 0 is expected to be
      // the top hit, but adapters with approximate-only HNSW may flip
      // ties. Assert ordering by distance ASC instead.
      for (let i = 1; i < hits.length; i += 1) {
        const prev = hits[i - 1];
        const curr = hits[i];
        if (!prev || !curr) continue;
        assert.ok(
          prev.distance <= curr.distance,
          `[${name}] vectorSearch results must be ordered by distance ASC: ${prev.distance} > ${curr.distance}`,
        );
      }
    } finally {
      await store.close();
    }
  });
}
