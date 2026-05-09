/**
 * DuckDB-backed adapter for the storage interfaces.
 *
 * Per AC-A-1, this class implements BOTH {@link IGraphStore} and
 * {@link ITemporalStore} over a single `DuckDBConnection`. The legacy
 * `DuckDbStore` class export is retained as the bridge type for the
 * 41 type-pin call sites that AC-A-5 will migrate gradually — its
 * instances satisfy the union of both surfaces.
 *
 * When a caller composes a {@link OpenStoreResult} with `backend: "duck"`,
 * the same `DuckDbStore` instance is returned as both the `graph` view
 * and the `temporal` view (no second file). When `backend: "lbug"`,
 * `GraphDbStore` provides the graph view and a separate `DuckDbStore`
 * instance over `<path>.temporal.duckdb` provides the temporal view.
 *
 * Lifecycle: `open` → `createSchema` → `bulkLoad` (once per index run) →
 * `query` / `exec` / `search` / `vectorSearch` / `traverse` against the
 * same connection → `close`.
 *
 * Extensions:
 *   - `hnsw_acorn` (community extension) — registers an `HNSW` index type
 *     that respects WHERE clauses via ACORN-1. If the install fails at open
 *     time (e.g. no network on first use, or the community registry is
 *     unavailable), we fall back to `vss` and `vectorSearch` emits an
 *     explanatory warning; vector queries may then return unfiltered
 *     results on small / highly-selective datasets.
 *   - `fts` (official) — enables `PRAGMA create_fts_index` + `match_bm25`.
 *
 * Timeouts are enforced by a JS-side interrupt timer rather than a DuckDB
 * SQL setting — DuckDB does not expose a per-statement timeout.
 */

import {
  ARRAY,
  arrayValue,
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBPreparedStatement,
  FLOAT,
  listValue,
} from "@duckdb/node-api";
import {
  type CodeRelation,
  canonicalJson,
  type DependencyNode,
  type FindingNode,
  type GraphNode,
  type KnowledgeGraph,
  type NodeKind,
  type NodeOfKind,
  type RelationType,
  type RepoNode,
  type RouteNode,
} from "@opencodehub/core-types";
import { dedupeLastById, NODE_COLUMNS, nodeToColumns } from "./column-encode.js";
import type {
  AncestorTraversalOptions,
  BulkLoadOptions,
  BulkLoadStats,
  CochangeLookupOptions,
  CochangeRow,
  ConsumerProducerEdge,
  DescendantTraversalOptions,
  EmbeddingRow,
  GraphDialect,
  IGraphStore,
  ITemporalStore,
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
  SqlParam,
  StoreMeta,
  SymbolSummaryRow,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "./interface.js";
import { generateSchemaDDL } from "./schema-ddl.js";
import { assertReadOnlySql } from "./sql-guard.js";

export interface DuckDbStoreOptions {
  readonly readOnly?: boolean;
  /** Fixed vector dimension for the `embeddings.vector` column. Default 768. */
  readonly embeddingDim?: number;
  /** Default query timeout for `query()` calls in ms. Default 5000. */
  readonly timeoutMs?: number;
}

const DEFAULT_EMBEDDING_DIM = 768;
const DEFAULT_TIMEOUT_MS = 5_000;
// NOTE: widened to `readonly string[]` so new relation names added by the
// core-types v1.1 migration (FOUND_IN / DEPENDS_ON / OWNED_BY) can be
// defaulted here without a tight coupling to the compile-time union. Ordering
// is preserved from the v1.0 list; new types are appended. COCHANGES is no
// longer in this list — it lives in the dedicated `cochanges` table.
const ALL_RELATION_TYPES: readonly string[] = [
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "HAS_METHOD",
  "HAS_PROPERTY",
  "ACCESSES",
  "METHOD_OVERRIDES",
  "OVERRIDES",
  "METHOD_IMPLEMENTS",
  "MEMBER_OF",
  "PROCESS_STEP",
  "HANDLES_ROUTE",
  "FETCHES",
  "HANDLES_TOOL",
  "ENTRY_POINT_OF",
  "WRAPS",
  "QUERIES",
  "REFERENCES",
  "FOUND_IN",
  "DEPENDS_ON",
  "OWNED_BY",
];

const DEFAULT_COCHANGE_LOOKUP_LIMIT = 10;
const DEFAULT_COCHANGE_MIN_LIFT = 1.0;

/**
 * Concrete adapter that satisfies both {@link IGraphStore} (graph-tier)
 * and {@link ITemporalStore} (tabular-tier) over a single DuckDB
 * connection. The class export remains the legacy bridge type that the
 * 41 AC-A-5 type-pin sites continue to consume; new code should call
 * `openStore(...)` and route through `OpenStoreResult.graph` /
 * `OpenStoreResult.temporal` rather than reaching for the concrete class.
 */
export class DuckDbStore implements IGraphStore, ITemporalStore {
  /**
   * DuckDB exposes no public Cypher entry point — typed finders cover the
   * graph reads. Stamped as `"none"` for the {@link IGraphStore.dialect}
   * marker introduced in AC-A-1.
   */
  readonly dialect: GraphDialect = "none";
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly embeddingDim: number;
  private readonly defaultTimeoutMs: number;
  private instance: DuckDBInstance | undefined;
  private conn: DuckDBConnection | undefined;
  private vectorExtension: "hnsw_acorn" | "vss" | "none" = "none";
  private extensionWarning?: string;

  constructor(path: string, opts: DuckDbStoreOptions = {}) {
    this.path = path;
    this.readOnly = opts.readOnly === true;
    this.embeddingDim = opts.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async open(): Promise<void> {
    if (this.instance) return;
    const options: Record<string, string> = {
      access_mode: this.readOnly ? "READ_ONLY" : "READ_WRITE",
    };
    this.instance = await DuckDBInstance.create(this.path, options);
    this.conn = await this.instance.connect();

    if (!this.readOnly) {
      await this.loadExtensions();
    } else {
      // In read-only mode we can still LOAD (without INSTALL) already-cached
      // extensions; best-effort so existing indexes remain queryable.
      await this.tryLoadCachedExtension("hnsw_acorn");
      await this.tryLoadCachedExtension("fts");
    }
  }

  async close(): Promise<void> {
    this.conn?.closeSync();
    this.conn = undefined;
    this.instance?.closeSync();
    this.instance = undefined;
  }

  async createSchema(): Promise<void> {
    const c = this.requireConn();
    const stmts = generateSchemaDDL({ embeddingDim: this.embeddingDim });
    for (const stmt of stmts) {
      await c.run(stmt);
    }
  }

  // --------------------------------------------------------------------------
  // Extensions
  // --------------------------------------------------------------------------

  private async loadExtensions(): Promise<void> {
    const c = this.requireConn();
    // 1. HNSW index. Prefer hnsw_acorn; fall back to stock vss.
    try {
      await c.run("INSTALL hnsw_acorn FROM community;");
      await c.run("LOAD hnsw_acorn;");
      this.vectorExtension = "hnsw_acorn";
      // ACORN-1 kicks in only when WHERE-clause selectivity is below this
      // threshold (default 0.6). On small graphs (e.g. tests, freshly
      // indexed small repos) selectivity routinely sits above that, so the
      // planner may skip the filter. Force ACORN always.
      await c.run("SET hnsw_acorn_threshold = 1.0;");
      // HNSW indexes are in-memory by default. Enabling this lets us persist
      // them into the DuckDB file so vector search survives a close/open.
      await c.run("SET hnsw_enable_experimental_persistence = true;");
    } catch (firstErr) {
      try {
        await c.run("INSTALL vss;");
        await c.run("LOAD vss;");
        this.vectorExtension = "vss";
        await c.run("SET hnsw_enable_experimental_persistence = true;");
        this.extensionWarning =
          "hnsw_acorn not available; fell back to vss. Filter-aware vector " +
          "search may return extra rows on selective WHERE clauses.";
      } catch (secondErr) {
        this.vectorExtension = "none";
        this.extensionWarning =
          `No HNSW extension available. Vector search disabled. ` +
          `Causes: ${(firstErr as Error).message} / ${(secondErr as Error).message}`;
      }
    }
    // 2. BM25 full-text search.
    try {
      await c.run("INSTALL fts;");
      await c.run("LOAD fts;");
    } catch (err) {
      throw new Error(`Failed to load fts extension: ${(err as Error).message}`);
    }
  }

  private async tryLoadCachedExtension(name: string): Promise<void> {
    const c = this.requireConn();
    try {
      await c.run(`LOAD ${name};`);
      if (name === "hnsw_acorn") this.vectorExtension = "hnsw_acorn";
    } catch {
      // swallow — read-only opens shouldn't fail because an extension is missing
    }
  }

  /** Surface the warning so callers can log it. Undefined if everything loaded. */
  getExtensionWarning(): string | undefined {
    return this.extensionWarning;
  }

  // --------------------------------------------------------------------------
  // Bulk load
  // --------------------------------------------------------------------------

  async bulkLoad(graph: KnowledgeGraph, opts: BulkLoadOptions = {}): Promise<BulkLoadStats> {
    const c = this.requireConn();
    const started = performance.now();
    const mode = opts.mode ?? "replace";

    await c.run("BEGIN TRANSACTION");
    try {
      if (mode === "replace") {
        await c.run("DELETE FROM nodes");
        await c.run("DELETE FROM relations");
        await c.run("DELETE FROM cochanges");
      }

      // DuckDB UPSERT issue 8147: rows that collide on the primary key inside
      // a single INSERT are ambiguous. Dedupe the batch first so ON CONFLICT
      // only has to reconcile against already-persisted rows. This is also
      // safe for "replace" mode — the graph's `orderedNodes` already dedupes
      // by id, but we keep the call here so the invariant is explicit.
      const orderedNodes = dedupeLastById(graph.orderedNodes(), (n) => n.id);
      if (orderedNodes.length > 0) {
        await this.insertNodes(orderedNodes, mode);
      }

      const orderedEdges = dedupeLastById(graph.orderedEdges(), (e) => e.id);
      if (orderedEdges.length > 0) {
        await this.insertEdges(orderedEdges, mode);
      }

      await c.run("COMMIT");
    } catch (err) {
      await c.run("ROLLBACK");
      throw err;
    }

    await this.buildPostLoadIndexes();

    const durationMs = performance.now() - started;
    return {
      nodeCount: graph.nodeCount(),
      edgeCount: graph.edgeCount(),
      durationMs,
    };
  }

  private async insertNodes(
    nodes: readonly GraphNode[],
    mode: "replace" | "upsert",
  ): Promise<void> {
    const c = this.requireConn();
    // Keep in sync with schema-ddl.ts. Order matters: `NODE_COLUMNS[0]` must
    // be "id" so the ON CONFLICT target aligns with the primary key and the
    // DO UPDATE SET clause below skips slot 0.
    const columnList = NODE_COLUMNS.join(", ");
    const placeholders = NODE_COLUMNS.map(() => "?").join(", ");
    // DuckDB UPSERT issue 16698: never SET `id = excluded.id` in the DO
    // UPDATE clause — it causes silent corruption. We build the update list
    // from every column EXCEPT id.
    const updateAssignments = NODE_COLUMNS.slice(1)
      .map((col) => `${col} = excluded.${col}`)
      .join(", ");
    const sql =
      mode === "upsert"
        ? `INSERT INTO nodes (${columnList}) VALUES (${placeholders})
           ON CONFLICT (id) DO UPDATE SET ${updateAssignments}`
        : `INSERT INTO nodes (${columnList}) VALUES (${placeholders})`;

    const stmt = await c.prepare(sql);
    try {
      for (const node of nodes) {
        stmt.clearBindings();
        const row = nodeToRow(node);
        for (let i = 0; i < row.length; i += 1) {
          bindParam(stmt, i + 1, row[i] ?? null);
        }
        await stmt.run();
      }
    } finally {
      stmt.destroySync();
    }
  }

  private async insertEdges(
    edges: readonly {
      readonly id: string;
      readonly from: string;
      readonly to: string;
      readonly type: RelationType;
      readonly confidence: number;
      readonly reason?: string;
      readonly step?: number;
    }[],
    mode: "replace" | "upsert",
  ): Promise<void> {
    const c = this.requireConn();
    const sql =
      mode === "upsert"
        ? `INSERT INTO relations (id, from_id, to_id, type, confidence, reason, step)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             from_id = excluded.from_id,
             to_id = excluded.to_id,
             type = excluded.type,
             confidence = excluded.confidence,
             reason = excluded.reason,
             step = excluded.step`
        : "INSERT INTO relations (id, from_id, to_id, type, confidence, reason, step) VALUES (?, ?, ?, ?, ?, ?, ?)";
    const stmt = await c.prepare(sql);
    try {
      for (const e of edges) {
        stmt.clearBindings();
        bindParam(stmt, 1, e.id);
        bindParam(stmt, 2, e.from);
        bindParam(stmt, 3, e.to);
        bindParam(stmt, 4, e.type);
        bindParam(stmt, 5, e.confidence);
        bindParam(stmt, 6, e.reason ?? null);
        bindParam(stmt, 7, e.step ?? 0);
        await stmt.run();
      }
    } finally {
      stmt.destroySync();
    }
  }

  private async buildPostLoadIndexes(): Promise<void> {
    if (this.readOnly) return;
    const c = this.requireConn();
    // FTS over the polymorphic nodes table. Must be rebuilt after rows change.
    // PRAGMA drop is idempotent-friendly via `overwrite=1`.
    await c.run(
      "PRAGMA create_fts_index('nodes', 'id', 'name', 'signature', 'description', overwrite=1);",
    );
    // HNSW vector index — only meaningful once the extension is loaded and
    // at least one embedding row exists.
    if (this.vectorExtension !== "none") {
      const countReader = await c.runAndReadAll("SELECT COUNT(*) AS n FROM embeddings");
      const rows = countReader.getRowObjects();
      const first = rows[0];
      const n = first ? Number((first as { n: unknown }).n) : 0;
      if (n > 0) {
        await c.run(
          "CREATE INDEX IF NOT EXISTS idx_embeddings_vec ON embeddings USING HNSW (vector);",
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Embeddings
  // --------------------------------------------------------------------------

  async upsertEmbeddings(rows: readonly EmbeddingRow[]): Promise<void> {
    if (rows.length === 0) return;
    const c = this.requireConn();
    const dim = this.embeddingDim;
    const arrType = ARRAY(FLOAT, dim);

    await c.run("BEGIN TRANSACTION");
    try {
      // Remove any pre-existing rows with matching (node_id, granularity,
      // chunk_index) so this method is effectively an upsert. The id column
      // encodes granularity now (`Emb:<tier>:<nodeId>:<chunkIndex>`) so two
      // tiers pointing at the same underlying node never collide on the
      // primary key.
      const delStmt = await c.prepare(
        "DELETE FROM embeddings WHERE node_id = ? AND granularity = ? AND chunk_index = ?",
      );
      try {
        for (const r of rows) {
          const granularity = r.granularity ?? "symbol";
          delStmt.clearBindings();
          delStmt.bindVarchar(1, r.nodeId);
          delStmt.bindVarchar(2, granularity);
          delStmt.bindInteger(3, r.chunkIndex);
          await delStmt.run();
        }
      } finally {
        delStmt.destroySync();
      }

      const insStmt = await c.prepare(
        "INSERT INTO embeddings (id, node_id, granularity, chunk_index, start_line, end_line, vector, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      try {
        for (const r of rows) {
          if (r.vector.length !== dim) {
            throw new Error(
              `Embedding dimension mismatch: got ${r.vector.length}, expected ${dim}`,
            );
          }
          const granularity = r.granularity ?? "symbol";
          insStmt.clearBindings();
          // Id includes the tier so cross-tier collisions on `(nodeId,
          // chunkIndex)` are impossible. Legacy rows produced before P03
          // used `Emb:<nodeId>:<chunkIndex>`; DuckDB lets two rows coexist
          // across schema versions as long as the PK is unique within the
          // on-disk file, which this scheme guarantees.
          insStmt.bindVarchar(1, `Emb:${granularity}:${r.nodeId}:${r.chunkIndex}`);
          insStmt.bindVarchar(2, r.nodeId);
          insStmt.bindVarchar(3, granularity);
          insStmt.bindInteger(4, r.chunkIndex);
          bindParam(insStmt, 5, r.startLine ?? null);
          bindParam(insStmt, 6, r.endLine ?? null);
          insStmt.bindArray(7, arrayValue(Array.from(r.vector)), arrType);
          insStmt.bindVarchar(8, r.contentHash);
          await insStmt.run();
        }
      } finally {
        insStmt.destroySync();
      }

      await c.run("COMMIT");
    } catch (err) {
      await c.run("ROLLBACK");
      throw err;
    }
  }

  /**
   * @internal
   * Stream the `embeddings` table to a Parquet file via DuckDB's built-in
   * `COPY ... TO ... (FORMAT PARQUET, COMPRESSION ZSTD)`. Backs the M5 BOM
   * item #7 (Parquet sidecar) for `@opencodehub/pack`.
   *
   * **NOT part of the public storage surface.** AC-A-4 reframed the
   * embeddings sidecar as a packaging concern, owned by `@opencodehub/pack`.
   * This method survives as a DuckDB-only helper that pack's
   * `writeEmbeddingsSidecar` invokes after narrowing `store.temporal` (or
   * `store.graph` when `backend === "duck"`) to a {@link DuckDbStore}.
   * Third-party {@link IGraphStore} / {@link ITemporalStore} implementations
   * MUST NOT implement it — pack stamps `determinismClass: "degraded"`
   * automatically when the helper is unreachable.
   *
   * Determinism contract — must hold byte-for-byte across two runs against
   * the same on-disk DuckDB file:
   *   - Row ordering is `node_id ASC, granularity ASC, chunk_index ASC`. The
   *     COPY pipes the SELECT result directly so the Parquet row groups
   *     materialize in that order.
   *   - ZSTD compression at the DuckDB default level. The default is
   *     deterministic; do NOT pass an explicit level — that would couple the
   *     output to whichever level the caller picked and risk byte drift.
   *   - DuckDB v1.3.0+ ("Ossivalis") rewrote the parquet writer to drop the
   *     implicit timestamps that previously broke byte-identity. The
   *     `created_by` metadata still embeds the engine version string, so we
   *     surface that string to the caller via `duckdbVersion` and the pack
   *     manifest pins it (`PackPins.duckdbVersion`).
   *
   * When the embeddings table is empty, NO file is written (S-M5-3 contract
   * for the pack BOM); the caller is expected to skip the BomItem entirely.
   *
   * Caller MUST pass an absolute path. Path is interpolated into the SQL
   * statement after a strict format check (alphanumerics + `/_-.` only and
   * leading `/` required) so injection attempts via path-as-input are
   * blocked. We do not parameterize the COPY target because DuckDB's
   * prepared-statement parser does not bind COPY destinations.
   */
  async exportEmbeddingsParquet(
    absOutPath: string,
  ): Promise<{ readonly rowCount: number; readonly duckdbVersion: string }> {
    const c = this.requireConn();
    const duckdbVersion = await this.fetchDuckdbVersion();

    const countReader = await c.runAndReadAll("SELECT COUNT(*) AS n FROM embeddings");
    const countRows = countReader.getRowObjects();
    const first = countRows[0];
    const rowCount = first ? Number((first as { n: unknown }).n) : 0;

    if (rowCount === 0) {
      return { rowCount: 0, duckdbVersion };
    }

    if (!isSafeAbsolutePath(absOutPath)) {
      throw new Error(
        "exportEmbeddingsParquet: outPath must be an absolute path with safe characters " +
          "(alphanumerics, slash, underscore, dash, dot)",
      );
    }

    // COPY does not accept bound parameters for the destination. The path
    // has been validated above so single-quote injection is impossible
    // (the safe-path regex rejects quotes outright).
    const sql =
      `COPY (SELECT node_id, granularity, chunk_index, vector ` +
      `FROM embeddings ORDER BY node_id ASC, granularity ASC, chunk_index ASC) ` +
      `TO '${absOutPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`;
    await c.run(sql);
    return { rowCount, duckdbVersion };
  }

  /**
   * Resolve the live DuckDB engine version via `SELECT version()`. The
   * result is the string DuckDB embeds in the parquet `created_by`
   * metadata, so the pack manifest's `pins.duckdbVersion` stays bound to
   * the writer version that produced the sidecar.
   *
   * Defensive: returns `"unknown"` if the call fails or returns a non-string
   * — older bindings have been observed to return a struct value here.
   */
  private async fetchDuckdbVersion(): Promise<string> {
    const c = this.requireConn();
    try {
      const reader = await c.runAndReadAll("SELECT version() AS v");
      const rows = reader.getRowObjects();
      const v = rows[0] ? (rows[0] as { v?: unknown }).v : undefined;
      return typeof v === "string" && v.length > 0 ? v : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Load every prior `content_hash` from the `embeddings` table keyed by the
   * composite `(granularity, node_id, chunk_index)` tuple. Used by the
   * ingestion embeddings phase to skip re-embedding chunks whose source
   * text is unchanged across runs (T-M1-3).
   *
   * A single `SELECT` round-trip is cheaper than per-chunk lookups and
   * keeps the API surface narrow: the caller gets a `Map` it owns.
   *
   * Key format: `${granularity}\0${node_id}\0${chunk_index}` — binary-safe
   * vs `:` which appears inside NodeIds. Matches the key encoding the
   * embeddings phase uses when probing for hits.
   */
  async listEmbeddingHashes(): Promise<Map<string, string>> {
    const c = this.requireConn();
    const reader = await c.runAndReadAll(
      "SELECT node_id, granularity, chunk_index, content_hash FROM embeddings",
    );
    const rows = reader.getRowObjects();
    const out = new Map<string, string>();
    for (const row of rows) {
      const nodeId = row["node_id"];
      const granularity = row["granularity"];
      const chunkIndex = row["chunk_index"];
      const contentHash = row["content_hash"];
      if (
        typeof nodeId !== "string" ||
        typeof granularity !== "string" ||
        typeof contentHash !== "string" ||
        (typeof chunkIndex !== "number" && typeof chunkIndex !== "bigint")
      ) {
        continue;
      }
      const ci = typeof chunkIndex === "bigint" ? Number(chunkIndex) : chunkIndex;
      out.set(`${granularity}\0${nodeId}\0${ci}`, contentHash);
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Cochanges
  // --------------------------------------------------------------------------

  async bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void> {
    const c = this.requireConn();
    await c.run("BEGIN TRANSACTION");
    try {
      await c.run("DELETE FROM cochanges");
      if (rows.length === 0) {
        await c.run("COMMIT");
        return;
      }
      // Sort by (source_file, target_file) so insertion order is deterministic
      // across runs — matches the ordering discipline used for nodes/edges.
      const sorted = [...rows].sort((a, b) => {
        if (a.sourceFile !== b.sourceFile) {
          return a.sourceFile < b.sourceFile ? -1 : 1;
        }
        return a.targetFile < b.targetFile ? -1 : a.targetFile > b.targetFile ? 1 : 0;
      });
      const stmt = await c.prepare(
        `INSERT INTO cochanges (
          source_file, target_file, cocommit_count,
          total_commits_source, total_commits_target,
          last_cocommit_at, lift
        ) VALUES (?, ?, ?, ?, ?, CAST(? AS TIMESTAMP), ?)`,
      );
      try {
        for (const row of sorted) {
          stmt.clearBindings();
          bindParam(stmt, 1, row.sourceFile);
          bindParam(stmt, 2, row.targetFile);
          bindParam(stmt, 3, row.cocommitCount);
          bindParam(stmt, 4, row.totalCommitsSource);
          bindParam(stmt, 5, row.totalCommitsTarget);
          bindParam(stmt, 6, row.lastCocommitAt);
          bindParam(stmt, 7, row.lift);
          await stmt.run();
        }
      } finally {
        stmt.destroySync();
      }
      await c.run("COMMIT");
    } catch (err) {
      await c.run("ROLLBACK");
      throw err;
    }
  }

  async lookupCochangesForFile(
    file: string,
    opts: CochangeLookupOptions = {},
  ): Promise<readonly CochangeRow[]> {
    const c = this.requireConn();
    const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_COCHANGE_LOOKUP_LIMIT));
    const minLift = opts.minLift ?? DEFAULT_COCHANGE_MIN_LIFT;
    // Rows are keyed by ordered (source_file, target_file) pairs but the
    // signal is symmetric, so probe both directions. Sort by lift DESC so
    // the strongest associations surface first; break ties deterministically
    // on the pair key.
    const stmt = await c.prepare(
      `SELECT source_file, target_file, cocommit_count,
              total_commits_source, total_commits_target,
              last_cocommit_at, lift
         FROM cochanges
        WHERE (source_file = ? OR target_file = ?) AND lift >= ?
        ORDER BY lift DESC, source_file ASC, target_file ASC
        LIMIT ?`,
    );
    try {
      stmt.bindVarchar(1, file);
      stmt.bindVarchar(2, file);
      stmt.bindDouble(3, minLift);
      stmt.bindInteger(4, limit);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const out: CochangeRow[] = [];
      for (const r of raw) {
        out.push(cochangeRowFromRecord(r as Record<string, unknown>));
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  async lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined> {
    const c = this.requireConn();
    const stmt = await c.prepare(
      `SELECT source_file, target_file, cocommit_count,
              total_commits_source, total_commits_target,
              last_cocommit_at, lift
         FROM cochanges
        WHERE (source_file = ? AND target_file = ?)
           OR (source_file = ? AND target_file = ?)
        LIMIT 1`,
    );
    try {
      stmt.bindVarchar(1, fileA);
      stmt.bindVarchar(2, fileB);
      stmt.bindVarchar(3, fileB);
      stmt.bindVarchar(4, fileA);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const first = raw[0];
      if (!first) return undefined;
      return cochangeRowFromRecord(first as Record<string, unknown>);
    } finally {
      stmt.destroySync();
    }
  }

  // --------------------------------------------------------------------------
  // Symbol summaries
  // --------------------------------------------------------------------------

  async bulkLoadSymbolSummaries(rows: readonly SymbolSummaryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const c = this.requireConn();
    // Sort by the composite primary key so insertion order is deterministic
    // across runs — mirrors the cochanges / nodes / relations pattern.
    const sorted = [...rows].sort((a, b) => {
      if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
      if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
      if (a.promptVersion !== b.promptVersion) return a.promptVersion < b.promptVersion ? -1 : 1;
      return 0;
    });

    await c.run("BEGIN TRANSACTION");
    try {
      // Pre-delete matching composite keys so the INSERT is effectively an
      // upsert. Using DELETE+INSERT (rather than ON CONFLICT) keeps the
      // statement small and sidesteps DuckDB issue 8147 when the same key
      // appears multiple times in a single batch after dedupe.
      const delStmt = await c.prepare(
        "DELETE FROM symbol_summaries WHERE node_id = ? AND content_hash = ? AND prompt_version = ?",
      );
      try {
        for (const r of sorted) {
          delStmt.clearBindings();
          delStmt.bindVarchar(1, r.nodeId);
          delStmt.bindVarchar(2, r.contentHash);
          delStmt.bindVarchar(3, r.promptVersion);
          await delStmt.run();
        }
      } finally {
        delStmt.destroySync();
      }

      const insStmt = await c.prepare(
        `INSERT INTO symbol_summaries (
          node_id, content_hash, prompt_version, model_id,
          summary_text, signature_summary, returns_type_summary,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS TIMESTAMP))`,
      );
      try {
        for (const r of sorted) {
          insStmt.clearBindings();
          bindParam(insStmt, 1, r.nodeId);
          bindParam(insStmt, 2, r.contentHash);
          bindParam(insStmt, 3, r.promptVersion);
          bindParam(insStmt, 4, r.modelId);
          bindParam(insStmt, 5, r.summaryText);
          bindParam(insStmt, 6, r.signatureSummary ?? null);
          bindParam(insStmt, 7, r.returnsTypeSummary ?? null);
          bindParam(insStmt, 8, r.createdAt);
          await insStmt.run();
        }
      } finally {
        insStmt.destroySync();
      }
      await c.run("COMMIT");
    } catch (err) {
      await c.run("ROLLBACK");
      throw err;
    }
  }

  async lookupSymbolSummary(
    nodeId: string,
    contentHash: string,
    promptVersion: string,
  ): Promise<SymbolSummaryRow | undefined> {
    const c = this.requireConn();
    const stmt = await c.prepare(
      `SELECT node_id, content_hash, prompt_version, model_id,
              summary_text, signature_summary, returns_type_summary, created_at
         FROM symbol_summaries
        WHERE node_id = ? AND content_hash = ? AND prompt_version = ?
        LIMIT 1`,
    );
    try {
      stmt.bindVarchar(1, nodeId);
      stmt.bindVarchar(2, contentHash);
      stmt.bindVarchar(3, promptVersion);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const first = raw[0];
      if (!first) return undefined;
      return summaryRowFromRecord(first as Record<string, unknown>);
    } finally {
      stmt.destroySync();
    }
  }

  async lookupSymbolSummariesByNode(
    nodeIds: readonly string[],
  ): Promise<readonly SymbolSummaryRow[]> {
    if (nodeIds.length === 0) return [];
    const c = this.requireConn();
    const placeholders = nodeIds.map(() => "?").join(",");
    const stmt = await c.prepare(
      `SELECT node_id, content_hash, prompt_version, model_id,
              summary_text, signature_summary, returns_type_summary, created_at
         FROM symbol_summaries
        WHERE node_id IN (${placeholders})
        ORDER BY node_id ASC, prompt_version ASC, content_hash ASC`,
    );
    try {
      let idx = 1;
      for (const id of nodeIds) stmt.bindVarchar(idx++, id);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const out: SymbolSummaryRow[] = [];
      for (const r of raw) {
        out.push(summaryRowFromRecord(r as Record<string, unknown>));
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Batched query-path join helper: fetch summaries for many nodes in one
   * round trip, returning the newest prompt-version row per node. Built on
   * top of {@link lookupSymbolSummariesByNode} — that method returns rows
   * ordered by `(node_id, prompt_version, content_hash)`, so collapsing to
   * the last row per `node_id` yields the newest prompt version.
   *
   * This is the surface the MCP `query` tool and the CLI `query` command
   * use to enrich search hits with summaries post-P04. The single-row
   * {@link lookupSymbolSummary} remains the cache-probe surface used by
   * the ingestion phase.
   */
  async getSymbolSummariesByNodeIds(
    ids: readonly string[],
  ): Promise<Map<string, SymbolSummaryRow>> {
    const out = new Map<string, SymbolSummaryRow>();
    if (ids.length === 0) return out;
    const uniqIds = Array.from(new Set(ids));
    const rows = await this.lookupSymbolSummariesByNode(uniqIds);
    for (const row of rows) {
      // Rows arrive sorted by (node_id ASC, prompt_version ASC). Overwriting
      // on each id keeps the newest prompt version after the full scan.
      out.set(row.nodeId, row);
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Query surfaces
  // --------------------------------------------------------------------------

  async query(
    sql: string,
    params: readonly SqlParam[] = [],
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    assertReadOnlySql(sql);
    const c = this.requireConn();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return this.withTimeout(timeoutMs, async () => {
      const stmt = await c.prepare(sql);
      try {
        for (let i = 0; i < params.length; i += 1) {
          bindParam(stmt, i + 1, params[i] ?? null);
        }
        const reader = await stmt.runAndReadAll();
        return normalizeRows(reader.getRowObjects());
      } finally {
        stmt.destroySync();
      }
    });
  }

  /**
   * {@link ITemporalStore.exec} implementation — delegates to {@link query}.
   * AC-A-1 introduced this name on the temporal interface so callers that
   * route through `OpenStoreResult.temporal` use the new vocabulary; the
   * original `query()` method stays for the 41 type-pin sites AC-A-5 will
   * migrate.
   */
  async exec(
    sql: string,
    params: readonly SqlParam[] = [],
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    return this.query(sql, params, opts);
  }

  /**
   * Enumerate fully-rehydrated GraphNodes by kind. Backs the M5 BOM bodies
   * (skeleton, file-tree, deps, xrefs) so they can iterate typed nodes
   * without scattering raw SELECT statements across `packages/pack/`.
   *
   * The polymorphic `nodes` table stores wider columns than `NodeBase`
   * (e.g. `version` / `license` / `lockfile_source` / `ecosystem` for
   * Dependency rows; `repo_uri` / `default_branch` / etc. for Repo rows).
   * `SELECT *` is unsafe across kinds because callers downstream rely on
   * field absence to discriminate, so we enumerate every column explicitly
   * and rehydrate via {@link rowToGraphNode}.
   *
   * Determinism: ORDER BY id ASC at the SQL layer + a JS-side lex-stable
   * tiebreak, matching the GraphDbStore implementation byte-for-byte.
   */
  async listNodes(opts: ListNodesOptions = {}): Promise<readonly GraphNode[]> {
    const c = this.requireConn();
    const kinds = opts.kinds;
    // Empty-kinds short-circuit. The contract is "kinds: [] returns []";
    // we never even hit SQL so the round-trip is free.
    if (kinds !== undefined && kinds.length === 0) return [];
    // Same short-circuit semantics for `ids`: an empty array means "no
    // ids match". Adapters de-dupe on the input set so callers can pass
    // a list with repeats.
    const idsRaw = opts.ids;
    if (idsRaw !== undefined && idsRaw.length === 0) return [];
    const ids = idsRaw !== undefined ? Array.from(new Set(idsRaw)) : undefined;
    const limit = clampNonNegativeInt(opts.limit);
    const offset = clampNonNegativeInt(opts.offset);

    const columnList = NODE_COLUMNS.join(", ");
    const wheres: string[] = [];
    if (kinds && kinds.length > 0) {
      wheres.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    }
    if (ids !== undefined && ids.length > 0) {
      wheres.push(`id IN (${ids.map(() => "?").join(", ")})`);
    }
    if (opts.filePath !== undefined) {
      wheres.push("file_path = ?");
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    // ORDER BY id ASC at the SQL layer; LIMIT/OFFSET applied after the
    // filter so paging stays stable across calls. Both clauses are omitted
    // when their values are undefined so the prepared statement plan
    // stays minimal for the common "list everything" case.
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const offsetClause = offset !== undefined ? "OFFSET ?" : "";
    const sql = (
      `SELECT ${columnList} FROM nodes ${whereClause} ` +
      `ORDER BY id ASC ${limitClause} ${offsetClause}`
    ).trim();

    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      if (kinds) {
        for (const k of kinds) {
          stmt.bindVarchar(idx++, k);
        }
      }
      if (ids !== undefined) {
        for (const id of ids) {
          stmt.bindVarchar(idx++, id);
        }
      }
      if (opts.filePath !== undefined) {
        stmt.bindVarchar(idx++, opts.filePath);
      }
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      if (offset !== undefined) stmt.bindInteger(idx++, offset);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const out: GraphNode[] = [];
      for (const row of raw) {
        const node = rowToGraphNode(row);
        if (node) out.push(node);
      }
      // Lex-stable tiebreak on id so both adapters agree byte-for-byte even
      // when the underlying engine's sort collation diverges (DuckDB uses
      // bytewise ASCII; the graph-db engine returns rows in primary-key
      // order which can vary across versions).
      return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } finally {
      stmt.destroySync();
    }
  }

  // --------------------------------------------------------------------------
  // Typed finders — AC-A-6 service-layer foundation
  // --------------------------------------------------------------------------
  //
  // Every method below replaces a pattern-matched raw-SQL site identified in
  // architecture-revised.md §5. SQL strings stay LOCAL to this file — they are
  // never exported from the package surface so consumers cannot reach for the
  // dialect directly.
  //
  // Determinism contract: every finder returns rows in deterministic order so
  // two calls against the same on-disk graph produce byte-identical output.
  // Node finders order by `id ASC`; edge finders order by `(from_id, to_id,
  // type)`; the consumer-producer finder orders by
  // `(consumer_repo_uri, producer_repo_uri, http_method, http_path)`.

  /**
   * Single-kind shorthand. Implemented as a thin wrapper around the
   * existing column-keyed `SELECT ${NODE_COLUMNS} FROM nodes` plus
   * `filePath`/`filePathLike` predicates. Returns rehydrated typed
   * nodes via {@link rowToGraphNode}.
   */
  async listNodesByKind<K extends NodeKind>(
    kind: K,
    opts: ListNodesByKindOptions = {},
  ): Promise<readonly NodeOfKind<K>[]> {
    const c = this.requireConn();
    const limit = clampNonNegativeInt(opts.limit);
    const offset = clampNonNegativeInt(opts.offset);
    const columnList = NODE_COLUMNS.join(", ");

    const wheres: string[] = ["kind = ?"];
    const binds: SqlParam[] = [kind];
    if (opts.filePath !== undefined) {
      wheres.push("file_path = ?");
      binds.push(opts.filePath);
    }
    if (opts.filePathLike !== undefined) {
      wheres.push("file_path LIKE ?");
      binds.push(`%${opts.filePathLike}%`);
    }
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const offsetClause = offset !== undefined ? "OFFSET ?" : "";
    const sql = (
      `SELECT ${columnList} FROM nodes WHERE ${wheres.join(" AND ")} ` +
      `ORDER BY id ASC ${limitClause} ${offsetClause}`
    ).trim();

    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      if (offset !== undefined) stmt.bindInteger(idx++, offset);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const out: GraphNode[] = [];
      for (const row of raw) {
        const node = rowToGraphNode(row);
        if (node) out.push(node);
      }
      // Lex-stable tiebreak on id matches `listNodes` so cross-adapter
      // parity holds.
      const sorted = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // Cast through `unknown`: the SQL filter pinned `kind = K` so every
      // surviving row's `kind` discriminator equals K, but TS can't widen
      // a discriminated-union narrow through an array of GraphNode without
      // help. The structural invariant is enforced above.
      return sorted as unknown as readonly NodeOfKind<K>[];
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * All edges, optionally filtered + paged. Result rows are typed
   * {@link CodeRelation}s. Determinism: ORDER BY `(from_id, to_id, type)`.
   */
  async listEdges(opts: ListEdgesOptions = {}): Promise<readonly CodeRelation[]> {
    const c = this.requireConn();
    return this.listEdgesInternal(c, opts);
  }

  /**
   * Single-type shorthand. Lifts onto {@link listEdges} with the type
   * pinned. Same ordering contract.
   */
  async listEdgesByType(
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

  /**
   * Findings filter. Materializes typed {@link FindingNode}s — the
   * underlying row goes through {@link rowToGraphNode} so wider columns
   * (`baseline_state`, `suppressed_json`, `properties_bag`) come back
   * with the same shape callers see when they read a Finding via
   * `listNodes`.
   */
  async listFindings(opts: ListFindingsOptions = {}): Promise<readonly FindingNode[]> {
    const c = this.requireConn();
    const wheres: string[] = ["kind = 'Finding'"];
    const binds: SqlParam[] = [];
    if (opts.severity && opts.severity.length > 0) {
      const ph = opts.severity.map(() => "?").join(", ");
      wheres.push(`severity IN (${ph})`);
      for (const s of opts.severity) binds.push(s);
    }
    if (opts.ruleId !== undefined) {
      wheres.push("rule_id = ?");
      binds.push(opts.ruleId);
    }
    if (opts.baselineState && opts.baselineState.length > 0) {
      const ph = opts.baselineState.map(() => "?").join(", ");
      wheres.push(`baseline_state IN (${ph})`);
      for (const s of opts.baselineState) binds.push(s);
    }
    if (opts.suppressed === true) {
      wheres.push("suppressed_json IS NOT NULL");
    } else if (opts.suppressed === false) {
      wheres.push("suppressed_json IS NULL");
    }
    const limit = clampNonNegativeInt(opts.limit);
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const columnList = NODE_COLUMNS.join(", ");
    const sql = (
      `SELECT ${columnList} FROM nodes WHERE ${wheres.join(" AND ")} ` +
      `ORDER BY id ASC ${limitClause}`
    ).trim();
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const out: FindingNode[] = [];
      for (const row of raw) {
        const node = rowToGraphNode(row);
        if (node && node.kind === "Finding") out.push(node as FindingNode);
      }
      return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Dependencies filter. `licenseTier` is treated as a license-tier
   * pre-classification: the caller supplies the bucket(s) of interest
   * and the adapter joins through a lightweight in-method classifier
   * keyed on the SPDX `license` column. The classifier rules mirror
   * the OCH license-audit table so {@link listDependencies} returns
   * the same set the audit surface reports for that tier.
   */
  async listDependencies(opts: ListDependenciesOptions = {}): Promise<readonly DependencyNode[]> {
    const c = this.requireConn();
    const wheres: string[] = ["kind = 'Dependency'"];
    const binds: SqlParam[] = [];
    if (opts.ecosystem !== undefined) {
      wheres.push("ecosystem = ?");
      binds.push(opts.ecosystem);
    }
    const limit = clampNonNegativeInt(opts.limit);
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const columnList = NODE_COLUMNS.join(", ");
    const sql = (
      `SELECT ${columnList} FROM nodes WHERE ${wheres.join(" AND ")} ` +
      `ORDER BY id ASC ${limitClause}`
    ).trim();
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const out: DependencyNode[] = [];
      const tierSet =
        opts.licenseTier && opts.licenseTier.length > 0 ? new Set(opts.licenseTier) : undefined;
      for (const row of raw) {
        const node = rowToGraphNode(row);
        if (!node || node.kind !== "Dependency") continue;
        if (tierSet) {
          const tier = classifyLicenseTier((node as DependencyNode).license);
          if (!tierSet.has(tier)) continue;
        }
        out.push(node as DependencyNode);
      }
      return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } finally {
      stmt.destroySync();
    }
  }

  /** Routes filter. Methods + URL `pathLike` predicates. */
  async listRoutes(opts: ListRoutesOptions = {}): Promise<readonly RouteNode[]> {
    const c = this.requireConn();
    const wheres: string[] = ["kind = 'Route'"];
    const binds: SqlParam[] = [];
    if (opts.methods && opts.methods.length > 0) {
      const ph = opts.methods.map(() => "?").join(", ");
      wheres.push(`method IN (${ph})`);
      for (const m of opts.methods) binds.push(m);
    }
    if (opts.pathLike !== undefined) {
      wheres.push("url LIKE ?");
      binds.push(`%${opts.pathLike}%`);
    }
    const limit = clampNonNegativeInt(opts.limit);
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const columnList = NODE_COLUMNS.join(", ");
    const sql = (
      `SELECT ${columnList} FROM nodes WHERE ${wheres.join(" AND ")} ` +
      `ORDER BY id ASC ${limitClause}`
    ).trim();
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const out: RouteNode[] = [];
      for (const row of raw) {
        const node = rowToGraphNode(row);
        if (node && node.kind === "Route") out.push(node as RouteNode);
      }
      return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Repo-node by id. Returns `undefined` when no row matches OR when the
   * row is not `kind = 'Repo'` (the caller never has to downcast).
   */
  async getRepoNode(id: string): Promise<RepoNode | undefined> {
    const c = this.requireConn();
    const columnList = NODE_COLUMNS.join(", ");
    const stmt = await c.prepare(
      `SELECT ${columnList} FROM nodes WHERE id = ? AND kind = 'Repo' LIMIT 1`,
    );
    try {
      stmt.bindVarchar(1, id);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const first = raw[0];
      if (!first) return undefined;
      const node = rowToGraphNode(first);
      if (!node || node.kind !== "Repo") return undefined;
      return node as RepoNode;
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Specialized finder backing `analysis/impact.ts:131-135` —
   * `WHERE entry_point_id = ?`. Returns every {@link GraphNode} whose
   * `entry_point_id` column matches the supplied id, with `id ASC`
   * ordering matching the rest of the finder family.
   */
  async listNodesByEntryPoint(entryPointId: string): Promise<readonly GraphNode[]> {
    const c = this.requireConn();
    const columnList = NODE_COLUMNS.join(", ");
    const stmt = await c.prepare(
      `SELECT ${columnList} FROM nodes WHERE entry_point_id = ? ORDER BY id ASC`,
    );
    try {
      stmt.bindVarchar(1, entryPointId);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const out: GraphNode[] = [];
      for (const row of raw) {
        const node = rowToGraphNode(row);
        if (node) out.push(node);
      }
      return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Specialized finder backing `analysis/rename.ts:51,59` —
   * `WHERE name = ?` with optional `kinds` / `filePath` narrowing.
   * Returns rehydrated {@link GraphNode}s (full column set) so the
   * caller has access to start/end lines and other wide-column fields
   * that rename.ts needs to populate {@link SymbolLocation}.
   */
  async listNodesByName(
    name: string,
    opts: ListNodesByNameOptions = {},
  ): Promise<readonly GraphNode[]> {
    const c = this.requireConn();
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length === 0) return [];
    const limit = clampNonNegativeInt(opts.limit);
    const columnList = NODE_COLUMNS.join(", ");
    const wheres: string[] = ["name = ?"];
    const binds: SqlParam[] = [name];
    if (kinds && kinds.length > 0) {
      wheres.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      for (const k of kinds) binds.push(k);
    }
    if (opts.filePath !== undefined) {
      wheres.push("file_path = ?");
      binds.push(opts.filePath);
    }
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const sql = (
      `SELECT ${columnList} FROM nodes WHERE ${wheres.join(" AND ")} ` +
      `ORDER BY id ASC ${limitClause}`
    ).trim();
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      const out: GraphNode[] = [];
      for (const row of raw) {
        const node = rowToGraphNode(row);
        if (node) out.push(node);
      }
      return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Counts grouped by kind. When `kinds` is supplied, missing kinds are
   * still present in the result with count `0` — keeps the caller from
   * having to special-case "kind not present in graph".
   */
  async countNodesByKind(kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>> {
    const c = this.requireConn();
    const out = new Map<NodeKind, number>();
    if (kinds !== undefined && kinds.length === 0) return out;
    let sql = "SELECT kind, COUNT(*) AS n FROM nodes";
    const binds: SqlParam[] = [];
    if (kinds && kinds.length > 0) {
      const ph = kinds.map(() => "?").join(", ");
      sql += ` WHERE kind IN (${ph})`;
      for (const k of kinds) binds.push(k);
    }
    sql += " GROUP BY kind ORDER BY kind ASC";
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects();
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const kindVal = row["kind"];
        const n = row["n"];
        if (typeof kindVal === "string") {
          const num = typeof n === "bigint" ? Number(n) : Number(n ?? 0);
          out.set(kindVal as NodeKind, num);
        }
      }
      // Backfill zeros for kinds the caller asked about but which had no rows.
      if (kinds) {
        for (const k of kinds) {
          if (!out.has(k)) out.set(k, 0);
        }
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  /** Counts grouped by edge type. Symmetric to {@link countNodesByKind}. */
  async countEdgesByType(types?: readonly RelationType[]): Promise<Map<RelationType, number>> {
    const c = this.requireConn();
    const out = new Map<RelationType, number>();
    if (types !== undefined && types.length === 0) return out;
    let sql = "SELECT type, COUNT(*) AS n FROM relations";
    const binds: SqlParam[] = [];
    if (types && types.length > 0) {
      const ph = types.map(() => "?").join(", ");
      sql += ` WHERE type IN (${ph})`;
      for (const t of types) binds.push(t);
    }
    sql += " GROUP BY type ORDER BY type ASC";
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects();
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const typeVal = row["type"];
        const n = row["n"];
        if (typeof typeVal === "string") {
          const num = typeof n === "bigint" ? Number(n) : Number(n ?? 0);
          out.set(typeVal as RelationType, num);
        }
      }
      if (types) {
        for (const t of types) {
          if (!out.has(t)) out.set(t, 0);
        }
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Stream every embedding row in deterministic order. Implemented as an
   * `async function*` so the caller can `for await` over the stream
   * without materializing the full table — backs `pack/embeddings-sidecar`
   * Parquet writer.
   *
   * Order: `(node_id ASC, granularity ASC, chunk_index ASC)`. Optional
   * `kindFilter` joins through the `nodes` table on `embeddings.node_id =
   * nodes.id` and narrows by kind. Empty `kindFilter` yields zero rows.
   */
  async *listEmbeddings(opts: ListEmbeddingsOptions = {}): AsyncIterable<EmbeddingRow> {
    const c = this.requireConn();
    const kinds = opts.kindFilter;
    if (kinds !== undefined && kinds.length === 0) return;
    const limit = clampNonNegativeInt(opts.limit);

    const baseSelect =
      "SELECT e.node_id, e.granularity, e.chunk_index, e.start_line, e.end_line, e.vector, e.content_hash";
    const fromClause =
      kinds && kinds.length > 0
        ? "FROM embeddings e JOIN nodes n ON n.id = e.node_id"
        : "FROM embeddings e";
    const wheres: string[] = [];
    const binds: SqlParam[] = [];
    if (kinds && kinds.length > 0) {
      const ph = kinds.map(() => "?").join(", ");
      wheres.push(`n.kind IN (${ph})`);
      for (const k of kinds) binds.push(k);
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const sql = (
      `${baseSelect} ${fromClause} ${whereClause} ` +
      `ORDER BY e.node_id ASC, e.granularity ASC, e.chunk_index ASC ${limitClause}`
    ).trim();

    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      const reader = await stmt.runAndReadAll();
      const raw = normalizeRows(reader.getRowObjects());
      for (const r of raw) {
        const row = r as Record<string, unknown>;
        const vec = row["vector"];
        let vector: Float32Array;
        if (vec instanceof Float32Array) vector = vec;
        else if (Array.isArray(vec)) vector = Float32Array.from(vec.map((v) => Number(v)));
        else continue;
        const nodeId = String(row["node_id"]);
        const granularityRaw = String(row["granularity"]);
        const granularity =
          granularityRaw === "file" || granularityRaw === "community" ? granularityRaw : "symbol";
        const chunkVal = row["chunk_index"];
        const chunkIndex = typeof chunkVal === "bigint" ? Number(chunkVal) : Number(chunkVal ?? 0);
        const startVal = row["start_line"];
        const endVal = row["end_line"];
        const baseRow: EmbeddingRow = {
          nodeId,
          granularity,
          chunkIndex,
          ...(startVal !== null && startVal !== undefined
            ? { startLine: typeof startVal === "bigint" ? Number(startVal) : Number(startVal) }
            : {}),
          ...(endVal !== null && endVal !== undefined
            ? { endLine: typeof endVal === "bigint" ? Number(endVal) : Number(endVal) }
            : {}),
          vector,
          contentHash: String(row["content_hash"] ?? ""),
        };
        yield baseRow;
      }
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Traverse ancestors of `fromId` along the supplied edge types up to
   * `maxDepth`. Replaces the `WITH RECURSIVE` patterns in
   * `analysis/impact.ts` and `mcp/tools/query.ts`.
   */
  async traverseAncestors(opts: AncestorTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.traverseDirectional(opts, "up");
  }

  /** Symmetric of {@link traverseAncestors} — walks descendants. */
  async traverseDescendants(opts: DescendantTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.traverseDirectional(opts, "down");
  }

  /**
   * Producer-consumer edges across repos. Implements the FETCHES + Route
   * + Repo join in one statement. Determinism: ORDER BY
   * `(consumer_repo_uri, producer_repo_uri, http_method, http_path)`.
   *
   * Repo membership is resolved by walking the `Repo` row whose `id` is
   * the prefix of the consumer/producer node ids. The current ingestion
   * stamps `repo_uri` directly on every node via the AC-M6-1 column —
   * we read it inline rather than re-traversing the graph.
   */
  async listConsumerProducerEdges(
    opts: { readonly repoUris?: readonly string[] } = {},
  ): Promise<readonly ConsumerProducerEdge[]> {
    const c = this.requireConn();
    // FETCHES edges connect any consumer node (Function/Method/etc.) to a
    // Route node owned by the producer. We join Route metadata directly,
    // and pull the Repo `repo_uri` for both endpoints by joining a
    // narrowed `repos` view to the relations table.
    const wheres: string[] = ["r.type = 'FETCHES'"];
    const binds: SqlParam[] = [];
    if (opts.repoUris && opts.repoUris.length > 0) {
      const ph = opts.repoUris.map(() => "?").join(", ");
      wheres.push(`(consumer.repo_uri IN (${ph}) OR producer.repo_uri IN (${ph}))`);
      for (const u of opts.repoUris) binds.push(u);
      for (const u of opts.repoUris) binds.push(u);
    }
    const sql = `
      SELECT
        r.from_id      AS consumer_node_id,
        consumer.repo_uri AS consumer_repo_uri,
        r.to_id        AS producer_node_id,
        producer.repo_uri AS producer_repo_uri,
        producer.http_method AS http_method,
        producer.http_path   AS http_path
      FROM relations r
      JOIN nodes consumer ON consumer.id = r.from_id
      JOIN nodes producer ON producer.id = r.to_id
      WHERE ${wheres.join(" AND ")} AND producer.kind = 'Operation'
      ORDER BY consumer_repo_uri ASC, producer_repo_uri ASC,
               http_method ASC, http_path ASC, r.id ASC`.trim();
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects();
      const out: ConsumerProducerEdge[] = [];
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        out.push({
          consumerNodeId: String(row["consumer_node_id"] ?? ""),
          consumerRepoUri: String(row["consumer_repo_uri"] ?? ""),
          producerNodeId: String(row["producer_node_id"] ?? ""),
          producerRepoUri: String(row["producer_repo_uri"] ?? ""),
          httpMethod: String(row["http_method"] ?? ""),
          httpPath: String(row["http_path"] ?? ""),
        });
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Shared `listEdges` body — used by {@link listEdges} and
   * {@link listEdgesByType}. Determinism: ORDER BY `(from_id, to_id,
   * type)` then a JS-side stable tiebreak on `id` so two adapters agree
   * byte-for-byte even when the engine collation differs.
   */
  private async listEdgesInternal(
    c: DuckDBConnection,
    opts: ListEdgesOptions,
  ): Promise<readonly CodeRelation[]> {
    const wheres: string[] = [];
    const binds: SqlParam[] = [];
    if (opts.types && opts.types.length > 0) {
      const ph = opts.types.map(() => "?").join(", ");
      wheres.push(`type IN (${ph})`);
      for (const t of opts.types) binds.push(t);
    }
    if (opts.fromIds && opts.fromIds.length > 0) {
      const ph = opts.fromIds.map(() => "?").join(", ");
      wheres.push(`from_id IN (${ph})`);
      for (const f of opts.fromIds) binds.push(f);
    }
    if (opts.toIds && opts.toIds.length > 0) {
      const ph = opts.toIds.map(() => "?").join(", ");
      wheres.push(`to_id IN (${ph})`);
      for (const t of opts.toIds) binds.push(t);
    }
    if (opts.minConfidence !== undefined) {
      wheres.push("confidence >= ?");
      binds.push(opts.minConfidence);
    }
    const limit = clampNonNegativeInt(opts.limit);
    const offset = clampNonNegativeInt(opts.offset);
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const offsetClause = offset !== undefined ? "OFFSET ?" : "";
    const sql = (
      `SELECT id, from_id, to_id, type, confidence, reason, step ` +
      `FROM relations ${whereClause} ` +
      `ORDER BY from_id ASC, to_id ASC, type ASC, id ASC ${limitClause} ${offsetClause}`
    ).trim();
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      for (const b of binds) bindParam(stmt, idx++, b);
      if (limit !== undefined) stmt.bindInteger(idx++, limit);
      if (offset !== undefined) stmt.bindInteger(idx++, offset);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects();
      const out: CodeRelation[] = [];
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const stepVal = row["step"];
        // Match the AC-A-2 step-zero sentinel: DuckDB stores `INT NOT NULL
        // DEFAULT 0` for absent step values; collapse 0 to "field absent"
        // so the wire shape matches the source `CodeRelation`.
        const step =
          stepVal === null || stepVal === undefined || Number(stepVal) === 0
            ? undefined
            : Number(stepVal);
        const reasonVal = row["reason"];
        const reason =
          typeof reasonVal === "string" && reasonVal.length > 0 ? reasonVal : undefined;
        out.push({
          id: String(row["id"] ?? "") as CodeRelation["id"],
          from: String(row["from_id"] ?? "") as CodeRelation["from"],
          to: String(row["to_id"] ?? "") as CodeRelation["to"],
          type: String(row["type"] ?? "") as RelationType,
          confidence: Number(row["confidence"] ?? 0),
          ...(reason !== undefined ? { reason } : {}),
          ...(step !== undefined ? { step } : {}),
        });
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * Shared body for {@link traverseAncestors} / {@link traverseDescendants}.
   * Reuses the existing recursive-CTE machinery via a thin wrapper —
   * direction is "up" for ancestors and "down" for descendants.
   */
  private async traverseDirectional(
    opts: AncestorTraversalOptions | DescendantTraversalOptions,
    direction: "up" | "down",
  ): Promise<readonly TraverseResult[]> {
    if (opts.edgeTypes.length === 0) return [];
    const traverseQuery: TraverseQuery = {
      startId: opts.fromId,
      relationTypes: opts.edgeTypes,
      direction,
      maxDepth: opts.maxDepth,
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
    };
    return this.traverse(traverseQuery);
  }

  async search(q: SearchQuery): Promise<readonly SearchResult[]> {
    const c = this.requireConn();
    const limit = q.limit ?? 50;
    const kindFilter = q.kinds && q.kinds.length > 0 ? q.kinds : undefined;
    const kindPlaceholders = kindFilter ? kindFilter.map(() => "?").join(",") : "";
    const kindClause = kindFilter ? ` AND kind IN (${kindPlaceholders})` : "";

    // Materialize the BM25 score + primary key in a CTE, then sort. A plain
    // ORDER BY on a subquery with `match_bm25` has been observed to return
    // non-deterministic orderings when many rows tie on score — apparently
    // DuckDB's planner elides the sort when it thinks it can stream results.
    // Forcing the score into a CTE and applying ROUND to the score drops
    // floating-point jitter that can also confuse tie-breakers.
    const sql = `WITH scored AS (
        SELECT id, name, kind, file_path,
               ROUND(fts_main_nodes.match_bm25(id, ?), 9) AS score
        FROM nodes
      )
      SELECT id, name, kind, file_path, score
      FROM scored
      WHERE score IS NOT NULL${kindClause}
      ORDER BY score DESC, id ASC, file_path ASC, name ASC
      LIMIT ?`;
    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      stmt.bindVarchar(idx++, q.text);
      if (kindFilter) {
        for (const k of kindFilter) stmt.bindVarchar(idx++, k);
      }
      stmt.bindInteger(idx++, limit);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects();
      const results: SearchResult[] = [];
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        results.push({
          nodeId: String(row["id"]),
          name: String(row["name"] ?? ""),
          kind: String(row["kind"] ?? ""),
          filePath: String(row["file_path"] ?? ""),
          score: Number(row["score"] ?? 0),
        });
      }
      return results;
    } finally {
      stmt.destroySync();
    }
  }

  async vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]> {
    if (this.vectorExtension === "none") {
      throw new Error(
        this.extensionWarning ?? "Vector search unavailable: no HNSW extension loaded",
      );
    }
    if (q.vector.length !== this.embeddingDim) {
      throw new Error(
        `Vector dimension mismatch: got ${q.vector.length}, expected ${this.embeddingDim}`,
      );
    }
    const c = this.requireConn();
    const limit = q.limit ?? 10;

    // Normalize the granularity filter (optional) into a list of tier names
    // so we can push a single IN-predicate through hnsw_acorn — the extension
    // handles the ACORN-1 push-down for us.
    const granularities: readonly string[] | undefined =
      q.granularity === undefined
        ? undefined
        : Array.isArray(q.granularity)
          ? (q.granularity as readonly string[])
          : [q.granularity as string];

    const extraWhere: string[] = [];
    const extraParams: SqlParam[] = [];
    if (granularities !== undefined && granularities.length > 0) {
      const ph = granularities.map(() => "?").join(",");
      extraWhere.push(`e.granularity IN (${ph})`);
      for (const g of granularities) extraParams.push(g);
    }

    // Filter-first subquery pattern: pre-filter embeddings by the optional
    // whereClause (joined to nodes as `n`) and only then compute distance +
    // ORDER BY. This sidesteps DuckDB planner quirks where an HNSW index scan
    // might drop the WHERE filter entirely on small datasets.
    const userWhere = q.whereClause;
    const needsJoin = userWhere !== undefined && userWhere.length > 0;
    const whereParts: string[] = [];
    if (userWhere !== undefined && userWhere.length > 0) whereParts.push(`(${userWhere})`);
    whereParts.push(...extraWhere);
    const wherePredicate = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    const filterSql = needsJoin
      ? `SELECT e.node_id, e.vector
         FROM embeddings e JOIN nodes n ON n.id = e.node_id
         ${wherePredicate}`
      : `SELECT e.node_id, e.vector
         FROM embeddings e
         ${wherePredicate}`;
    const sql = `WITH filtered AS (${filterSql})
      SELECT node_id, array_distance(vector, ?) AS distance
      FROM filtered
      ORDER BY distance
      LIMIT ?`;

    const stmt = await c.prepare(sql);
    try {
      // Positional binds: whereClause params first, then granularity params,
      // then vector, then limit.
      let idx = 1;
      if (q.params) {
        for (const p of q.params) {
          bindParam(stmt, idx++, p);
        }
      }
      for (const p of extraParams) {
        bindParam(stmt, idx++, p);
      }
      stmt.bindArray(idx++, arrayValue(Array.from(q.vector)), ARRAY(FLOAT, this.embeddingDim));
      stmt.bindInteger(idx++, limit);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects();
      const out: VectorResult[] = [];
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        out.push({
          nodeId: String(row["node_id"]),
          distance: Number(row["distance"] ?? 0),
        });
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  async traverse(q: TraverseQuery): Promise<readonly TraverseResult[]> {
    const c = this.requireConn();
    const maxDepth = Math.max(0, q.maxDepth);
    const minConfidence = q.minConfidence ?? 0;
    const relTypes: readonly string[] =
      q.relationTypes && q.relationTypes.length > 0 ? q.relationTypes : ALL_RELATION_TYPES;
    const typePlaceholders = relTypes.map(() => "?").join(",");

    // Build direction-appropriate recursive CTE. USING KEY collapses repeated
    // visits to the same node_id, giving us bounded memory on cyclic graphs.
    // DuckDB recursive CTEs only allow ONE recursive term after the anchor, so
    // "both" uses a single body that picks the neighbor via CASE at each step
    // rather than UNION-ing two recursive references to `walk`.
    const downBody = `
      SELECT r.to_id AS node_id, w.depth + 1 AS depth,
             list_append(w.path, r.to_id) AS path
      FROM walk w JOIN relations r ON r.from_id = w.node_id
      WHERE w.depth < ? AND r.confidence >= ? AND r.type IN (${typePlaceholders})`;
    const upBody = `
      SELECT r.from_id AS node_id, w.depth + 1 AS depth,
             list_append(w.path, r.from_id) AS path
      FROM walk w JOIN relations r ON r.to_id = w.node_id
      WHERE w.depth < ? AND r.confidence >= ? AND r.type IN (${typePlaceholders})`;
    const bothBody = `
      SELECT CASE WHEN r.from_id = w.node_id THEN r.to_id ELSE r.from_id END AS node_id,
             w.depth + 1 AS depth,
             list_append(
               w.path,
               CASE WHEN r.from_id = w.node_id THEN r.to_id ELSE r.from_id END
             ) AS path
      FROM walk w JOIN relations r
        ON (r.from_id = w.node_id OR r.to_id = w.node_id)
      WHERE w.depth < ? AND r.confidence >= ? AND r.type IN (${typePlaceholders})`;

    let recursiveBody: string;
    if (q.direction === "down") recursiveBody = downBody;
    else if (q.direction === "up") recursiveBody = upBody;
    else recursiveBody = bothBody;

    // In the "both" direction, a 2-hop cycle (e.g., B -> A -> B) can reach the
    // start node at depth 2 because the recursive body walks edges in either
    // direction. Filter it out at the final SELECT so callers never see the
    // start node in their results (matching the "up"/"down" behavior where the
    // start is already unreachable via the single-direction edge set).
    const sql = `WITH RECURSIVE walk(node_id, depth, path) USING KEY (node_id) AS (
      SELECT CAST(? AS TEXT) AS node_id, 0 AS depth, [CAST(? AS TEXT)] AS path
      UNION ALL${recursiveBody}
    )
    SELECT node_id, depth, path FROM walk
    WHERE depth > 0 AND node_id <> CAST(? AS TEXT)
    ORDER BY depth, node_id`;

    const stmt = await c.prepare(sql);
    try {
      let idx = 1;
      stmt.bindVarchar(idx++, q.startId);
      stmt.bindVarchar(idx++, q.startId);

      // Every branch has exactly one recursive body, so bind
      // (maxDepth, minConfidence, *types) exactly once.
      stmt.bindInteger(idx++, maxDepth);
      stmt.bindDouble(idx++, minConfidence);
      for (const t of relTypes) stmt.bindVarchar(idx++, t);

      // Bound for the final WHERE node_id <> ? filter.
      stmt.bindVarchar(idx++, q.startId);
      const reader = await stmt.runAndReadAll();
      const rows = reader.getRowObjects();
      const out: TraverseResult[] = [];
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const pathVal = row["path"];
        const path: string[] = Array.isArray(pathVal) ? pathVal.map((v) => String(v)) : [];
        out.push({
          nodeId: String(row["node_id"]),
          depth: Number(row["depth"] ?? 0),
          path,
        });
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  // --------------------------------------------------------------------------
  // Meta
  // --------------------------------------------------------------------------

  async getMeta(): Promise<StoreMeta | undefined> {
    const c = this.requireConn();
    const reader = await c.runAndReadAll(
      `SELECT schema_version, last_commit, indexed_at, node_count, edge_count,
              stats_json, cache_hit_ratio, cache_size_bytes, last_compaction
       FROM store_meta WHERE id = 1`,
    );
    const rows = reader.getRowObjects();
    const first = rows[0];
    if (!first) return undefined;
    const row = first as Record<string, unknown>;
    const stats = row["stats_json"]
      ? (JSON.parse(String(row["stats_json"])) as Record<string, number>)
      : undefined;
    const lastCommit = row["last_commit"];
    const cacheHitRatio = row["cache_hit_ratio"];
    const cacheSizeBytes = row["cache_size_bytes"];
    const lastCompaction = row["last_compaction"];
    return {
      schemaVersion: String(row["schema_version"]),
      ...(lastCommit !== null && lastCommit !== undefined
        ? { lastCommit: String(lastCommit) }
        : {}),
      indexedAt: String(row["indexed_at"]),
      nodeCount: Number(row["node_count"] ?? 0),
      edgeCount: Number(row["edge_count"] ?? 0),
      ...(stats ? { stats } : {}),
      ...(cacheHitRatio !== null && cacheHitRatio !== undefined
        ? { cacheHitRatio: Number(cacheHitRatio) }
        : {}),
      ...(cacheSizeBytes !== null && cacheSizeBytes !== undefined
        ? { cacheSizeBytes: Number(cacheSizeBytes) }
        : {}),
      ...(lastCompaction !== null && lastCompaction !== undefined
        ? { lastCompaction: String(lastCompaction) }
        : {}),
    };
  }

  async setMeta(meta: StoreMeta): Promise<void> {
    const c = this.requireConn();
    const statsJson = meta.stats ? canonicalJson(meta.stats) : null;
    // Single-row meta: DELETE+INSERT keeps things predictable without relying
    // on DuckDB upsert semantics.
    await c.run("DELETE FROM store_meta WHERE id = 1");
    const stmt = await c.prepare(
      `INSERT INTO store_meta (
        id, schema_version, last_commit, indexed_at, node_count, edge_count,
        stats_json, cache_hit_ratio, cache_size_bytes, last_compaction
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      bindParam(stmt, 1, meta.schemaVersion);
      bindParam(stmt, 2, meta.lastCommit ?? null);
      bindParam(stmt, 3, meta.indexedAt);
      bindParam(stmt, 4, meta.nodeCount);
      bindParam(stmt, 5, meta.edgeCount);
      bindParam(stmt, 6, statsJson);
      bindParam(stmt, 7, meta.cacheHitRatio ?? null);
      bindParam(stmt, 8, meta.cacheSizeBytes ?? null);
      bindParam(stmt, 9, meta.lastCompaction ?? null);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const c = this.requireConn();
      const reader = await c.runAndReadAll("SELECT 1 AS one");
      const rows = reader.getRowObjects();
      const first = rows[0] as { one?: unknown } | undefined;
      const ok = !!first && Number(first.one) === 1;
      return ok ? { ok: true } : { ok: false, message: "SELECT 1 returned unexpected shape" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private requireConn(): DuckDBConnection {
    if (!this.conn) {
      throw new Error("DuckDbStore is not open — call open() first");
    }
    return this.conn;
  }

  /**
   * Interrupt the current statement if it exceeds the timeout. DuckDB has no
   * SQL-level statement timeout, so we schedule a JS timer that calls
   * `connection.interrupt()` and let the prepared statement throw.
   */
  private async withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    if (ms <= 0) return fn();
    const c = this.requireConn();
    let interrupted = false;
    const handle = setTimeout(() => {
      interrupted = true;
      try {
        c.interrupt();
      } catch {
        /* ignore — connection may already be done */
      }
    }, ms);
    try {
      return await fn();
    } catch (err) {
      if (interrupted) {
        throw new Error(`Query exceeded timeout of ${ms}ms`);
      }
      throw err;
    } finally {
      clearTimeout(handle);
    }
  }
}

// ----------------------------------------------------------------------------
// Free helpers
// ----------------------------------------------------------------------------

/**
 * Convert a GraphNode into the positional row ordering expected by the
 * `nodes` table DDL. Each slot is either a typed scalar, an array (for
 * `TEXT[]` columns), or `null`.
 *
 * The body of this function is now a thin projection from
 * {@link nodeToColumns} (in `column-encode.ts`) into the canonical
 * `NODE_COLUMNS` order — keeping the local name `nodeToRow` so the call
 * sites in `insertNodes` continue to read naturally and so unrelated
 * adapter-internal references (e.g. JSDoc in `rowToGraphNode`) stay valid.
 *
 * Field/column aliasing handled inside `nodeToColumns`:
 *   - `OperationNode.method` → `http_method` column (not `method`, which is
 *     reserved for RouteNode).
 *   - `OperationNode.path`   → `http_path`   column.
 *   The Operation write-through still preserves read-back determinism
 *   because the round-trip helper maps `http_method`/`http_path` back to
 *   `method`/`path` when `kind === "Operation"`.
 */
function nodeToRow(node: GraphNode): readonly (SqlParam | readonly string[])[] {
  const cols = nodeToColumns(node);
  return NODE_COLUMNS.map((key) => cols[key] as SqlParam | readonly string[] | null);
}

function bindParam(
  stmt: DuckDBPreparedStatement,
  index: number,
  value: SqlParam | readonly string[] | null,
): void {
  if (value === null || value === undefined) {
    stmt.bindNull(index);
    return;
  }
  if (Array.isArray(value)) {
    // DuckDB TEXT[] → bind as a list of varchar values. Use bindList (VARIABLE
    // length), not bindArray (FIXED length) — `TEXT[]` in the DDL is a LIST.
    stmt.bindList(index, listValue([...(value as readonly string[])]));
    return;
  }
  switch (typeof value) {
    case "boolean":
      stmt.bindBoolean(index, value);
      return;
    case "number":
      if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
        stmt.bindInteger(index, value);
      } else {
        stmt.bindDouble(index, value);
      }
      return;
    case "bigint":
      stmt.bindBigInt(index, value);
      return;
    case "string":
      stmt.bindVarchar(index, value);
      return;
    default:
      throw new Error(`Unsupported SQL parameter type at index ${index}`);
  }
}

/**
 * DuckDB's getRowObjects returns values that are mostly JS primitives, but
 * some column types come back as class instances (e.g. `DuckDBListValue`,
 * `DuckDBArrayValue`) that carry an `items` array. Normalize every row to
 * plain JS values so downstream tests and hashing behave predictably.
 */
function normalizeRows(rows: readonly unknown[]): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const src = r as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      cleaned[k] = normalizeValue(v);
    }
    out.push(cleaned);
  }
  return out;
}

/**
 * Clamp a number to a non-negative integer, returning `undefined` for
 * unset / non-finite / negative inputs. Used by listNodes() to gate the
 * optional LIMIT / OFFSET parameters — callers that pass `0` get a real
 * `0` (semantically valid) while `undefined` / `-1` / `NaN` skip the
 * clause entirely.
 */
function clampNonNegativeInt(v: number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (v < 0) return undefined;
  return Math.floor(v);
}

/**
 * Rehydrate a row from the polymorphic `nodes` table into a typed
 * {@link GraphNode}. The inverse of {@link nodeToRow}: every column it
 * writes is read back here, and every kind-specific field aliasing
 * (Operation `http_method`/`http_path` → `method`/`path`) is reversed.
 *
 * Returns `undefined` when the row is missing the load-bearing
 * primary-key columns (`id`, `kind`, `name`, `file_path`) so a corrupt
 * row never poisons the caller's array.
 *
 * Field-population strategy: every property on the result is set
 * conditionally — fields whose underlying column is NULL are LEFT OFF
 * the object so `Object.keys(result)` matches the original GraphNode
 * shape (modulo the documented round-trip subset). This keeps
 * `canonicalJson` / `graphHash` stable when callers serialise the
 * output.
 */
function rowToGraphNode(row: Record<string, unknown>): GraphNode | undefined {
  const id = row["id"];
  const kindVal = row["kind"];
  const name = row["name"];
  const filePath = row["file_path"];
  if (
    typeof id !== "string" ||
    typeof kindVal !== "string" ||
    typeof name !== "string" ||
    typeof filePath !== "string"
  ) {
    return undefined;
  }
  const isOperation = kindVal === "Operation";

  const out: Record<string, unknown> = {
    id,
    kind: kindVal,
    name,
    filePath,
  };

  // Scalar columns — written as primitives by `nodeToRow`. Each branch
  // skips when the column is NULL/undefined so the resulting object's
  // key set mirrors the original GraphNode (e.g. a Function with no
  // `signature` field comes back without a `signature` key, not with
  // `signature: null`).
  setStringField(out, "signature", row["signature"]);
  setNumberField(out, "startLine", row["start_line"]);
  setNumberField(out, "endLine", row["end_line"]);
  setBooleanField(out, "isExported", row["is_exported"]);
  setNumberField(out, "parameterCount", row["parameter_count"]);
  setStringField(out, "returnType", row["return_type"]);
  setStringField(out, "declaredType", row["declared_type"]);
  setStringField(out, "owner", row["owner"]);
  setStringField(out, "url", row["url"]);
  // Route.method comes from the `method` column; Operation.method comes
  // from the `http_method` column. Both write back to `node.method` on
  // their respective kinds.
  if (isOperation) {
    setStringField(out, "method", row["http_method"]);
    setStringField(out, "path", row["http_path"]);
  } else {
    setStringField(out, "method", row["method"]);
  }
  setStringField(out, "toolName", row["tool_name"]);
  setStringField(out, "content", row["content"]);
  setStringField(out, "contentHash", row["content_hash"]);
  setStringField(out, "inferredLabel", row["inferred_label"]);
  setNumberField(out, "symbolCount", row["symbol_count"]);
  setNumberField(out, "cohesion", row["cohesion"]);
  setStringArrayField(out, "keywords", row["keywords"]);
  setStringField(out, "entryPointId", row["entry_point_id"]);
  setNumberField(out, "stepCount", row["step_count"]);
  setNumberField(out, "level", row["level"]);
  setStringArrayField(out, "responseKeys", row["response_keys"]);
  setStringField(out, "description", row["description"]);
  // Finding (SARIF).
  setStringField(out, "severity", row["severity"]);
  setStringField(out, "ruleId", row["rule_id"]);
  setStringField(out, "scannerId", row["scanner_id"]);
  setStringField(out, "message", row["message"]);
  setJsonObjectField(out, "propertiesBag", row["properties_bag"]);
  // Dependency.
  setStringField(out, "version", row["version"]);
  setStringField(out, "license", row["license"]);
  setStringField(out, "lockfileSource", row["lockfile_source"]);
  setStringField(out, "ecosystem", row["ecosystem"]);
  // Operation.summary / .operationId — these don't collide with anything else.
  setStringField(out, "summary", row["summary"]);
  setStringField(out, "operationId", row["operation_id"]);
  // Contributor.
  setStringField(out, "emailHash", row["email_hash"]);
  setStringField(out, "emailPlain", row["email_plain"]);
  // ProjectProfile (JSON-encoded array fields).
  setJsonArrayField(out, "languages", row["languages_json"]);
  // `frameworks_json` carries either the legacy flat-string-array shape
  // or the v2 `{flat, detected}` envelope. Tease out both fields when the
  // envelope is present so consumers that read either surface get the
  // expected types.
  applyFrameworksJsonReadback(out, row["frameworks_json"]);
  setJsonArrayField(out, "iacTypes", row["iac_types_json"]);
  setJsonArrayField(out, "apiContracts", row["api_contracts_json"]);
  setJsonArrayField(out, "manifests", row["manifests_json"]);
  setJsonArrayField(out, "srcDirs", row["src_dirs_json"]);
  // File / Community ownership.
  setStringField(out, "orphanGrade", row["orphan_grade"]);
  setBooleanField(out, "isOrphan", row["is_orphan"]);
  setNumberField(out, "truckFactor", row["truck_factor"]);
  setNumberField(out, "ownershipDrift30d", row["ownership_drift_30d"]);
  setNumberField(out, "ownershipDrift90d", row["ownership_drift_90d"]);
  setNumberField(out, "ownershipDrift365d", row["ownership_drift_365d"]);
  // v1.2 extensions.
  setStringField(out, "deadness", denormalizeDeadness(row["deadness"]));
  setNumberField(out, "coveragePercent", row["coverage_percent"]);
  setStringField(out, "coveredLinesJson", row["covered_lines_json"]);
  setNumberField(out, "cyclomaticComplexity", row["cyclomatic_complexity"]);
  setNumberField(out, "nestingDepth", row["nesting_depth"]);
  setNumberField(out, "nloc", row["nloc"]);
  setNumberField(out, "halsteadVolume", row["halstead_volume"]);
  setStringField(out, "inputSchemaJson", row["input_schema_json"]);
  setStringField(out, "partialFingerprint", row["partial_fingerprint"]);
  setStringField(out, "baselineState", row["baseline_state"]);
  setStringField(out, "suppressedJson", row["suppressed_json"]);
  // Repo (AC-M6-1). The interface marks `originUrl` / `defaultBranch` /
  // `group` as `string | null` so the round-trip preserves an explicit
  // null when the column is NULL. Other Repo fields are populated only
  // when `kind === "Repo"`; for non-Repo rows the columns stay NULL and
  // the field is left off entirely.
  if (kindVal === "Repo") {
    out["originUrl"] = readNullableString(row["origin_url"]);
    setStringField(out, "repoUri", row["repo_uri"]);
    out["defaultBranch"] = readNullableString(row["default_branch"]);
    setStringField(out, "commitSha", row["commit_sha"]);
    setStringField(out, "indexTime", row["index_time"]);
    out["group"] = readNullableString(row["repo_group"]);
    setStringField(out, "visibility", row["visibility"]);
    setStringField(out, "indexer", row["indexer"]);
    out["languageStats"] = readLanguageStats(row["language_stats_json"]);
  }
  return out as unknown as GraphNode;
}

function setStringField(out: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v === "string" && v.length > 0) out[key] = v;
}

function setNumberField(out: Record<string, unknown>, key: string, v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v === "number" && Number.isFinite(v)) {
    out[key] = v;
    return;
  }
  if (typeof v === "bigint") {
    out[key] = Number(v);
    return;
  }
  // DuckDB occasionally returns numeric-typed columns as strings when the
  // underlying type is DECIMAL — coerce defensively. Only digits / dot /
  // sign survive the parse.
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[key] = n;
  }
}

function setBooleanField(out: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v === "boolean") out[key] = v;
}

function setStringArrayField(out: Record<string, unknown>, key: string, v: unknown): void {
  if (!Array.isArray(v)) return;
  const arr: string[] = [];
  for (const item of v) {
    if (typeof item === "string") arr.push(item);
  }
  if (arr.length > 0) out[key] = arr;
}

function setJsonArrayField(out: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v !== "string" || v.length === 0) return;
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) out[key] = parsed;
  } catch {
    /* row stored a non-JSON string for this column — skip the field. */
  }
}

function setJsonObjectField(out: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v !== "string" || v.length === 0) return;
  try {
    const parsed = JSON.parse(v);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      out[key] = parsed;
    }
  } catch {
    /* skip */
  }
}

/**
 * Read the polymorphic `frameworks_json` column. Two on-disk shapes:
 *   - Legacy v1.0: a flat `string[]`.
 *   - v2.0: `{ flat: string[], detected: FrameworkDetection[] }`.
 *
 * Both populate `frameworks` (the flat-string list); v2 additionally
 * populates `frameworksDetected`. Skipped silently when the column is
 * NULL or holds non-JSON.
 */
function applyFrameworksJsonReadback(out: Record<string, unknown>, v: unknown): void {
  if (typeof v !== "string" || v.length === 0) return;
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) {
      out["frameworks"] = parsed;
      return;
    }
    if (parsed && typeof parsed === "object") {
      const env = parsed as { flat?: unknown; detected?: unknown };
      if (Array.isArray(env.flat)) out["frameworks"] = env.flat;
      if (Array.isArray(env.detected) && env.detected.length > 0) {
        out["frameworksDetected"] = env.detected;
      }
    }
  } catch {
    /* skip on parse failure */
  }
}

/**
 * Reverse of `normalizeDeadness` in the writer. Stored as the underscored
 * form `unreachable_export`; expose the hyphenated `unreachable-export`
 * the dead-code phase emits. Pass through `live` / `dead` unchanged.
 */
function denormalizeDeadness(v: unknown): unknown {
  if (v === "unreachable_export") return "unreachable-export";
  return v;
}

/**
 * Resolve a Repo nullable-string column. The interface declares these as
 * `string | null` (not `string | undefined`), so missing columns must
 * round-trip as an explicit `null` rather than leaving the key off.
 */
function readNullableString(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/**
 * Reconstruct `RepoNode.languageStats` from the canonical-JSON column.
 * Returns an empty object when the column is NULL / unparsable so the
 * field is always present (the interface requires it; node serialization
 * relies on `Object.keys(...)` to be deterministic).
 */
function readLanguageStats(v: unknown): Readonly<Record<string, number>> {
  if (typeof v !== "string" || v.length === 0) return {};
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
      }
      return out;
    }
  } catch {
    /* fallthrough */
  }
  return {};
}

/**
 * Convert a DuckDB row from the `cochanges` table back into a {@link CochangeRow}.
 * The timestamp column arrives as either a DuckDB value object carrying a
 * `micros` BigInt (when returned over the native bindings) or a string; both
 * paths resolve to an ISO-8601 UTC string.
 */
function cochangeRowFromRecord(row: Record<string, unknown>): CochangeRow {
  const last = row["last_cocommit_at"];
  let lastCocommitAt: string;
  if (typeof last === "string") {
    lastCocommitAt = last;
  } else if (last && typeof last === "object") {
    const anyRow = last as { micros?: bigint; toISOString?: () => string };
    if (typeof anyRow.toISOString === "function") {
      lastCocommitAt = anyRow.toISOString();
    } else if (typeof anyRow.micros === "bigint") {
      lastCocommitAt = new Date(Number(anyRow.micros / 1000n)).toISOString();
    } else {
      lastCocommitAt = String(last);
    }
  } else {
    lastCocommitAt = String(last ?? "");
  }
  return {
    sourceFile: String(row["source_file"] ?? ""),
    targetFile: String(row["target_file"] ?? ""),
    cocommitCount: Number(row["cocommit_count"] ?? 0),
    totalCommitsSource: Number(row["total_commits_source"] ?? 0),
    totalCommitsTarget: Number(row["total_commits_target"] ?? 0),
    lastCocommitAt,
    lift: Number(row["lift"] ?? 0),
  };
}

/**
 * Convert a DuckDB row from the `symbol_summaries` table back into a
 * {@link SymbolSummaryRow}. Mirrors the timestamp-coercion pattern used by
 * {@link cochangeRowFromRecord} so `created_at` round-trips identically
 * whether the native bindings return a DuckDB value object or a plain
 * string.
 */
function summaryRowFromRecord(row: Record<string, unknown>): SymbolSummaryRow {
  const created = row["created_at"];
  let createdAt: string;
  if (typeof created === "string") {
    createdAt = created;
  } else if (created && typeof created === "object") {
    const anyRow = created as { micros?: bigint; toISOString?: () => string };
    if (typeof anyRow.toISOString === "function") {
      createdAt = anyRow.toISOString();
    } else if (typeof anyRow.micros === "bigint") {
      createdAt = new Date(Number(anyRow.micros / 1000n)).toISOString();
    } else {
      createdAt = String(created);
    }
  } else {
    createdAt = String(created ?? "");
  }
  const sig = row["signature_summary"];
  const ret = row["returns_type_summary"];
  return {
    nodeId: String(row["node_id"] ?? ""),
    contentHash: String(row["content_hash"] ?? ""),
    promptVersion: String(row["prompt_version"] ?? ""),
    modelId: String(row["model_id"] ?? ""),
    summaryText: String(row["summary_text"] ?? ""),
    ...(sig !== null && sig !== undefined ? { signatureSummary: String(sig) } : {}),
    ...(ret !== null && ret !== undefined ? { returnsTypeSummary: String(ret) } : {}),
    createdAt,
  };
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x));
  if (typeof v === "object") {
    const obj = v as { items?: unknown };
    if (Array.isArray(obj.items)) {
      return obj.items.map((x) => normalizeValue(x));
    }
  }
  return v;
}

/**
 * Conservative absolute-path validator used by `exportEmbeddingsParquet`
 * to inline a destination path into a `COPY ... TO '<path>' ...` SQL
 * statement. DuckDB's prepared-statement parser does not bind COPY
 * destinations, so the path is concatenated; allow only POSIX absolute
 * paths over a safe character class so single-quote injection is
 * structurally impossible.
 */
function isSafeAbsolutePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (!p.startsWith("/")) return false;
  return /^[A-Za-z0-9/_\-.]+$/.test(p);
}

/**
 * Classify a SPDX-ish license string into one of the five
 * {@link ListDependenciesOptions.licenseTier} buckets. Used by
 * {@link DuckDbStore.listDependencies} (and the symmetric graph-db
 * adapter helper) to satisfy the typed `licenseTier` filter without
 * the consumer pre-classifying every row.
 *
 * The match list mirrors the OCH `license_audit` rules — keep the two
 * surfaces in lockstep so a tier filter on `listDependencies` returns
 * the same set the audit reports for the same tier.
 */
export function classifyLicenseTier(
  license: string | undefined,
): "permissive" | "weak-copyleft" | "strong-copyleft" | "proprietary" | "unknown" {
  if (!license || license.trim().length === 0) return "unknown";
  const lower = license.trim().toLowerCase();
  // Strong copyleft — GPL/AGPL family.
  if (/(^|\b|-)agpl(-|$)/i.test(lower) || /(^|\b|-)gpl(-|$)/i.test(lower)) {
    return "strong-copyleft";
  }
  // Weak copyleft — LGPL, MPL, EPL, CDDL, CC-BY-SA.
  if (
    /(^|\b|-)lgpl(-|$)/i.test(lower) ||
    /(^|\b)mpl(-|$)/i.test(lower) ||
    /(^|\b)epl(-|$)/i.test(lower) ||
    /(^|\b)cddl(-|$)/i.test(lower) ||
    /(^|\b)cc-by-sa(-|$)/i.test(lower)
  ) {
    return "weak-copyleft";
  }
  // Permissive — MIT/Apache/BSD/ISC/0BSD/Unlicense/CC0/Zlib.
  if (
    /(^|\b)mit(\b|-|$)/.test(lower) ||
    /(^|\b)apache(-|$)/i.test(lower) ||
    /(^|\b)bsd(-|$)/i.test(lower) ||
    /(^|\b)isc(\b|-|$)/.test(lower) ||
    /(^|\b)0bsd(\b|$)/.test(lower) ||
    /(^|\b)unlicense(\b|$)/.test(lower) ||
    /(^|\b)cc0(\b|-|$)/.test(lower) ||
    /(^|\b)zlib(\b|$)/.test(lower)
  ) {
    return "permissive";
  }
  // Proprietary markers.
  if (/(^|\b)(proprietary|commercial|see license)(\b|$)/i.test(lower)) {
    return "proprietary";
  }
  return "unknown";
}
