/**
 * Graph-database backend for {@link IGraphStore} (phase-1 scaffolding).
 *
 * This adapter is the second implementation behind the `IGraphStore` seam.
 * DuckDbStore remains the default through M7; this file ships the class
 * shell, the lazy-import contract for the native binding, and stubs that
 * throw `NotImplementedError` with a clear "graph-db: <method>" message so
 * downstream code can compile against the new backend while AC-M3-2,
 * AC-M3-3 and AC-M3-4 fill in the real behaviour.
 *
 * Design notes (spec 004 §Architectural decisions):
 *   1. Rel tables are polymorphic per edge kind — one named rel table per
 *      relation type, each with multiple `FROM/TO` pairs. The DDL lives in
 *      {@link graphdb-schema.ts}; this file never emits Cypher inline.
 *   2. Source-level naming avoids the banned clean-room literals. The class
 *      is {@link GraphDbStore}; files are `graphdb-*.ts`. The native binding
 *      package `@ladybugdb/core` is a dep, not a source-level identifier.
 *
 * Lifecycle mirrors {@link DuckDbStore}: open → createSchema → bulkLoad →
 * query / search / vectorSearch / traverse → close.
 */

import type { KnowledgeGraph } from "@opencodehub/core-types";
import { GraphDbPool, type GraphDbPoolConfig } from "./graphdb-pool.js";
import type {
  BulkLoadOptions,
  BulkLoadStats,
  CochangeLookupOptions,
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
} from "./interface.js";

export interface GraphDbStoreOptions {
  readonly readOnly?: boolean;
  /** Fixed vector dimension for the embeddings rel table. Default 768. */
  readonly embeddingDim?: number;
  /** Default query timeout for `query()` calls in ms. Default 5000. */
  readonly timeoutMs?: number;
  /**
   * Overrides for the underlying connection pool. Tests inject a fake
   * `binding` to avoid the native dep; production callers rely on
   * defaults.
   */
  readonly poolConfig?: GraphDbPoolConfig;
}

const DEFAULT_EMBEDDING_DIM = 768;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Thrown by every stubbed method in this AC. AC-M3-2 / AC-M3-3 / AC-M3-4
 * replace the throws with real implementations. The message always carries
 * the method name so callers can diff easily against expected coverage.
 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`graph-db: ${method} not yet wired (AC-M3-2/3/4)`);
    this.name = "NotImplementedError";
  }
}

/**
 * Missing peer-binding error. Surfaced when the native `@ladybugdb/core`
 * module is not available on the current platform (no prebuilt binary, or
 * the package was pruned by a `--production` install). The message satisfies
 * spec 004 §S-M3-2.
 */
export class GraphDbBindingError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      "@ladybugdb/core native binding unavailable on this platform; " +
        `use CODEHUB_STORE=duck. Underlying cause: ${detail}`,
    );
    this.name = "GraphDbBindingError";
  }
}

export class GraphDbStore implements IGraphStore {
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly embeddingDim: number;
  private readonly defaultTimeoutMs: number;
  private readonly poolConfig: GraphDbPoolConfig;
  private pool: GraphDbPool | null = null;

  constructor(path: string, opts: GraphDbStoreOptions = {}) {
    this.path = path;
    this.readOnly = opts.readOnly === true;
    this.embeddingDim = opts.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.poolConfig = opts.poolConfig ?? {};
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async open(): Promise<void> {
    if (this.pool?.isOpen()) return;
    // Surface missing-binding failures as a typed error per spec 004 §S-M3-2.
    // The pool's own lazy import would produce a raw module-not-found error
    // otherwise. When the caller injected a `binding` in `poolConfig` (tests)
    // we skip the probe — the fake already provides the types.
    if (!this.poolConfig.binding) {
      try {
        await import("@ladybugdb/core");
      } catch (err) {
        throw new GraphDbBindingError(err);
      }
    }
    this.pool = new GraphDbPool(this.path, {
      ...this.poolConfig,
      readOnly: this.poolConfig.readOnly ?? this.readOnly,
    });
    await this.pool.open();
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    await pool.close();
  }

  async createSchema(): Promise<void> {
    throw new NotImplementedError("createSchema");
  }

  // --------------------------------------------------------------------------
  // Bulk load
  // --------------------------------------------------------------------------

  async bulkLoad(_graph: KnowledgeGraph, _opts?: BulkLoadOptions): Promise<BulkLoadStats> {
    throw new NotImplementedError("bulkLoad");
  }

  // --------------------------------------------------------------------------
  // Embeddings
  // --------------------------------------------------------------------------

  async upsertEmbeddings(_rows: readonly EmbeddingRow[]): Promise<void> {
    throw new NotImplementedError("upsertEmbeddings");
  }

  async listEmbeddingHashes(): Promise<Map<string, string>> {
    throw new NotImplementedError("listEmbeddingHashes");
  }

  // --------------------------------------------------------------------------
  // Query surfaces
  // --------------------------------------------------------------------------

  async query(
    sql: string,
    params?: readonly SqlParam[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<readonly Record<string, unknown>[]> {
    if (!this.pool) {
      throw new Error("graph-db: query called before open()");
    }
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return this.pool.query(sql, params, { timeoutMs });
  }

  async search(_q: SearchQuery): Promise<readonly SearchResult[]> {
    throw new NotImplementedError("search");
  }

  async vectorSearch(_q: VectorQuery): Promise<readonly VectorResult[]> {
    throw new NotImplementedError("vectorSearch");
  }

  async traverse(_q: TraverseQuery): Promise<readonly TraverseResult[]> {
    throw new NotImplementedError("traverse");
  }

  // --------------------------------------------------------------------------
  // Meta + health
  // --------------------------------------------------------------------------

  async getMeta(): Promise<StoreMeta | undefined> {
    throw new NotImplementedError("getMeta");
  }

  async setMeta(_meta: StoreMeta): Promise<void> {
    throw new NotImplementedError("setMeta");
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    if (!this.pool?.isOpen()) {
      return { ok: false, message: "graph-db: pool not open" };
    }
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // CochangeStore
  // --------------------------------------------------------------------------

  async bulkLoadCochanges(_rows: readonly CochangeRow[]): Promise<void> {
    throw new NotImplementedError("bulkLoadCochanges");
  }

  async lookupCochangesForFile(
    _file: string,
    _opts?: CochangeLookupOptions,
  ): Promise<readonly CochangeRow[]> {
    throw new NotImplementedError("lookupCochangesForFile");
  }

  async lookupCochangesBetween(_fileA: string, _fileB: string): Promise<CochangeRow | undefined> {
    throw new NotImplementedError("lookupCochangesBetween");
  }

  // --------------------------------------------------------------------------
  // SymbolSummaryStore
  // --------------------------------------------------------------------------

  async bulkLoadSymbolSummaries(_rows: readonly SymbolSummaryRow[]): Promise<void> {
    throw new NotImplementedError("bulkLoadSymbolSummaries");
  }

  async lookupSymbolSummary(
    _nodeId: string,
    _contentHash: string,
    _promptVersion: string,
  ): Promise<SymbolSummaryRow | undefined> {
    throw new NotImplementedError("lookupSymbolSummary");
  }

  async lookupSymbolSummariesByNode(
    _nodeIds: readonly string[],
  ): Promise<readonly SymbolSummaryRow[]> {
    throw new NotImplementedError("lookupSymbolSummariesByNode");
  }

  // --------------------------------------------------------------------------
  // Internal getters retained so later ACs can inspect configured defaults
  // without reaching past the private modifier through `any` casts.
  // --------------------------------------------------------------------------

  getPath(): string {
    return this.path;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  getEmbeddingDim(): number {
    return this.embeddingDim;
  }

  getDefaultTimeoutMs(): number {
    return this.defaultTimeoutMs;
  }
}
