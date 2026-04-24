import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
  BulkLoadStats,
  CochangeRow,
  EmbeddingRow,
  IGraphStore,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  SymbolSummaryRow,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { hybridSearch } from "./hybrid.js";
import type { Embedder } from "./types.js";

class StubStore implements IGraphStore {
  searchRows: SearchResult[] = [];
  vectorRows: VectorResult[] = [];
  searchCalls = 0;
  vectorCalls = 0;

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async createSchema(): Promise<void> {}
  async bulkLoad(): Promise<BulkLoadStats> {
    return { nodeCount: 0, edgeCount: 0, durationMs: 0 };
  }
  async upsertEmbeddings(_rows: readonly EmbeddingRow[]): Promise<void> {}
  async query(
    _sql: string,
    _params?: readonly SqlParam[],
    _opts?: { readonly timeoutMs?: number },
  ): Promise<readonly Record<string, unknown>[]> {
    return [];
  }
  async search(_q: SearchQuery): Promise<readonly SearchResult[]> {
    this.searchCalls += 1;
    return this.searchRows;
  }
  async vectorSearch(_q: VectorQuery): Promise<readonly VectorResult[]> {
    this.vectorCalls += 1;
    return this.vectorRows;
  }
  async traverse(_q: TraverseQuery): Promise<readonly TraverseResult[]> {
    return [];
  }
  async getMeta(): Promise<StoreMeta | undefined> {
    return undefined;
  }
  async setMeta(_meta: StoreMeta): Promise<void> {}
  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
  async bulkLoadCochanges(_rows: readonly CochangeRow[]): Promise<void> {}
  async lookupCochangesForFile(): Promise<readonly CochangeRow[]> {
    return [];
  }
  async lookupCochangesBetween(): Promise<CochangeRow | undefined> {
    return undefined;
  }
  async bulkLoadSymbolSummaries(_rows: readonly SymbolSummaryRow[]): Promise<void> {}
  async lookupSymbolSummary(): Promise<SymbolSummaryRow | undefined> {
    return undefined;
  }
  async lookupSymbolSummariesByNode(): Promise<readonly SymbolSummaryRow[]> {
    return [];
  }
}

class FakeEmbedder implements Embedder {
  readonly dim = 4;
  async embed(): Promise<Float32Array> {
    return new Float32Array([0.1, 0.2, 0.3, 0.4]);
  }
}

describe("hybridSearch", () => {
  it("returns BM25 hits tagged sources=['bm25'] when no embedder is supplied", async () => {
    const store = new StubStore();
    store.searchRows = [
      { nodeId: "a", score: 5, filePath: "a.ts", name: "a", kind: "Function" },
      { nodeId: "b", score: 4, filePath: "b.ts", name: "b", kind: "Function" },
    ];
    const fused = await hybridSearch(store, { text: "hello" });
    assert.equal(store.searchCalls, 1);
    assert.equal(store.vectorCalls, 0);
    assert.equal(fused.length, 2);
    const first = fused[0];
    assert.ok(first !== undefined);
    assert.equal(first.nodeId, "a");
    assert.deepEqual(first.sources, ["bm25"]);
  });

  it("fuses BM25 + ANN hits via RRF when an embedder is supplied", async () => {
    const store = new StubStore();
    store.searchRows = [
      { nodeId: "a", score: 5, filePath: "a.ts", name: "a", kind: "Function" },
      { nodeId: "b", score: 4, filePath: "b.ts", name: "b", kind: "Function" },
    ];
    store.vectorRows = [
      { nodeId: "b", distance: 0.1 },
      { nodeId: "c", distance: 0.2 },
    ];
    const fused = await hybridSearch(store, { text: "x" }, new FakeEmbedder());
    assert.equal(store.searchCalls, 1);
    assert.equal(store.vectorCalls, 1);
    // Expect a, b, c in fused output; b has contributions from both.
    const ids = fused.map((h) => h.nodeId);
    assert.deepEqual(ids.sort(), ["a", "b", "c"]);
    const byId = new Map(fused.map((h) => [h.nodeId, h]));
    const b = byId.get("b");
    assert.ok(b !== undefined);
    assert.deepEqual([...b.sources].sort(), ["bm25", "vector"]);
    const a = byId.get("a");
    assert.ok(a !== undefined);
    assert.deepEqual(a.sources, ["bm25"]);
    const c = byId.get("c");
    assert.ok(c !== undefined);
    assert.deepEqual(c.sources, ["vector"]);
  });

  it("ranks the dual-source node higher than singletons at the same input rank", async () => {
    const store = new StubStore();
    store.searchRows = [
      { nodeId: "x", score: 1, filePath: "x.ts", name: "x", kind: "Function" },
      { nodeId: "y", score: 1, filePath: "y.ts", name: "y", kind: "Function" },
    ];
    store.vectorRows = [
      { nodeId: "x", distance: 0.5 },
      { nodeId: "z", distance: 0.6 },
    ];
    const fused = await hybridSearch(store, { text: "q" }, new FakeEmbedder());
    assert.equal(fused[0]?.nodeId, "x", "dual-source node ranks first");
  });

  it("still runs vectorSearch when BM25 returns nothing, provided the embedder is present", async () => {
    const store = new StubStore();
    store.searchRows = [];
    store.vectorRows = [{ nodeId: "only", distance: 0.1 }];
    const fused = await hybridSearch(store, { text: "q" }, new FakeEmbedder());
    assert.equal(store.vectorCalls, 1);
    assert.equal(fused.length, 1);
    assert.equal(fused[0]?.nodeId, "only");
    assert.deepEqual(fused[0]?.sources, ["vector"]);
  });
});
