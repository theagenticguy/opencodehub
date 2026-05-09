/**
 * Storage abstractions for OpenCodeHub knowledge graphs.
 *
 * AC-A-1 split this surface into two cohesive interfaces:
 *
 *   1. {@link IGraphStore} — graph-tier, pure graph operations only:
 *      nodes, edges, traversals, BM25 search, vector search, embeddings.
 *      NO SQL, NO cochanges, NO symbol summaries. Cypher dialect or none.
 *      The portable interface community AGE / Memgraph / Neo4j / Neptune
 *      adapters target.
 *   2. {@link ITemporalStore} — tabular-tier, SQL-only operations:
 *      cochanges, symbol summaries, the `codehub query --sql` escape hatch,
 *      and any future temporal-analytics query. Today always DuckDB-backed.
 *      Community adapters can implement other SQL-shaped stores (SQLite,
 *      Postgres) without affecting graph adapters.
 *
 * Callers that need both surfaces use {@link openStore} and consume the
 * resulting {@link OpenStoreResult} `{graph, temporal, close, ...}`.
 *
 * The DuckDB adapter exposes BOTH views over one connection (no second
 * file when DuckDB is the only backend). The graph-db adapter (via
 * `@ladybugdb/core`) is graph-only and pairs with a DuckDB temporal store.
 *
 * ## Sentinel rules (AC-A-2)
 *
 * Every adapter that implements {@link IGraphStore} MUST honour four
 * sentinel coercions so the cross-adapter `graphHash` parity invariant
 * holds. The canonical implementations live in `./column-encode.ts`;
 * future adapter authors should import them rather than reinvent the
 * rules.
 *
 *   1. **Step-zero drop** ({@link stepZeroSentinel}). The canonical edge
 *      shape distinguishes "no step" (field absent) from "step is N ≥ 1".
 *      DuckDB stores `relations.step` as `INTEGER NOT NULL DEFAULT 0`; the
 *      graph-db backend stores the column as nullable `INT32`. Both
 *      backends therefore disagree on read-back when the source edge
 *      carries an explicit `step: 0` (DuckDB returns `0`, graph-db
 *      returns `null`). The convention is "drop step when it reads back
 *      as 0/null", which is what `stepZeroSentinel` enforces.
 *
 *   2. **Empty `languageStats` coercion** ({@link coerceLanguageStats}).
 *      `RepoNode.languageStats = {}` collapses to SQL NULL on write
 *      (`languageStatsJsonOrNull` returns `null` for an empty object) and
 *      is re-added as `{}` on read. The two halves of this invariant must
 *      be applied symmetrically across every adapter — otherwise canonical
 *      JSON sees "missing field" on one backend and "empty object" on the
 *      other and the hash diverges.
 *
 *   3. **Repo nullable fields** ({@link applyRepoNullables}).
 *      `RepoNode.originUrl` / `defaultBranch` / `group` are
 *      `string | null` on the interface — never `string | undefined`.
 *      Adapters write SQL NULL for both `null` and absent inputs; on
 *      read, the row decoder must re-attach the field as explicit
 *      `null` for Repo rows so the canonical-JSON shape matches the
 *      original fixture.
 *
 *   4. **Deadness normalization** ({@link normalizeDeadness}). The
 *      dead-code analysis emits the hyphenated `unreachable-export`; the
 *      `deadness` column stores the underscored `unreachable_export`.
 *      Adapters apply `normalizeDeadness` on write and the symmetric
 *      `denormalizeDeadness` on read so call sites query a single
 *      spelling.
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

/**
 * Concrete backend identifiers recognized by {@link openStore}. `"duck"`
 * (DuckDB) and `"lbug"` (graph-db backend via `@ladybugdb/core`) are the
 * in-tree implementations. `"age"`, `"memgraph"`, `"neo4j"`, and
 * `"neptune"` are reserved for plausible community-fork adapters; they
 * are not implemented here.
 */
export type BackendKind = "duck" | "lbug" | "age" | "memgraph" | "neo4j" | "neptune";

/**
 * Graph dialect a given {@link IGraphStore} adapter speaks. The optional
 * {@link IGraphStore.execCypher} escape hatch only makes sense when the
 * dialect is `"cypher"`. The DuckDB adapter sets `"none"` because its
 * `nodes`/`relations` tables expose no public Cypher entry point — the
 * typed finders cover every internal need.
 */
export type GraphDialect = "cypher" | "none";

// ─────────────────────────────────────────────────────────────────────────────
// IGraphStore — graph-tier only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Graph-tier interface. Pure graph operations: nodes, edges, traversals,
 * BM25 keyword search, vector search, embeddings.
 *
 * **Out of scope for this interface:** SQL, cochanges, symbol summaries,
 * and any tabular/time-travel queries — those live on {@link ITemporalStore}.
 *
 * Community adapters (AGE / Memgraph / Neo4j / Neptune) implement THIS
 * interface only. They pair with an {@link ITemporalStore} (always
 * DuckDB-backed by default) for tabular concerns.
 *
 * ## v1.0 conformance contract
 *
 * `assertIGraphStoreConformance(name, factory)` from
 * `@opencodehub/storage/test-utils` is the formal v1.0 conformance test
 * suite for community adapters (architecture-revised.md §AC-A-11). A
 * third-party adapter author imports it from their own test file:
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
 * The suite proves the adapter has byte-identical {@link KnowledgeGraph}
 * round-trip via `graphHash`, that `listEdgesByType` agrees with
 * `listEdges({types})`, that `traverseAncestors` is a subset of the BFS
 * over `listEdges` truncated at the depth bound, that `listNodes` is
 * `id ASC` and pages stably, and that `healthCheck` returns `{ok: true}`
 * after `open + createSchema`. Vector search is treated as an optional
 * capability and skipped cleanly when the adapter throws "not implemented"
 * or returns `[]` for a known-non-empty query.
 *
 * Both in-tree adapters (`DuckDbStore`, `GraphDbStore`) opt into this
 * suite from their own test files — any future signature change here
 * MUST keep the conformance suite green on both before landing.
 */
export interface IGraphStore {
  /**
   * Cypher dialect spoken by this adapter, or `"none"` if no public
   * Cypher entry point is exposed. OCH core never branches on this — it
   * is published for community adapters and documentation tooling.
   */
  readonly dialect: GraphDialect;

  /** Open (or create) the underlying database file. Idempotent. */
  open(): Promise<void>;
  /** Release all native handles. Safe to call more than once. */
  close(): Promise<void>;
  /** Emit all CREATE TABLE / CREATE INDEX DDL. Must be called before bulkLoad. */
  createSchema(): Promise<void>;
  /**
   * Load the provided graph into the store in a single transaction.
   *
   * Modes:
   *   - `"replace"` (default) — drop all existing rows, then insert the graph.
   *     Maintains v1.0 semantics for full reindex runs.
   *   - `"upsert"` — INSERT ... ON CONFLICT DO UPDATE for every row, preserving
   *     rows not present in the incoming graph. Required by the
   *     incremental / content-cache pipeline so touched files can be replaced
   *     without losing unrelated data.
   */
  bulkLoad(graph: KnowledgeGraph, opts?: BulkLoadOptions): Promise<BulkLoadStats>;
  /** Insert/replace embedding rows for the configured vector dimension. */
  upsertEmbeddings(rows: readonly EmbeddingRow[]): Promise<void>;
  /**
   * Return every prior `content_hash` from the embeddings table keyed by
   * the composite PK. Used by the ingestion embeddings phase to skip
   * re-embedding chunks whose source text is unchanged across runs.
   *
   * Key format: `${granularity}\0${node_id}\0${chunk_index}` — the `\0`
   * separator is binary-safe vs `:` which appears inside NodeIds.
   * Value: the `content_hash` column verbatim.
   *
   * Empty on a fresh database. Loaded in a single round-trip; the expected
   * row count (O(200K) for a 50K-symbol repo with three tiers) fits
   * comfortably in memory.
   */
  listEmbeddingHashes(): Promise<Map<string, string>>;
  /**
   * Stream every embedding row with deterministic ordering — used by
   * `pack/embeddings-sidecar.ts` to write the Parquet artifact without
   * materializing the full embeddings table in memory.
   *
   * The result is `AsyncIterable<EmbeddingRow>` (NOT `Promise<readonly
   * EmbeddingRow[]>`). Adapters MUST implement this as `async function*`
   * so the caller can `for await (const row of store.listEmbeddings())`.
   * Order: `(node_id ASC, granularity ASC, chunk_index ASC)` — matches
   * the Parquet writer's row-group order.
   *
   * Optional filters narrow the stream by node kind (joined to `nodes`)
   * and cap total rows. Empty `kindFilter` short-circuits to an empty
   * stream.
   */
  listEmbeddings(opts?: ListEmbeddingsOptions): AsyncIterable<EmbeddingRow>;
  /**
   * Enumerate fully-rehydrated graph nodes by kind, with deterministic
   * ordering. Backs the M5 BOM bodies (skeleton, file-tree, deps, xrefs)
   * and any caller that wants typed kind-filtered iteration without
   * scattering raw `query("SELECT ... FROM nodes")` calls.
   *
   * Semantics:
   *   - `kinds` undefined → return every kind.
   *   - `kinds: []`        → return an empty array (no fan-out).
   *   - `kinds: [...]`     → filter by exact match against the `kind`
   *                          discriminator. Unknown kinds yield 0 rows.
   *   - Results are ORDER BY id ASC at the storage layer for cross-adapter
   *     determinism. Adapters apply a lex-stable JS-side tiebreak so the
   *     output matches byte-for-byte across DuckStore and GraphDbStore.
   *   - Wider polymorphic columns (Dependency `version`/`license`/
   *     `lockfile_source`/`ecosystem`, ProjectProfile JSON arrays, Repo
   *     fields, etc.) are mapped back onto the typed shape via per-kind
   *     rehydration. Returned objects satisfy {@link GraphNode}.
   *
   * `limit`/`offset` apply post-filter / post-order so paging is stable.
   * Negative or non-finite values are clamped to 0.
   */
  listNodes(opts?: ListNodesOptions): Promise<readonly GraphNode[]>;
  /**
   * Single-kind shorthand. Returns rehydrated nodes narrowed to the
   * supplied {@link NodeKind} via {@link NodeOfKind}. Used by xrefs,
   * skeleton, list-findings, dependencies, wiki — anywhere a caller needs
   * "all Function nodes" without scattering raw kind-filtered SELECTs.
   *
   * Filter semantics:
   *   - `filePath` (exact match) and `filePathLike` (LIKE %x% match) are
   *     mutually compatible. When both are set, exact match takes priority.
   *   - Results are ordered `id ASC` post-filter. `limit`/`offset` apply
   *     after order so paging is stable across calls.
   */
  listNodesByKind<K extends NodeKind>(
    kind: K,
    opts?: ListNodesByKindOptions,
  ): Promise<readonly NodeOfKind<K>[]>;
  /**
   * All edges, optionally filtered + paged. Used by the parity rebuilder
   * and any caller that wants `relations` rows without the dialect-specific
   * query string. Result rows are ordered by `(from_id, to_id, type)` for
   * cross-adapter determinism.
   */
  listEdges(opts?: ListEdgesOptions): Promise<readonly CodeRelation[]>;
  /**
   * Single-type shorthand. Used by pack/xrefs.ts, pack/skeleton.ts,
   * group-contracts.ts. Same ordering contract as {@link listEdges}.
   */
  listEdgesByType(
    type: RelationType,
    opts?: ListEdgesByTypeOptions,
  ): Promise<readonly CodeRelation[]>;
  /**
   * Findings filter. Used by analysis/verdict.ts, mcp/tools/list-findings.ts,
   * pack/findings.ts, wiki. Materializes typed {@link FindingNode}s rather
   * than the raw row shape so consumers see structured fields (`severity`,
   * `baselineState`, `suppressedJson`) without hand-rehydrating.
   *
   * The `severity` filter narrows to the user-facing tiers
   * `"note" | "warning" | "error"` — `"none"` is a SARIF wire-level value
   * consumers never ask for explicitly. The `suppressed` filter consults
   * the `suppressed_json` column: `true` → only suppressed findings,
   * `false` → only non-suppressed, omitted → both.
   */
  listFindings(opts?: ListFindingsOptions): Promise<readonly FindingNode[]>;
  /**
   * Dependencies filter. Used by mcp/tools/dependencies.ts, license_audit,
   * wiki. `licenseTier` maps SPDX-ish license strings to one of the five
   * tiers — adapters defer the classifier to the caller (consumers pass
   * a pre-classified set in `licenseTier` rather than a raw SPDX string).
   */
  listDependencies(opts?: ListDependenciesOptions): Promise<readonly DependencyNode[]>;
  /**
   * Routes filter. Used by mcp/tools/route-map.ts, group-contracts.ts.
   * `methods` filter intersects the typed HTTP-verb union; `pathLike`
   * applies LIKE %x% over the route URL.
   */
  listRoutes(opts?: ListRoutesOptions): Promise<readonly RouteNode[]>;
  /**
   * Repo-node by id. Replaces every `SELECT repo_uri FROM nodes WHERE
   * id = ?` site (mcp/repo-uri-for-entry.ts and the group-cross-repo
   * lookup). Returns `undefined` when no row matches OR when the row
   * exists but is not `kind = 'Repo'` — the caller never needs to
   * downcast. The returned shape is the typed {@link RepoNode}, with
   * `originUrl`/`defaultBranch`/`group` preserving the explicit `null`
   * sentinel rather than `undefined`.
   */
  getRepoNode(id: string): Promise<RepoNode | undefined>;
  /**
   * Specialized finder for `analysis/impact.ts:131-135` —
   * `SELECT ... FROM nodes WHERE entry_point_id = ?`. Returns every
   * {@link GraphNode} (typically Process rows) whose `entry_point_id`
   * column equals the supplied id. Result rows are ordered `id ASC` to
   * match the {@link listNodes} determinism contract.
   *
   * Returns an empty array when no row matches. The wide-column
   * `entry_point_id` only carries a value on Process nodes today, but
   * the finder is kind-agnostic on read so future kinds that reuse the
   * column (e.g. workflow definitions) are picked up without surface
   * changes.
   */
  listNodesByEntryPoint(entryPointId: string): Promise<readonly GraphNode[]>;
  /**
   * Specialized finder for `analysis/rename.ts:51,59` —
   * `SELECT ... FROM nodes WHERE name = ?` with optional kind / file
   * narrowing. Returns every {@link GraphNode} whose `name` column
   * exactly matches the supplied identifier. The optional `kinds` filter
   * narrows by node kind (AND-combined with `name`), and `filePath`
   * pins the lookup to one file (used by the `rename.scope.filePath`
   * disambiguator). Empty `kinds` array short-circuits to `[]`.
   *
   * Result rows are ordered `id ASC` for cross-adapter determinism.
   */
  listNodesByName(name: string, opts?: ListNodesByNameOptions): Promise<readonly GraphNode[]>;
  /**
   * Counts grouped by node kind. Used by analysis/risk-snapshot.ts and
   * project_profile. When `kinds` is undefined every kind is reported;
   * when supplied, only the listed kinds appear in the result map.
   */
  countNodesByKind(kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>>;
  /**
   * Counts grouped by edge type. Used by risk-snapshot, route-map.
   * Same semantics as {@link countNodesByKind} — undefined means every
   * type, supplied means only the listed types.
   */
  countEdgesByType(types?: readonly RelationType[]): Promise<Map<RelationType, number>>;
  /** Full-text search over symbol name / signature / description via BM25. */
  search(q: SearchQuery): Promise<readonly SearchResult[]>;
  /** Filter-aware HNSW vector search. */
  vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]>;
  /** Depth-bounded graph traversal with optional confidence / relation filters. */
  traverse(q: TraverseQuery): Promise<readonly TraverseResult[]>;
  /**
   * Traverse ancestors of `fromId` along the supplied edge types up to
   * `maxDepth`. Replaces `WITH RECURSIVE ... USING KEY (ancestor_id)` in
   * analysis/impact.ts and the `WITH RECURSIVE` in mcp/tools/query.ts.
   *
   * Direction is "up" — visits each `r.from_id` whose `r.to_id`
   * transitively reaches `fromId`. Confidence floor optional; default 0.
   * Result ordering: `(depth ASC, nodeId ASC)`. The starting node is
   * NOT included in the result.
   */
  traverseAncestors(opts: AncestorTraversalOptions): Promise<readonly TraverseResult[]>;
  /**
   * Symmetric of {@link traverseAncestors} — visits each `r.to_id` whose
   * `r.from_id` transitively reaches `fromId`. Same ordering and
   * starting-node exclusion semantics.
   */
  traverseDescendants(opts: DescendantTraversalOptions): Promise<readonly TraverseResult[]>;
  /**
   * Producer-consumer edges across repos. Replaces the FETCHES + Route
   * SQL in group-contracts.ts. Returns one row per FETCHES edge that
   * resolves to a Route on the producer side, with both endpoints
   * carrying their owning `repo_uri`.
   *
   * `repoUris` filter narrows the output to edges whose consumer or
   * producer repo lies in the supplied set; omitted means every edge.
   * Result ordering: `(consumerRepoUri, producerRepoUri, httpMethod,
   * httpPath)` for cross-adapter determinism.
   */
  listConsumerProducerEdges(opts?: {
    readonly repoUris?: readonly string[];
  }): Promise<readonly ConsumerProducerEdge[]>;
  /** Fetch the last-written store metadata, if any. */
  getMeta(): Promise<StoreMeta | undefined>;
  /** Upsert the store metadata row. */
  setMeta(meta: StoreMeta): Promise<void>;
  /** Minimal connectivity probe. */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;

  /**
   * Optional escape hatch for community adapters whose backend exposes a
   * feature the typed finders don't cover (e.g. APOC procedures on Neo4j,
   * AGE's `cypher('graph_name', $$ ... $$)` framing). The OCH core never
   * calls this method; it exists so a community-fork adapter author can
   * wire user-supplied Cypher through.
   *
   * Adapters that implement it MUST guard write verbs (mirror today's
   * `assertReadOnlyCypher` helper).
   */
  execCypher?(
    statement: string,
    params?: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ITemporalStore — tabular-tier only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tabular/temporal interface. Cochanges, symbol summaries, time-travel
 * queries, and the `codehub query --sql` escape hatch all live here.
 * Today always DuckDB-backed; future SQLite or Parquet-sidecar adapters
 * fit the same surface.
 *
 * Graph-only community backends (AGE / Memgraph / Neo4j / Neptune)
 * NEVER implement this interface — they pair with a DuckDB-backed
 * temporal store via {@link openStore}.
 */
export interface ITemporalStore {
  /** Open (or create) the underlying database file. Idempotent. */
  open(): Promise<void>;
  /** Release all native handles. Safe to call more than once. */
  close(): Promise<void>;
  /** Emit all CREATE TABLE / CREATE INDEX DDL. Must be called before bulkLoad. */
  createSchema(): Promise<void>;
  /** Minimal connectivity probe. */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;

  /**
   * Run a user-supplied read-only SQL statement with bound parameters.
   * Backend-internal guard rejects write verbs. Used by the
   * `codehub query --sql` CLI surface and the MCP `sql` tool ONLY when
   * `--sql` is explicitly passed. Other MCP tools route through
   * {@link IGraphStore} typed finders.
   */
  exec(
    sql: string,
    params?: readonly SqlParam[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<readonly Record<string, unknown>[]>;

  // ── Cochange surface (was on IGraphStore via CochangeStore) ───────────────
  /** Replace the cochanges table contents with the supplied rows. */
  bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void>;
  /**
   * Fetch cochange rows for one file in either direction. Results are
   * sorted by `lift` descending so the strongest associations come first.
   */
  lookupCochangesForFile(
    file: string,
    opts?: CochangeLookupOptions,
  ): Promise<readonly CochangeRow[]>;
  /** Fetch the single cochange row (if any) for an ordered pair of files. */
  lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined>;

  // ── Symbol-summary surface (was on IGraphStore via SymbolSummaryStore) ────
  /**
   * Insert or replace the supplied summary rows. Conflicts on the composite
   * `(node_id, content_hash, prompt_version)` key overwrite the existing
   * row. Empty input is a cheap no-op.
   */
  bulkLoadSymbolSummaries(rows: readonly SymbolSummaryRow[]): Promise<void>;
  /**
   * Fetch the single summary row (if any) keyed by the composite cache
   * tuple. Returns `undefined` on miss.
   */
  lookupSymbolSummary(
    nodeId: string,
    contentHash: string,
    promptVersion: string,
  ): Promise<SymbolSummaryRow | undefined>;
  /**
   * Fetch every summary row whose `node_id` appears in the supplied list.
   * Result ordering is stable: sorted by `(node_id, prompt_version,
   * content_hash)` so callers can pick the newest prompt version
   * deterministically when more than one row per node is present.
   */
  lookupSymbolSummariesByNode(nodeIds: readonly string[]): Promise<readonly SymbolSummaryRow[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Open-store factory result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Composed result of {@link openStore}. The caller closes both views via
 * the deterministic {@link OpenStoreResult.close} method (which closes
 * temporal first when the two views share a backing connection, and
 * closes graph first otherwise — adapters guarantee idempotence).
 */
export interface OpenStoreResult {
  /** Concrete backend selected after env + binding resolution. */
  readonly backend: BackendKind;
  /** Graph-tier view. */
  readonly graph: IGraphStore;
  /** Tabular-tier view. */
  readonly temporal: ITemporalStore;
  /** Absolute path to the on-disk graph artifact. */
  readonly graphFile: string;
  /** Absolute path to the on-disk temporal artifact. May equal `graphFile` (DuckDB-only deployments). */
  readonly temporalFile: string;
  /** Closes both views in deterministic order. Idempotent. */
  close(): Promise<void>;
}

/** Inputs to {@link openStore}. */
export interface OpenStoreOptions {
  /** Filesystem path to the database file (or directory housing both files). */
  readonly path: string;
  /**
   * Backend selector:
   *   - `"duck"` — single DuckDB file backs BOTH graph and temporal views.
   *   - `"lbug"` — graph-db backend (`@ladybugdb/core`) for graph; a paired
   *     DuckDB file at `<path>.temporal.duckdb` for temporal.
   *   - `"auto"` — read the `CODEHUB_STORE` env var (AC-A-9 will flip the
   *     default once binding-availability detection lands). For now
   *     `"auto"` resolves to the legacy default.
   */
  readonly backend?: BackendKind | "auto";
  readonly readOnly?: boolean;
  readonly embeddingDim?: number;
  readonly timeoutMs?: number;
}

/**
 * Type alias for callers that need both views. Equivalent to
 * {@link OpenStoreResult}; the shorter name reads better in function
 * signatures (`function fn(store: Store)`).
 */
export type Store = OpenStoreResult;

// ─────────────────────────────────────────────────────────────────────────────
// Cochange row + lookup options (used by ITemporalStore)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row in the `cochanges` table. Written only by the ingestion cochange
 * phase; read by the MCP `context` / `impact` tools when they surface
 * "files often edited together" as a side section. This is a statistical
 * (git-history) signal — never promote it into the deterministic graph.
 */
export interface CochangeRow {
  readonly sourceFile: string;
  readonly targetFile: string;
  readonly cocommitCount: number;
  readonly totalCommitsSource: number;
  readonly totalCommitsTarget: number;
  /** ISO-8601 UTC timestamp of the most recent commit that touched both files. */
  readonly lastCocommitAt: string;
  /**
   * Association-rule lift:
   *   (cocommit_count * N_total) / (total_commits_source * total_commits_target).
   * `1.0` means the two files change together exactly as often as independence
   * would predict; `>1.0` correlated; `<1.0` anti-correlated.
   */
  readonly lift: number;
}

/** Options for {@link ITemporalStore.lookupCochangesForFile}. */
export interface CochangeLookupOptions {
  readonly limit?: number;
  /**
   * Drop rows below this lift floor. Default is 1.0 so callers never see
   * associations weaker than chance.
   */
  readonly minLift?: number;
}

/**
 * @deprecated AC-A-1 folded the cochange surface into {@link ITemporalStore}.
 * The named alias is retained for one AC cycle so test fakes that satisfy
 * the older shape keep compiling. New code consumes `ITemporalStore`
 * directly via {@link OpenStoreResult.temporal}.
 */
export interface CochangeStore {
  bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void>;
  lookupCochangesForFile(
    file: string,
    opts?: CochangeLookupOptions,
  ): Promise<readonly CochangeRow[]>;
  lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol-summary row (used by ITemporalStore)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row in the `symbol_summaries` table. Emitted by the ingestion
 * `summarize` phase (structured summaries from a Bedrock LLM); read by the
 * MCP layer when fusing summary-text recall with code-embedding recall (the
 * SACL-style two-lane retrieval pattern). Summaries never participate in
 * the graph edge set — they are content keyed by `(nodeId, contentHash,
 * promptVersion)`.
 */
export interface SymbolSummaryRow {
  readonly nodeId: string;
  /**
   * Content-addressed hash (sha256 hex) of the symbol's source text. Used
   * as a cache key so re-index runs where the source hasn't moved reuse
   * prior summaries for free.
   */
  readonly contentHash: string;
  /**
   * Semver-style version tag for the prompt that produced the summary.
   * Bumping the prompt invalidates prior rows without deleting them, so
   * multiple versions can coexist during rollout.
   */
  readonly promptVersion: string;
  /** Bedrock model id (e.g. `global.anthropic.claude-haiku-4-5-...`). */
  readonly modelId: string;
  /** The expanded, verb-led purpose field. */
  readonly summaryText: string;
  /** Compact one-line gist of the signature (inputs + returns shape). */
  readonly signatureSummary?: string;
  /** Compact summary of what the symbol returns (`returns.type_summary`). */
  readonly returnsTypeSummary?: string;
  /** ISO-8601 UTC timestamp when the row was produced. */
  readonly createdAt: string;
}

/**
 * @deprecated AC-A-1 folded the symbol-summary surface into
 * {@link ITemporalStore}. The named alias is retained for one AC cycle so
 * test fakes that satisfy the older shape keep compiling. New code consumes
 * `ITemporalStore` directly via {@link OpenStoreResult.temporal}.
 */
export interface SymbolSummaryStore {
  bulkLoadSymbolSummaries(rows: readonly SymbolSummaryRow[]): Promise<void>;
  lookupSymbolSummary(
    nodeId: string,
    contentHash: string,
    promptVersion: string,
  ): Promise<SymbolSummaryRow | undefined>;
  lookupSymbolSummariesByNode(nodeIds: readonly string[]): Promise<readonly SymbolSummaryRow[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared options + result types
// ─────────────────────────────────────────────────────────────────────────────

/** JS types that can safely round-trip as DuckDB query parameters at MVP. */
export type SqlParam = string | number | bigint | boolean | null;

/**
 * Options for {@link IGraphStore.listNodes}. All fields are optional —
 * absent `kinds` returns every kind; absent `limit` returns the full
 * filtered set; absent `offset` starts at 0.
 */
export interface ListNodesOptions {
  /**
   * Restrict to one or more {@link GraphNode.kind} values. An empty array
   * is a no-op that returns `[]` (matches the "kinds: [] → empty" contract).
   */
  readonly kinds?: readonly string[];
  /**
   * Restrict to a specific set of node ids. AND-combined with `kinds` (a
   * row matches only when both filters allow it). An empty array is a
   * no-op that returns `[]` — same short-circuit semantics as `kinds`.
   * Used by analysis/impact.ts and analysis/detect-changes.ts to bulk
   * hydrate `{id, name, file_path, kind}` over an IN-list. Adapters
   * apply de-duplication on the input set.
   */
  readonly ids?: readonly string[];
  /**
   * Exact-match filter against `nodes.file_path`. AND-combined with
   * `kinds` and `ids`. Used by analysis/detect-changes.ts to enumerate
   * every symbol in one changed file without raw SQL. Mirrors the
   * `filePath` field on {@link ListNodesByKindOptions}.
   */
  readonly filePath?: string;
  /** Maximum number of rows to return after filter + sort. */
  readonly limit?: number;
  /** Number of rows to skip after filter + sort. */
  readonly offset?: number;
}

/**
 * Options for {@link IGraphStore.listEmbeddings}. All fields optional.
 *
 * `kindFilter` joins the embeddings stream to the `nodes` table on
 * `node_id` so only embeddings whose source kind is in the set are
 * yielded. Empty array short-circuits to an empty stream.
 *
 * `limit` caps the total rows yielded (post-filter, post-order). Useful
 * for callers that want a sample without draining the table.
 */
export interface ListEmbeddingsOptions {
  readonly kindFilter?: readonly NodeKind[];
  readonly limit?: number;
}

/**
 * Options for {@link IGraphStore.listNodesByKind}. Adds two file-scoped
 * filters on top of the shared limit/offset shape: `filePath` (exact
 * match against `nodes.file_path`) and `filePathLike` (wildcard match
 * via SQL LIKE / Cypher `STARTS WITH ... CONTAINS` semantics — adapters
 * use a `%x%` wrapping internally).
 */
export interface ListNodesByKindOptions {
  /** Exact-match filter against `nodes.file_path`. */
  readonly filePath?: string;
  /** LIKE %x% match against `nodes.file_path`. */
  readonly filePathLike?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Options for {@link IGraphStore.listNodesByName}. `kinds` narrows by
 * node kind (AND-combined with the name match); `filePath` pins the
 * lookup to one file path. Empty `kinds` array short-circuits at the
 * adapter boundary to `[]`.
 */
export interface ListNodesByNameOptions {
  readonly kinds?: readonly NodeKind[];
  readonly filePath?: string;
  readonly limit?: number;
}

/**
 * Options for {@link IGraphStore.listEdges}. The `fromIds` / `toIds`
 * arrays are AND-combined with the optional `types` filter; the result
 * set is the intersection.
 *
 * `minConfidence` drops edges whose `confidence` is strictly below the
 * floor. Use it to filter out low-quality SCIP / heuristic edges.
 */
export interface ListEdgesOptions {
  readonly types?: readonly RelationType[];
  readonly fromIds?: readonly string[];
  readonly toIds?: readonly string[];
  readonly minConfidence?: number;
  readonly limit?: number;
  readonly offset?: number;
}

/** Options for {@link IGraphStore.listEdgesByType}. */
export interface ListEdgesByTypeOptions {
  readonly fromIds?: readonly string[];
  readonly toIds?: readonly string[];
  readonly minConfidence?: number;
  readonly limit?: number;
}

/** Options for {@link IGraphStore.listFindings}. */
export interface ListFindingsOptions {
  readonly severity?: readonly ("note" | "warning" | "error")[];
  readonly ruleId?: string;
  readonly baselineState?: readonly ("new" | "unchanged" | "updated" | "absent")[];
  /** When set, narrows to suppressed (`true`) or non-suppressed (`false`) findings. */
  readonly suppressed?: boolean;
  readonly limit?: number;
}

/** Options for {@link IGraphStore.listDependencies}. */
export interface ListDependenciesOptions {
  readonly ecosystem?: string;
  readonly licenseTier?: readonly (
    | "permissive"
    | "weak-copyleft"
    | "strong-copyleft"
    | "proprietary"
    | "unknown"
  )[];
  readonly limit?: number;
}

/** Options for {@link IGraphStore.listRoutes}. */
export interface ListRoutesOptions {
  readonly methods?: readonly ("GET" | "POST" | "PUT" | "DELETE" | "PATCH")[];
  readonly pathLike?: string;
  readonly limit?: number;
}

/** Options for {@link IGraphStore.traverseAncestors}. */
export interface AncestorTraversalOptions {
  /** Node id to start the walk from. */
  readonly fromId: string;
  /** Edge types to traverse. Empty array → no traversal. */
  readonly edgeTypes: readonly RelationType[];
  /** Maximum traversal depth. Clamped to non-negative integer. */
  readonly maxDepth: number;
  /** Optional confidence floor; edges below this score are skipped. */
  readonly minConfidence?: number;
}

/** Options for {@link IGraphStore.traverseDescendants}. Symmetric to {@link AncestorTraversalOptions}. */
export interface DescendantTraversalOptions {
  readonly fromId: string;
  readonly edgeTypes: readonly RelationType[];
  readonly maxDepth: number;
  readonly minConfidence?: number;
}

/**
 * One producer-consumer pair returned by
 * {@link IGraphStore.listConsumerProducerEdges}. Each row represents a
 * FETCHES edge whose target is a Route node on the producer side; both
 * endpoints carry their owning repo's `repo_uri`.
 */
export interface ConsumerProducerEdge {
  readonly consumerNodeId: string;
  readonly consumerRepoUri: string;
  readonly producerNodeId: string;
  readonly producerRepoUri: string;
  readonly httpMethod: string;
  readonly httpPath: string;
}

export interface BulkLoadStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly durationMs: number;
}

export interface BulkLoadOptions {
  /**
   * `"replace"` (default) clears the existing rows before inserting. `"upsert"`
   * INSERTs with ON CONFLICT DO UPDATE — existing rows for ids not present in
   * the incoming graph are retained. Use `"upsert"` from the incremental
   * indexing pipeline so a partial re-index of changed files does not drop
   * unrelated rows.
   */
  readonly mode?: "replace" | "upsert";
}

/**
 * Granularity tiers for hierarchical embeddings (P03). A single `embeddings`
 * table carries rows at every tier; the discriminator column lets callers
 * restrict the HNSW traversal via a WHERE filter pushed into `hnsw_acorn`.
 *
 * - `"symbol"` — one vector per callable symbol (v1.0 behaviour).
 * - `"file"` — one vector per file (coarse tier used by `--zoom`).
 * - `"community"` — one vector per Community node (architectural tier).
 */
export type EmbeddingGranularity = "symbol" | "file" | "community";

export interface EmbeddingRow {
  readonly nodeId: string;
  /**
   * Tier the row belongs to. Optional on the TypeScript interface so legacy
   * callers that build rows without explicitly setting it still compile; the
   * DuckDB DDL defaults NULL inputs to `'symbol'` so the on-disk row always
   * carries a value. Writers produced by P03 always set this explicitly.
   */
  readonly granularity?: EmbeddingGranularity;
  readonly chunkIndex: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly vector: Float32Array;
  readonly contentHash: string;
}

export interface SearchQuery {
  readonly text: string;
  readonly kinds?: readonly string[];
  readonly limit?: number;
}

export interface SearchResult {
  readonly nodeId: string;
  readonly score: number;
  readonly filePath: string;
  readonly name: string;
  readonly kind: string;
  /**
   * Populated by the MCP / CLI query surfaces after the base search when a
   * `symbol_summaries` row exists for this node (see {@link SymbolSummaryRow}).
   * The storage-layer `search()` call never fills this — it is always a
   * post-join, driven by the P04 summarize-enrichment path.
   */
  readonly summary?: string;
  /** Compact one-line gist of the signature, mirroring `SymbolSummaryRow.signatureSummary`. */
  readonly signatureSummary?: string;
}

export interface VectorQuery {
  readonly vector: Float32Array;
  /**
   * A SQL predicate fragment evaluated against the `embeddings` table joined
   * to `nodes` (aliased `n`). Example: `n.kind = ?`. Use `?` placeholders and
   * supply values via `params`.
   *
   * NOTE — Layer-2 leak (architecture-revised §AC-A-6). This raw SQL
   * predicate is a temporary surface; AC-A-6 replaces it with typed
   * finder shapes (`kindFilter`, `confidenceFloor`, etc.). Do not add
   * new callers that depend on raw SQL here.
   */
  readonly whereClause?: string;
  readonly params?: readonly SqlParam[];
  readonly limit?: number;
  /**
   * Restrict the search to rows at one or more granularity tiers (P03).
   * When omitted the search sees every row regardless of tier — that matches
   * the v1.0 behaviour where only 'symbol' rows existed. Passed through to
   * `hnsw_acorn` as a WHERE filter (`granularity = ?` or `granularity IN
   * (?,?,…)`), which keeps the single HNSW index serving every tier.
   */
  readonly granularity?: EmbeddingGranularity | readonly EmbeddingGranularity[];
}

export interface VectorResult {
  readonly nodeId: string;
  readonly distance: number;
}

export interface TraverseQuery {
  readonly startId: string;
  readonly relationTypes?: readonly string[];
  readonly direction: "up" | "down" | "both";
  readonly maxDepth: number;
  readonly minConfidence?: number;
}

export interface TraverseResult {
  readonly nodeId: string;
  readonly depth: number;
  readonly path: readonly string[];
}

export interface StoreMeta {
  readonly schemaVersion: string;
  readonly lastCommit?: string;
  readonly indexedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly stats?: Record<string, number>;
  /**
   * Fraction in [0, 1] of files that were served from the parse-cache during
   * the last index run. Populated by 's content-cache. Optional so
   * pre-v1.1 stores keep round-tripping.
   */
  readonly cacheHitRatio?: number;
  /** Total size, in bytes, of the `.codehub/parse-cache/` sidecar. */
  readonly cacheSizeBytes?: number;
  /** ISO-8601 timestamp of the last parse-cache compaction pass. */
  readonly lastCompaction?: string;
}
