/**
 * Test-only helpers. Lives under src/ so tsc picks it up with the same strict
 * settings as production code, and so tests can import it without reaching
 * across the dist boundary.
 *
 * `FakeStore` is an in-memory stand-in for {@link IGraphStore} that
 * implements every typed finder the analysis/ surface consumes —
 * `listNodes`, `listNodesByKind`, `listNodesByName`,
 * `listNodesByEntryPoint`, `listEdges`, `listEdgesByType`, `listFindings`,
 * `countNodesByKind`, `countEdgesByType`, `traverseAncestors`,
 * `traverseDescendants`, `traverse`, plus the ITemporalStore-compat noops.
 *
 * Per-test fixtures populate the store via `addNode` / `addEdge`; the test
 * then exercises the production code through the same finders the DuckDb
 * and GraphDb adapters expose. No raw SQL crosses the test boundary.
 */

import type {
  CodeRelation,
  DependencyNode,
  FindingNode,
  GraphNode,
  KnowledgeGraph,
  NodeKind,
  NodeOfKind,
  RelationType,
  RepoNode,
  RouteNode,
} from "@opencodehub/core-types";
import type {
  AncestorTraversalOptions,
  BulkLoadStats,
  ConsumerProducerEdge,
  DescendantTraversalOptions,
  EmbeddingRow,
  GraphDialect,
  IGraphStore,
  ListDependenciesOptions,
  ListEdgesByTypeOptions,
  ListEdgesOptions,
  ListEmbeddingsOptions,
  ListFindingsOptions,
  ListNodesByKindOptions,
  ListNodesByNameOptions,
  ListNodesOptions,
  ListRoutesOptions,
  SearchQuery,
  SearchResult,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";

/**
 * Lightweight node fixture used by the analysis test suites. Carries only
 * the fields tests actually exercise. Adapter-grade rehydration (full
 * NODE_COLUMNS round-trip) lives in `@opencodehub/storage/finders.test.ts`.
 */
export interface FakeNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly entryPointId?: string;
  /** H.5 orphan grade — populated on `File` rows so impact tests can flex the multiplier. */
  readonly orphanGrade?: string;
  /** Export flag — used by the dead-code classifier. */
  readonly isExported?: boolean;
  /** Community label — used by the impact-tool module aggregation. */
  readonly inferredLabel?: string;
  /** Community symbol count — used by risk-snapshot. */
  readonly symbolCount?: number;
  /** Community cohesion — used by risk-snapshot. */
  readonly cohesion?: number;
  /** Finding rule id — used by verdict findings aggregation. */
  readonly ruleId?: string;
  /** Finding severity — used by verdict + risk-snapshot. */
  readonly severity?: string;
  /** Finding suppression payload (JSON-encoded SARIF suppressions[]). */
  readonly suppressedJson?: string;
  /** Verdict signals: orphan grade / fix-follow-feat / coverage / cyclomatic. */
  readonly fixFollowFeatDensity?: number;
  readonly coveragePercent?: number;
  readonly cyclomaticComplexity?: number;
  /** Contributor reviewer aggregation. */
  readonly emailHash?: string;
  readonly emailPlain?: string;
  /** Other fields the production code may forward unchanged. */
  readonly [extraField: string]: unknown;
}

export interface FakeEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly confidence: number;
  readonly reason?: string;
}

function nodeAsGraphNode(n: FakeNode): GraphNode {
  // Tests exercise typed-finder consumers that read `{id, name, kind,
  // filePath}` plus a handful of polymorphic optional fields. We pass the
  // FakeNode through as a GraphNode — every test field already maps onto
  // either NodeBase, LocatedNode, or a kind-specific node interface. The
  // discriminated-union narrowing in production code only cares about
  // `kind`, so the cast is sound for the analysis test fixtures.
  return n as unknown as GraphNode;
}

function edgeAsCodeRelation(e: FakeEdge): CodeRelation {
  return {
    id: `${e.fromId}->${e.type}->${e.toId}`,
    from: e.fromId,
    to: e.toId,
    type: e.type as RelationType,
    confidence: e.confidence,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  } as unknown as CodeRelation;
}

/**
 * Sort {@link FakeNode}s by `id` ASC. Mirrors the determinism contract on
 * every typed-finder family the production adapters honour.
 */
function sortNodesById(nodes: readonly FakeNode[]): FakeNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Sort edges by `(from, to, type)` so callers see the same order as
 * `listEdges` returns from DuckDb/GraphDb.
 */
function sortEdges(edges: readonly FakeEdge[]): FakeEdge[] {
  return [...edges].sort((a, b) => {
    if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return 0;
  });
}

/**
 * In-memory {@link IGraphStore} implementation backing the analysis test
 * suite. Every finder is implemented against the `nodes`/`edges` arrays
 * directly — there is no SQL dialect between the test and the production
 * code under test.
 */
export class FakeStore implements IGraphStore {
  readonly dialect: GraphDialect = "none";
  readonly nodes: FakeNode[] = [];
  readonly edges: FakeEdge[] = [];

  addNode(n: FakeNode): void {
    this.nodes.push(n);
  }

  addEdge(e: FakeEdge): void {
    this.edges.push(e);
  }

  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  createSchema(): Promise<void> {
    return Promise.resolve();
  }
  bulkLoad(_graph: KnowledgeGraph): Promise<BulkLoadStats> {
    return Promise.resolve({ nodeCount: 0, edgeCount: 0, durationMs: 0 });
  }
  upsertEmbeddings(_rows: readonly EmbeddingRow[]): Promise<void> {
    return Promise.resolve();
  }
  listEmbeddingHashes(): Promise<Map<string, string>> {
    return Promise.resolve(new Map());
  }
  // eslint-disable-next-line require-yield
  async *listEmbeddings(_opts?: ListEmbeddingsOptions): AsyncIterable<EmbeddingRow> {
    // No embeddings in the test fixture surface today.
  }
  search(_q: SearchQuery): Promise<readonly SearchResult[]> {
    return Promise.resolve([]);
  }
  vectorSearch(_q: VectorQuery): Promise<readonly VectorResult[]> {
    return Promise.resolve([]);
  }
  getMeta(): Promise<StoreMeta | undefined> {
    return Promise.resolve(undefined);
  }
  setMeta(_meta: StoreMeta): Promise<void> {
    return Promise.resolve();
  }
  healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return Promise.resolve({ ok: true });
  }

  // --------------------------------------------------------------------------
  // Typed-finder family — direct implementations against the in-memory arrays.
  // --------------------------------------------------------------------------

  listNodes(opts: ListNodesOptions = {}): Promise<readonly GraphNode[]> {
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length === 0) return Promise.resolve([]);
    const idsRaw = opts.ids;
    if (idsRaw !== undefined && idsRaw.length === 0) return Promise.resolve([]);
    const ids = idsRaw !== undefined ? new Set(idsRaw) : undefined;
    const kindSet = kinds !== undefined ? new Set(kinds) : undefined;
    const filtered = this.nodes.filter((n) => {
      if (kindSet !== undefined && !kindSet.has(n.kind)) return false;
      if (ids !== undefined && !ids.has(n.id)) return false;
      if (opts.filePath !== undefined && n.filePath !== opts.filePath) return false;
      return true;
    });
    const sorted = sortNodesById(filtered);
    const offset = typeof opts.offset === "number" && opts.offset > 0 ? Math.floor(opts.offset) : 0;
    const limit =
      typeof opts.limit === "number" && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;
    const sliced =
      limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
    return Promise.resolve(sliced.map(nodeAsGraphNode));
  }

  listNodesByKind<K extends NodeKind>(
    kind: K,
    opts: ListNodesByKindOptions = {},
  ): Promise<readonly NodeOfKind<K>[]> {
    const filtered = this.nodes.filter((n) => {
      if (n.kind !== kind) return false;
      if (opts.filePath !== undefined && n.filePath !== opts.filePath) return false;
      if (opts.filePathLike !== undefined && !n.filePath.includes(opts.filePathLike)) {
        return false;
      }
      return true;
    });
    const sorted = sortNodesById(filtered);
    const offset = typeof opts.offset === "number" && opts.offset > 0 ? Math.floor(opts.offset) : 0;
    const limit =
      typeof opts.limit === "number" && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;
    const sliced =
      limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
    return Promise.resolve(sliced.map(nodeAsGraphNode) as unknown as readonly NodeOfKind<K>[]);
  }

  listNodesByName(name: string, opts: ListNodesByNameOptions = {}): Promise<readonly GraphNode[]> {
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length === 0) return Promise.resolve([]);
    const kindSet = kinds !== undefined ? new Set(kinds) : undefined;
    const filtered = this.nodes.filter((n) => {
      if (n.name !== name) return false;
      if (kindSet !== undefined && !kindSet.has(n.kind as NodeKind)) return false;
      if (opts.filePath !== undefined && n.filePath !== opts.filePath) return false;
      return true;
    });
    const sorted = sortNodesById(filtered);
    const limit =
      typeof opts.limit === "number" && opts.limit >= 0
        ? sorted.slice(0, Math.floor(opts.limit))
        : sorted;
    return Promise.resolve(limit.map(nodeAsGraphNode));
  }

  listNodesByEntryPoint(entryPointId: string): Promise<readonly GraphNode[]> {
    const filtered = this.nodes.filter((n) => n.entryPointId === entryPointId);
    return Promise.resolve(sortNodesById(filtered).map(nodeAsGraphNode));
  }

  listEdges(opts: ListEdgesOptions = {}): Promise<readonly CodeRelation[]> {
    const types = opts.types !== undefined ? new Set(opts.types) : undefined;
    const fromIds = opts.fromIds !== undefined ? new Set(opts.fromIds) : undefined;
    const toIds = opts.toIds !== undefined ? new Set(opts.toIds) : undefined;
    const minConfidence = opts.minConfidence;
    const filtered = this.edges.filter((e) => {
      if (types !== undefined && !types.has(e.type as RelationType)) return false;
      if (fromIds !== undefined && !fromIds.has(e.fromId)) return false;
      if (toIds !== undefined && !toIds.has(e.toId)) return false;
      if (minConfidence !== undefined && e.confidence < minConfidence) return false;
      return true;
    });
    const sorted = sortEdges(filtered);
    const offset = typeof opts.offset === "number" && opts.offset > 0 ? Math.floor(opts.offset) : 0;
    const limit =
      typeof opts.limit === "number" && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;
    const sliced =
      limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
    return Promise.resolve(sliced.map(edgeAsCodeRelation));
  }

  listEdgesByType(
    type: RelationType,
    opts: ListEdgesByTypeOptions = {},
  ): Promise<readonly CodeRelation[]> {
    const merged: ListEdgesOptions = {
      types: [type],
      ...(opts.fromIds !== undefined ? { fromIds: opts.fromIds } : {}),
      ...(opts.toIds !== undefined ? { toIds: opts.toIds } : {}),
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    };
    return this.listEdges(merged);
  }

  listFindings(opts: ListFindingsOptions = {}): Promise<readonly FindingNode[]> {
    const severitySet = opts.severity !== undefined ? new Set(opts.severity) : undefined;
    const baselineSet = opts.baselineState !== undefined ? new Set(opts.baselineState) : undefined;
    const filtered = this.nodes.filter((n) => {
      if (n.kind !== "Finding") return false;
      const sev = n.severity;
      if (severitySet !== undefined) {
        if (typeof sev !== "string" || !severitySet.has(sev as "note" | "warning" | "error")) {
          return false;
        }
      }
      if (opts.ruleId !== undefined && n.ruleId !== opts.ruleId) return false;
      if (baselineSet !== undefined) {
        const baseline = n["baselineState"];
        if (
          typeof baseline !== "string" ||
          !baselineSet.has(baseline as "new" | "unchanged" | "updated" | "absent")
        ) {
          return false;
        }
      }
      if (
        opts.suppressed === true &&
        (typeof n.suppressedJson !== "string" || n.suppressedJson.length === 0)
      ) {
        return false;
      }
      if (
        opts.suppressed === false &&
        typeof n.suppressedJson === "string" &&
        n.suppressedJson.length > 0
      ) {
        return false;
      }
      return true;
    });
    const sorted = sortNodesById(filtered);
    const limit =
      typeof opts.limit === "number" && opts.limit >= 0
        ? sorted.slice(0, Math.floor(opts.limit))
        : sorted;
    return Promise.resolve(limit.map((n) => nodeAsGraphNode(n) as unknown as FindingNode));
  }

  listDependencies(_opts: ListDependenciesOptions = {}): Promise<readonly DependencyNode[]> {
    const filtered = this.nodes.filter((n) => n.kind === "Dependency");
    return Promise.resolve(
      sortNodesById(filtered).map((n) => nodeAsGraphNode(n) as unknown as DependencyNode),
    );
  }

  listRoutes(_opts: ListRoutesOptions = {}): Promise<readonly RouteNode[]> {
    const filtered = this.nodes.filter((n) => n.kind === "Route");
    return Promise.resolve(
      sortNodesById(filtered).map((n) => nodeAsGraphNode(n) as unknown as RouteNode),
    );
  }

  getRepoNode(id: string): Promise<RepoNode | undefined> {
    const hit = this.nodes.find((n) => n.id === id && n.kind === "Repo");
    return Promise.resolve(hit ? (nodeAsGraphNode(hit) as unknown as RepoNode) : undefined);
  }

  countNodesByKind(kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>> {
    const out = new Map<NodeKind, number>();
    if (kinds !== undefined && kinds.length === 0) return Promise.resolve(out);
    const filterSet = kinds !== undefined ? new Set(kinds) : undefined;
    for (const n of this.nodes) {
      if (filterSet !== undefined && !filterSet.has(n.kind as NodeKind)) continue;
      out.set(n.kind as NodeKind, (out.get(n.kind as NodeKind) ?? 0) + 1);
    }
    if (kinds !== undefined) {
      for (const k of kinds) {
        if (!out.has(k)) out.set(k, 0);
      }
    }
    return Promise.resolve(out);
  }

  countEdgesByType(types?: readonly RelationType[]): Promise<Map<RelationType, number>> {
    const out = new Map<RelationType, number>();
    if (types !== undefined && types.length === 0) return Promise.resolve(out);
    const filterSet = types !== undefined ? new Set(types) : undefined;
    for (const e of this.edges) {
      if (filterSet !== undefined && !filterSet.has(e.type as RelationType)) continue;
      out.set(e.type as RelationType, (out.get(e.type as RelationType) ?? 0) + 1);
    }
    if (types !== undefined) {
      for (const t of types) {
        if (!out.has(t)) out.set(t, 0);
      }
    }
    return Promise.resolve(out);
  }

  traverse(q: TraverseQuery): Promise<readonly TraverseResult[]> {
    // Breadth-first expansion mirrors the previous FakeStore behaviour.
    const minConf = q.minConfidence ?? 0;
    const relTypes = q.relationTypes ? new Set(q.relationTypes) : undefined;
    const results: TraverseResult[] = [];
    const seen = new Set<string>([q.startId]);
    type Frontier = {
      readonly id: string;
      readonly depth: number;
      readonly path: readonly string[];
    };
    let frontier: Frontier[] = [{ id: q.startId, depth: 0, path: [q.startId] }];
    while (frontier.length > 0) {
      const next: Frontier[] = [];
      for (const cur of frontier) {
        if (cur.depth >= q.maxDepth) continue;
        for (const e of this.edges) {
          if (relTypes && !relTypes.has(e.type)) continue;
          if (e.confidence < minConf) continue;
          const reaches =
            q.direction === "down" || q.direction === "both"
              ? e.fromId === cur.id
                ? e.toId
                : undefined
              : undefined;
          const reachesUp =
            q.direction === "up" || q.direction === "both"
              ? e.toId === cur.id
                ? e.fromId
                : undefined
              : undefined;
          for (const nxt of [reaches, reachesUp]) {
            if (!nxt) continue;
            if (seen.has(nxt)) continue;
            seen.add(nxt);
            const path = [...cur.path, nxt];
            const depth = cur.depth + 1;
            results.push({ nodeId: nxt, depth, path });
            next.push({ id: nxt, depth, path });
          }
        }
      }
      frontier = next;
    }
    results.sort((a, b) =>
      a.depth === b.depth ? a.nodeId.localeCompare(b.nodeId) : a.depth - b.depth,
    );
    return Promise.resolve(results);
  }

  traverseAncestors(opts: AncestorTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.directionalTraverse(opts, "up");
  }

  traverseDescendants(opts: DescendantTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.directionalTraverse(opts, "down");
  }

  listConsumerProducerEdges(
    _opts: { readonly repoUris?: readonly string[] } = {},
  ): Promise<readonly ConsumerProducerEdge[]> {
    return Promise.resolve([]);
  }

  private async directionalTraverse(
    opts: AncestorTraversalOptions | DescendantTraversalOptions,
    direction: "up" | "down",
  ): Promise<readonly TraverseResult[]> {
    if (opts.edgeTypes.length === 0) return [];
    const minConf = opts.minConfidence ?? 0;
    const allowedTypes = new Set(opts.edgeTypes);
    const results: TraverseResult[] = [];
    const seen = new Set<string>([opts.fromId]);
    type Frontier = {
      readonly id: string;
      readonly depth: number;
      readonly path: readonly string[];
    };
    let frontier: Frontier[] = [{ id: opts.fromId, depth: 0, path: [opts.fromId] }];
    while (frontier.length > 0) {
      const next: Frontier[] = [];
      for (const cur of frontier) {
        if (cur.depth >= opts.maxDepth) continue;
        for (const e of this.edges) {
          if (!allowedTypes.has(e.type as RelationType)) continue;
          if (e.confidence < minConf) continue;
          const nextId =
            direction === "up"
              ? e.toId === cur.id
                ? e.fromId
                : undefined
              : e.fromId === cur.id
                ? e.toId
                : undefined;
          if (!nextId) continue;
          if (seen.has(nextId)) continue;
          seen.add(nextId);
          const path = [...cur.path, nextId];
          const depth = cur.depth + 1;
          results.push({ nodeId: nextId, depth, path });
          next.push({ id: nextId, depth, path });
        }
      }
      frontier = next;
    }
    results.sort((a, b) =>
      a.depth === b.depth ? a.nodeId.localeCompare(b.nodeId) : a.depth - b.depth,
    );
    return results;
  }
}

/** In-memory {@link FsAbstraction} for rename tests. */
export class FakeFs {
  readonly files = new Map<string, string>();

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }

  readFile(absPath: string): Promise<string> {
    const v = this.files.get(absPath);
    if (v === undefined) {
      const err = new Error(`ENOENT: ${absPath}`);
      return Promise.reject(err);
    }
    return Promise.resolve(v);
  }

  writeFileAtomic(absPath: string, content: string): Promise<void> {
    this.files.set(absPath, content);
    return Promise.resolve();
  }
}
