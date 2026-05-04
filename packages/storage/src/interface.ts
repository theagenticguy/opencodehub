/**
 * Storage abstraction for OpenCodeHub knowledge graphs.
 *
 * The interface is designed around DuckDB as the primary backend, but every
 * method uses plain TypeScript types so alternate adapters (LanceDB is the
 * primary forward-compatible candidate) can slot in behind the same seam.
 */

import type { KnowledgeGraph } from "@opencodehub/core-types";

export interface IGraphStore extends CochangeStore, SymbolSummaryStore {
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
   * Return every prior `content_hash` from the `embeddings` table keyed by
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
  /** Run a user-supplied read-only SQL statement with bound parameters. */
  query(
    sql: string,
    params?: readonly SqlParam[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<readonly Record<string, unknown>[]>;
  /** Full-text search over symbol name / signature / description via BM25. */
  search(q: SearchQuery): Promise<readonly SearchResult[]>;
  /** Filter-aware HNSW vector search. */
  vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]>;
  /** Depth-bounded graph traversal with optional confidence / relation filters. */
  traverse(q: TraverseQuery): Promise<readonly TraverseResult[]>;
  /** Fetch the last-written store metadata, if any. */
  getMeta(): Promise<StoreMeta | undefined>;
  /** Upsert the store metadata row. */
  setMeta(meta: StoreMeta): Promise<void>;
  /** Minimal connectivity probe. */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

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

/** Options for {@link CochangeStore.lookupCochangesForFile}. */
export interface CochangeLookupOptions {
  readonly limit?: number;
  /**
   * Drop rows below this lift floor. Default is 1.0 so callers never see
   * associations weaker than chance.
   */
  readonly minLift?: number;
}

/**
 * Storage surface for the `cochanges` table. Kept separate from the main
 * graph store on the interface level so alternate backends can implement it
 * (or omit it entirely) without forcing a reshuffle of `IGraphStore`. In the
 * DuckDB adapter both surfaces resolve to the same class.
 */
export interface CochangeStore {
  /** Replace the cochanges table contents with the supplied rows. */
  bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void>;
  /**
   * Fetch cochange rows for one file in either direction. Results are sorted
   * by `lift` descending so the strongest associations come first.
   */
  lookupCochangesForFile(
    file: string,
    opts?: CochangeLookupOptions,
  ): Promise<readonly CochangeRow[]>;
  /** Fetch the single cochange row (if any) for an ordered pair of files. */
  lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined>;
}

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
 * Storage surface for the `symbol_summaries` table. Kept on its own so
 * alternate backends can implement (or omit) the summarize lane without
 * reshuffling {@link IGraphStore}. The DuckDB adapter satisfies both.
 */
export interface SymbolSummaryStore {
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

/** JS types that can safely round-trip as DuckDB query parameters at MVP. */
export type SqlParam = string | number | bigint | boolean | null;

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
