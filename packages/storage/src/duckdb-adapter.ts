/**
 * DuckDB-backed adapter for {@link IGraphStore}.
 *
 * Lifecycle: `open` → `createSchema` → `bulkLoad` (once per index run) →
 * `query` / `search` / `vectorSearch` / `traverse` against the same
 * connection → `close`.
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
  canonicalJson,
  type GraphNode,
  type KnowledgeGraph,
  type RelationType,
} from "@opencodehub/core-types";
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

export class DuckDbStore implements IGraphStore {
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
 * Canonical column ordering for the `nodes` table. Must match the
 * CREATE TABLE in schema-ddl.ts. Used by both the static INSERT statement and
 * the UPSERT DO UPDATE SET clause.
 */
const NODE_COLUMNS: readonly string[] = [
  "id",
  "kind",
  "name",
  "file_path",
  "start_line",
  "end_line",
  "is_exported",
  "signature",
  "parameter_count",
  "return_type",
  "declared_type",
  "owner",
  "url",
  "method",
  "tool_name",
  "content",
  "content_hash",
  "inferred_label",
  "symbol_count",
  "cohesion",
  "keywords",
  "entry_point_id",
  "step_count",
  "level",
  "response_keys",
  "description",
  // Finding
  "severity",
  "rule_id",
  "scanner_id",
  "message",
  "properties_bag",
  // Dependency
  "version",
  "license",
  "lockfile_source",
  "ecosystem",
  // Operation
  "http_method",
  "http_path",
  "summary",
  "operation_id",
  // Contributor
  "email_hash",
  "email_plain",
  // ProjectProfile
  "languages_json",
  "frameworks_json",
  "iac_types_json",
  "api_contracts_json",
  "manifests_json",
  "src_dirs_json",
  // File ownership (H.5) + Community ownership (H.4)
  "orphan_grade",
  "is_orphan",
  "truck_factor",
  "ownership_drift_30d",
  "ownership_drift_90d",
  "ownership_drift_365d",
  // v1.2 extensions (append-only). New columns MUST go to the end of this
  // list and the tail of the CREATE TABLE in schema-ddl.ts — reordering
  // rewrites every `VALUES (?, ?, ...)` slot and breaks existing graphs.
  "deadness",
  "coverage_percent",
  "covered_lines_json",
  "cyclomatic_complexity",
  "nesting_depth",
  "nloc",
  "halstead_volume",
  "input_schema_json",
  "partial_fingerprint",
  "baseline_state",
  "suppressed_json",
];

/**
 * Convert a GraphNode into the row ordering expected by the `nodes` table
 * DDL. Each slot is either a typed scalar, an array (for `TEXT[]` columns),
 * or `null`. Field reads are defensive bracket-access so unknown / future
 * NodeKinds fall through to NULL-valued columns.
 *
 * Field/column aliasing:
 *   - `OperationNode.method` → `http_method` column (not `method`, which is
 *     reserved for RouteNode).
 *   - `OperationNode.path`   → `http_path`   column.
 *   The Operation write-through still preserves read-back determinism
 *   because the round-trip helper maps `http_method`/`http_path` back to
 *   `method`/`path` when `kind === "Operation"`.
 */
function nodeToRow(node: GraphNode): readonly (SqlParam | readonly string[])[] {
  const n = node as GraphNode & Record<string, unknown>;
  const isOperation = node.kind === "Operation";
  return [
    node.id,
    node.kind,
    node.name,
    node.filePath,
    numberOrNull(n["startLine"]),
    numberOrNull(n["endLine"]),
    booleanOrNull(n["isExported"]),
    stringOrNull(n["signature"]),
    numberOrNull(n["parameterCount"]),
    stringOrNull(n["returnType"]),
    stringOrNull(n["declaredType"]),
    stringOrNull(n["owner"]),
    stringOrNull(n["url"]),
    // Route.method → method; Operation.method goes to http_method instead.
    isOperation ? null : stringOrNull(n["method"]),
    stringOrNull(n["toolName"]),
    stringOrNull(n["content"]),
    stringOrNull(n["contentHash"]),
    stringOrNull(n["inferredLabel"]),
    numberOrNull(n["symbolCount"]),
    numberOrNull(n["cohesion"]),
    stringArrayOrNull(n["keywords"]),
    stringOrNull(n["entryPointId"]),
    numberOrNull(n["stepCount"]),
    numberOrNull(n["level"]),
    stringArrayOrNull(n["responseKeys"]),
    stringOrNull(n["description"]),
    // Finding
    stringOrNull(n["severity"]),
    stringOrNull(n["ruleId"]),
    stringOrNull(n["scannerId"]),
    stringOrNull(n["message"]),
    jsonObjectOrNull(n["propertiesBag"]),
    // Dependency
    stringOrNull(n["version"]),
    stringOrNull(n["license"]),
    stringOrNull(n["lockfileSource"]),
    stringOrNull(n["ecosystem"]),
    // Operation — OperationNode uses .method / .path on the type.
    isOperation ? stringOrNull(n["method"]) : null,
    isOperation ? stringOrNull(n["path"]) : null,
    stringOrNull(n["summary"]),
    stringOrNull(n["operationId"]),
    // Contributor
    stringOrNull(n["emailHash"]),
    stringOrNull(n["emailPlain"]),
    // ProjectProfile (JSON-encoded array fields)
    jsonArrayOrNull(n["languages"]),
    // `frameworks_json` is the polymorphic column: legacy rows store a
    // flat `string[]`, v2.0 rows store `{ flat, detected }` so the
    // structured `FrameworkDetection[]` survives a round-trip. Read-back
    // at `packages/mcp/src/tools/project-profile.ts` handles both shapes.
    frameworksJsonOrNull(n["frameworks"], n["frameworksDetected"]),
    jsonArrayOrNull(n["iacTypes"]),
    jsonArrayOrNull(n["apiContracts"]),
    jsonArrayOrNull(n["manifests"]),
    jsonArrayOrNull(n["srcDirs"]),
    // File ownership (H.5) + Community ownership (H.4)
    stringOrNull(n["orphanGrade"]),
    booleanOrNull(n["isOrphan"]),
    numberOrNull(n["truckFactor"]),
    numberOrNull(n["ownershipDrift30d"]),
    numberOrNull(n["ownershipDrift90d"]),
    numberOrNull(n["ownershipDrift365d"]),
    // v1.2 extensions. Each column is populated by a single phase and stays
    // NULL for kinds the phase doesn't touch:
    //   - `deadness`: dead-code phase (callables). Hyphenated
    //     `unreachable-export` is rewritten here into the schema's
    //     underscored form so consumers query a single spelling.
    //   - `coverage_percent` / `covered_lines_json`: coverage phase. File
    //     nodes carry the numeric array (flattened to JSON), callables may
    //     carry an already-serialised string — prefer the string.
    //   - `cyclomatic_complexity` / `nesting_depth` / `nloc` /
    //     `halstead_volume`: complexity phase (callables).
    //   - `input_schema_json`: tools phase (Tool nodes).
    //   - `partial_fingerprint` / `baseline_state` / `suppressed_json`:
    //     SARIF ingest (Finding nodes).
    stringOrNull(normalizeDeadness(n["deadness"])),
    numberOrNull(n["coveragePercent"]),
    coveredLinesOrNull(n["coveredLines"], n["coveredLinesJson"]),
    numberOrNull(n["cyclomaticComplexity"]),
    numberOrNull(n["nestingDepth"]),
    numberOrNull(n["nloc"]),
    numberOrNull(n["halsteadVolume"]),
    stringOrNull(n["inputSchemaJson"]),
    stringOrNull(n["partialFingerprint"]),
    stringOrNull(n["baselineState"]),
    stringOrNull(n["suppressedJson"]),
  ];
}

/**
 * Translate the hyphenated `unreachable-export` produced by the analysis
 * helper into the underscored form the `deadness` column stores. Every
 * other value (`live` / `dead`) already matches the schema enum.
 */
function normalizeDeadness(v: unknown): unknown {
  if (v === "unreachable-export") return "unreachable_export";
  return v;
}

/**
 * Resolve the value for the `covered_lines_json` column. File nodes carry a
 * `coveredLines: readonly number[]` field (flattened via canonical JSON);
 * callables carry an already-serialised `coveredLinesJson` string. Prefer
 * the string when present so we don't re-stringify work the caller already
 * did.
 */
function coveredLinesOrNull(coveredLines: unknown, coveredLinesJson: unknown): string | null {
  if (typeof coveredLinesJson === "string" && coveredLinesJson.length > 0) {
    return coveredLinesJson;
  }
  return jsonArrayOrNull(coveredLines);
}

/**
 * Dedupe by the caller-provided id extractor, keeping the LAST occurrence.
 * Protects against DuckDB UPSERT issue 8147 (two rows with the same primary
 * key in one INSERT cannot both fire ON CONFLICT). The caller-driven id
 * function also lets us reuse this for both nodes and relations.
 */
function dedupeLastById<T>(items: readonly T[], idOf: (t: T) => string): readonly T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    seen.set(idOf(item), item);
  }
  return Array.from(seen.values());
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function booleanOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function stringArrayOrNull(v: unknown): readonly string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out.length > 0 ? out : null;
}

/**
 * Serialize an array of primitives (strings / numbers / booleans / null) or
 * arbitrary JSON-safe records to a canonical JSON string. Returns `null` for
 * any input that is not an array. Object values are serialized verbatim via
 * `JSON.stringify`, preserving nested structure. Values that are already a
 * string are passed through unchanged so callers can pre-canonicalize.
 */
function jsonArrayOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return null;
  return JSON.stringify(v);
}

/**
 * Serialize the polymorphic `frameworks_json` column.
 *
 * Two generations coexist:
 *   - Legacy v1.0 graphs (before P05) wrote a flat `string[]` via
 *     `jsonArrayOrNull`. Reader code must accept that shape unchanged.
 *   - v2.0 graphs (after P05) write `{ flat: string[], detected: FrameworkDetection[] }`.
 *
 * The encoding is JSON in both cases. When the node carries no structured
 * detections (`frameworksDetected` absent or empty) we emit the legacy
 * flat-array shape so existing read paths continue to work without a
 * version bump. The read side in `packages/mcp/src/tools/project-profile.ts`
 * sniffs the shape.
 */
function frameworksJsonOrNull(flat: unknown, detected: unknown): string | null {
  const flatArr = Array.isArray(flat) ? flat.filter((x): x is string => typeof x === "string") : [];
  const detectedArr = Array.isArray(detected) ? detected : [];
  if (detectedArr.length === 0) {
    // Preserve the legacy wire shape when there is nothing structured to emit.
    return JSON.stringify(flatArr);
  }
  return JSON.stringify({ flat: flatArr, detected: detectedArr });
}

/**
 * Serialize a Record<string, unknown> (or a pre-serialized JSON string) into
 * a JSON string for storage in a polymorphic TEXT column. Returns `null` for
 * null / undefined / non-object / non-string inputs.
 */
function jsonObjectOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return JSON.stringify(v);
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
