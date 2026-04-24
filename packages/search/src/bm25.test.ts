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
import { bm25Search } from "./bm25.js";

interface StubCall {
  readonly query: SearchQuery;
}

class StubStore implements IGraphStore {
  readonly calls: StubCall[] = [];
  results: SearchResult[] = [];

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
  async search(q: SearchQuery): Promise<readonly SearchResult[]> {
    this.calls.push({ query: q });
    return this.results;
  }
  async vectorSearch(_q: VectorQuery): Promise<readonly VectorResult[]> {
    return [];
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

describe("bm25Search", () => {
  it("forwards text + kinds + limit to the store search", async () => {
    const store = new StubStore();
    store.results = [{ nodeId: "n1", score: 5.5, filePath: "a.ts", name: "a", kind: "Function" }];
    const hits = await bm25Search(store, {
      text: "hello",
      kinds: ["Function", "Class"],
      limit: 20,
    });
    assert.equal(store.calls.length, 1);
    const call = store.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.query.text, "hello");
    assert.deepEqual(call.query.kinds, ["Function", "Class"]);
    assert.equal(call.query.limit, 20);
    assert.equal(hits.length, 1);
    const hit = hits[0];
    assert.ok(hit !== undefined);
    assert.equal(hit.nodeId, "n1");
    assert.equal(hit.score, 5.5);
    assert.equal(hit.kind, "Function");
  });

  it("applies the default limit when callers omit it", async () => {
    const store = new StubStore();
    await bm25Search(store, { text: "x" });
    const call = store.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.query.limit, 50);
  });

  it("omits the kinds filter when none is supplied", async () => {
    const store = new StubStore();
    await bm25Search(store, { text: "x" });
    const call = store.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.query.kinds, undefined);
  });

  it("copies rows defensively so mutating a returned hit doesn't touch the store", async () => {
    const store = new StubStore();
    store.results = [{ nodeId: "n1", score: 1, filePath: "a.ts", name: "a", kind: "Function" }];
    const hits = await bm25Search(store, { text: "x" });
    // Returned hit must be a new object, not a reference into store.results.
    const storeRow = store.results[0];
    assert.ok(storeRow !== undefined);
    const hit = hits[0];
    assert.ok(hit !== undefined);
    assert.notEqual(hit, storeRow);
  });
});
