import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
  CodeRelation,
  DependencyNode,
  FindingNode,
  GraphNode,
  NodeKind,
  NodeOfKind,
  RelationType,
  RepoNode,
  RouteNode,
} from "@opencodehub/core-types";
import type {
  BulkLoadStats,
  ConsumerProducerEdge,
  EmbeddingRow,
  GraphDialect,
  IGraphStore,
  SearchQuery,
  SearchResult,
  StoreMeta,
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
  readonly dialect: GraphDialect = "none";
  readonly calls: StubCall[] = [];
  results: SearchResult[] = [];

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async createSchema(): Promise<void> {}
  async bulkLoad(): Promise<BulkLoadStats> {
    return { nodeCount: 0, edgeCount: 0, durationMs: 0 };
  }
  async upsertEmbeddings(_rows: readonly EmbeddingRow[]): Promise<void> {}
  async listEmbeddingHashes(): Promise<Map<string, string>> {
    return new Map();
  }
  async *listEmbeddings(): AsyncIterable<EmbeddingRow> {}
  async listNodes(): Promise<readonly GraphNode[]> {
    return [];
  }
  async listNodesByEntryPoint(): Promise<readonly GraphNode[]> {
    return [];
  }
  async listNodesByName(): Promise<readonly GraphNode[]> {
    return [];
  }
  async listNodesByKind<K extends NodeKind>(_kind: K): Promise<readonly NodeOfKind<K>[]> {
    return [];
  }
  async listEdges(): Promise<readonly CodeRelation[]> {
    return [];
  }
  async listEdgesByType(): Promise<readonly CodeRelation[]> {
    return [];
  }
  async listFindings(): Promise<readonly FindingNode[]> {
    return [];
  }
  async listDependencies(): Promise<readonly DependencyNode[]> {
    return [];
  }
  async listRoutes(): Promise<readonly RouteNode[]> {
    return [];
  }
  async getRepoNode(): Promise<RepoNode | undefined> {
    return undefined;
  }
  async countNodesByKind(): Promise<Map<NodeKind, number>> {
    return new Map();
  }
  async countEdgesByType(): Promise<Map<RelationType, number>> {
    return new Map();
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
  async traverseAncestors(): Promise<readonly TraverseResult[]> {
    return [];
  }
  async traverseDescendants(): Promise<readonly TraverseResult[]> {
    return [];
  }
  async listConsumerProducerEdges(): Promise<readonly ConsumerProducerEdge[]> {
    return [];
  }
  async getMeta(): Promise<StoreMeta | undefined> {
    return undefined;
  }
  async setMeta(_meta: StoreMeta): Promise<void> {}
  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
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
