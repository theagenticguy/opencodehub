import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
  CodeRelation,
  DependencyNode,
  FileNode,
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
  ListNodesByKindOptions,
  SearchQuery,
  SearchResult,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { hybridSearch } from "./hybrid.js";
import type { Embedder } from "./types.js";

class StubStore implements IGraphStore {
  readonly dialect: GraphDialect = "cypher";
  searchRows: SearchResult[] = [];
  vectorRows: VectorResult[] = [];
  /**
   * Per-tier vector rows (P03 zoom tests). When set, the stub returns
   * `vectorRowsByTier[q.granularity]` instead of `vectorRows`. Missing
   * keys collapse to an empty array. Use `"unfiltered"` for queries that
   * did not pass a granularity filter.
   */
  vectorRowsByTier: Record<string, readonly VectorResult[]> = {};
  /** Captured vector queries so tests can assert on the tier + filter shape. */
  vectorQueries: VectorQuery[] = [];
  /**
   * Fixture File-node rows the zoom path resolves through `listNodesByKind('File')`.
   * The pre-typed-finder shape captured raw `{id, file_path}` query
   * rows; the typed shape is the FileNode contract — `id` + `filePath`.
   */
  fileNodes: FileNode[] = [];
  /** Captured `listNodesByKind` calls so tests can assert tier + filter shape. */
  listNodesByKindCalls: { kind: NodeKind; opts?: ListNodesByKindOptions }[] = [];
  searchCalls = 0;
  vectorCalls = 0;

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
  async listNodesByKind<K extends NodeKind>(
    kind: K,
    opts?: ListNodesByKindOptions,
  ): Promise<readonly NodeOfKind<K>[]> {
    const entry: { kind: NodeKind; opts?: ListNodesByKindOptions } = { kind };
    if (opts !== undefined) entry.opts = opts;
    this.listNodesByKindCalls.push(entry);
    if (kind === "File") {
      return this.fileNodes as unknown as readonly NodeOfKind<K>[];
    }
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
  async search(_q: SearchQuery): Promise<readonly SearchResult[]> {
    this.searchCalls += 1;
    return this.searchRows;
  }
  async vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]> {
    this.vectorCalls += 1;
    this.vectorQueries.push(q);
    if (q.granularity !== undefined) {
      const key = Array.isArray(q.granularity) ? q.granularity.join(",") : String(q.granularity);
      return this.vectorRowsByTier[key] ?? [];
    }
    return this.vectorRows;
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

class FakeEmbedder implements Embedder {
  readonly dim = 4;
  async embed(): Promise<Float32Array> {
    return new Float32Array([0.1, 0.2, 0.3, 0.4]);
  }
  // Symmetric stand-in: the query path mirrors the document path (no prefix).
  // The fake ignores its input, so delegate to the no-arg `embed`.
  async embedQuery(_text: string): Promise<Float32Array> {
    return this.embed();
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
    // P03: flat mode now restricts the ANN leg to the symbol tier by
    // default. Key the stub rows by tier so the test reflects that.
    store.vectorRowsByTier = {
      symbol: [
        { nodeId: "b", distance: 0.1 },
        { nodeId: "c", distance: 0.2 },
      ],
    };
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
    store.vectorRowsByTier = {
      symbol: [
        { nodeId: "x", distance: 0.5 },
        { nodeId: "z", distance: 0.6 },
      ],
    };
    const fused = await hybridSearch(store, { text: "q" }, new FakeEmbedder());
    assert.equal(fused[0]?.nodeId, "x", "dual-source node ranks first");
  });

  it("still runs vectorSearch when BM25 returns nothing, provided the embedder is present", async () => {
    const store = new StubStore();
    store.searchRows = [];
    store.vectorRowsByTier = { symbol: [{ nodeId: "only", distance: 0.1 }] };
    const fused = await hybridSearch(store, { text: "q" }, new FakeEmbedder());
    assert.equal(store.vectorCalls, 1);
    assert.equal(fused.length, 1);
    assert.equal(fused[0]?.nodeId, "only");
    assert.deepEqual(fused[0]?.sources, ["vector"]);
  });

  it("defaults flat vector search to the symbol tier", async () => {
    const store = new StubStore();
    store.searchRows = [];
    store.vectorRowsByTier = { symbol: [{ nodeId: "sym-a", distance: 0.1 }] };
    const fused = await hybridSearch(store, { text: "q" }, new FakeEmbedder());
    assert.equal(store.vectorQueries[0]?.granularity, "symbol");
    assert.equal(fused[0]?.nodeId, "sym-a");
  });

  it("passes explicit granularity through to the flat ANN path", async () => {
    const store = new StubStore();
    store.searchRows = [];
    store.vectorRowsByTier = { community: [{ nodeId: "comm-1", distance: 0.05 }] };
    const fused = await hybridSearch(
      store,
      { text: "q", granularity: "community" },
      new FakeEmbedder(),
    );
    assert.equal(store.vectorQueries[0]?.granularity, "community");
    assert.equal(fused[0]?.nodeId, "comm-1");
  });

  it("zoom mode: coarse file-tier → file path shortlist → fine symbol-tier restricted to those files", async () => {
    const store = new StubStore();
    store.searchRows = [];
    // Coarse step returns two file-node ids; resolveFilePaths (now backed by
    // listNodesByKind('File')) maps them to src/a.ts and src/b.ts. Fine step
    // is restricted via `n.file_path IN (?,?)`.
    store.vectorRowsByTier = {
      file: [
        { nodeId: "File:src/a.ts:src/a.ts", distance: 0.1 },
        { nodeId: "File:src/b.ts:src/b.ts", distance: 0.2 },
      ],
      symbol: [{ nodeId: "Function:src/a.ts:hello", distance: 0.05 }],
    };
    store.fileNodes = [
      {
        id: "File:src/a.ts:src/a.ts" as FileNode["id"],
        kind: "File",
        name: "a.ts",
        filePath: "src/a.ts",
      },
      {
        id: "File:src/b.ts:src/b.ts" as FileNode["id"],
        kind: "File",
        name: "b.ts",
        filePath: "src/b.ts",
      },
    ];

    const fused = await hybridSearch(
      store,
      { text: "auth flow", mode: "zoom", zoomFanout: 2 },
      new FakeEmbedder(),
    );
    assert.equal(fused.length, 1);
    assert.equal(fused[0]?.nodeId, "Function:src/a.ts:hello");

    // Two vector queries: one file-tier, one symbol-tier with file_path IN.
    assert.equal(store.vectorCalls, 2);
    const coarse = store.vectorQueries[0];
    assert.ok(coarse !== undefined);
    assert.equal(coarse.granularity, "file");
    const fine = store.vectorQueries[1];
    assert.ok(fine !== undefined);
    assert.equal(fine.granularity, "symbol");
    assert.match(String(fine.whereClause ?? ""), /n\.file_path IN/);
    assert.deepEqual([...(fine.params ?? [])], ["src/a.ts", "src/b.ts"]);
    // Confirm the resolver hit listNodesByKind('File') exactly once.
    assert.equal(
      store.listNodesByKindCalls.filter((c) => c.kind === "File").length,
      1,
      "expected one listNodesByKind('File') call",
    );
  });

  it("zoom mode falls back to unfiltered symbol search when file-tier returns nothing", async () => {
    const store = new StubStore();
    store.searchRows = [];
    // No file-tier rows → fallback path runs a symbol-tier query with no
    // whereClause.
    store.vectorRowsByTier = {
      file: [],
      symbol: [{ nodeId: "sym-fallback", distance: 0.9 }],
    };
    const fused = await hybridSearch(store, { text: "q", mode: "zoom" }, new FakeEmbedder());
    assert.equal(fused.length, 1);
    assert.equal(fused[0]?.nodeId, "sym-fallback");
    assert.equal(store.vectorCalls, 2);
    const fine = store.vectorQueries[1];
    assert.equal(fine?.whereClause, undefined);
    assert.equal(fine?.granularity, "symbol");
  });
});
