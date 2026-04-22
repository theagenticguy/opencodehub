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
  EmbeddingRow,
  IGraphStore,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "./interface.js";
import { generateSchemaDDL } from "./schema-ddl.js";
import { assertReadOnlySql } from "./sql-guard.js";

export interface DuckDbStoreOptions {
  readonly readOnly?: boolean;
  /** Fixed vector dimension for the `embeddings.vector` column. Default 384. */
  readonly embeddingDim?: number;
  /** Default query timeout for `query()` calls in ms. Default 5000. */
  readonly timeoutMs?: number;
}

const DEFAULT_EMBEDDING_DIM = 384;
const DEFAULT_TIMEOUT_MS = 5_000;
// NOTE: widened to `readonly string[]` so new relation names added by the
// core-types v1.1 migration (FOUND_IN / DEPENDS_ON / OWNED_BY / COCHANGES)
// can be defaulted here without a tight coupling to the compile-time union.
// Ordering is preserved from the v1.0 list; new types are appended.
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
  "COCHANGES",
];

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
      // Remove any pre-existing rows with matching (node_id, chunk_index) so
      // this method is effectively an upsert.
      const delStmt = await c.prepare(
        "DELETE FROM embeddings WHERE node_id = ? AND chunk_index = ?",
      );
      try {
        for (const r of rows) {
          delStmt.clearBindings();
          delStmt.bindVarchar(1, r.nodeId);
          delStmt.bindInteger(2, r.chunkIndex);
          await delStmt.run();
        }
      } finally {
        delStmt.destroySync();
      }

      const insStmt = await c.prepare(
        "INSERT INTO embeddings (id, node_id, chunk_index, start_line, end_line, vector, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      try {
        for (const r of rows) {
          if (r.vector.length !== dim) {
            throw new Error(
              `Embedding dimension mismatch: got ${r.vector.length}, expected ${dim}`,
            );
          }
          insStmt.clearBindings();
          insStmt.bindVarchar(1, `Emb:${r.nodeId}:${r.chunkIndex}`);
          insStmt.bindVarchar(2, r.nodeId);
          insStmt.bindInteger(3, r.chunkIndex);
          bindParam(insStmt, 4, r.startLine ?? null);
          bindParam(insStmt, 5, r.endLine ?? null);
          insStmt.bindArray(6, arrayValue(Array.from(r.vector)), arrType);
          insStmt.bindVarchar(7, r.contentHash);
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

    // Filter-first subquery pattern: pre-filter embeddings by the optional
    // whereClause (joined to nodes as `n`) and only then compute distance +
    // ORDER BY. This sidesteps DuckDB planner quirks where an HNSW index scan
    // might drop the WHERE filter entirely on small datasets.
    const filterSql = q.whereClause
      ? `SELECT e.node_id, e.vector
         FROM embeddings e JOIN nodes n ON n.id = e.node_id
         WHERE ${q.whereClause}`
      : `SELECT e.node_id, e.vector FROM embeddings e`;
    const sql = `WITH filtered AS (${filterSql})
      SELECT node_id, array_distance(vector, ?) AS distance
      FROM filtered
      ORDER BY distance
      LIMIT ?`;

    const stmt = await c.prepare(sql);
    try {
      // Positional binds: whereClause params first, then vector, then limit.
      let idx = 1;
      if (q.params) {
        for (const p of q.params) {
          bindParam(stmt, idx++, p);
        }
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
  // v2.0 extensions (append-only)
  "deadness",
  "coverage_percent",
  "covered_lines_json",
  "cyclomatic_complexity",
  "nesting_depth",
  "nloc",
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
    jsonArrayOrNull(n["frameworks"]),
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
    // v2.0 extensions: coverage overlay (Q.2) + complexity fields (Q.2 gate).
    // coveredLines flattens to a JSON array so the column stays TEXT.
    stringOrNull(n["deadness"]),
    numberOrNull(n["coveragePercent"]),
    jsonArrayOrNull(n["coveredLines"]),
    numberOrNull(n["cyclomaticComplexity"]),
    numberOrNull(n["nestingDepth"]),
    numberOrNull(n["nloc"]),
  ];
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
