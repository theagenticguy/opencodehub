/**
 * SqliteStore — single-file storage adapter (branch `spike/sqlite-single-file`).
 *
 * THESIS. One `*.sqlite` file in WAL mode backs EVERYTHING: graph nodes,
 * edges, embeddings, and the temporal/non-graph tables (cochanges, symbol
 * summaries) that today live in two native-binding engines
 * (`graph.lbug` via @ladybugdb/core + `temporal.duckdb` via @duckdb/node-api).
 * Collapsing both onto Node 24's built-in `node:sqlite` removes the last two
 * native dependencies, which is what unlocks the real goal: a zero-dep,
 * one-command, no-Docker install (`npm i -g @opencodehub/cli` and nothing else).
 *
 * STATUS. This file implements the FULL {@link IGraphStore} +
 * {@link ITemporalStore} surface against a single file. Embeddings live in
 * the `embeddings` table inside store.sqlite; there is no DuckDB dependency
 * and no Parquet export (ADR 0019 dropped the write-only sidecar).
 *
 * GRAPH-HASH PARITY. The hard success criterion is that a `KnowledgeGraph`
 * rebuilt from `listNodes({})` + `listEdges({})` produces a byte-identical
 * `graphHash`. The node write/read path round-trips the full node object
 * through a JSON `payload` column (so arbitrary kind-specific fields — and the
 * `keywords: []`-vs-absent and `languageStats: {}` distinctions canonicalJson
 * cares about — survive verbatim). The edge read path mirrors
 * `GraphDbStore.listEdgesInternalGd` exactly, including the
 * {@link stepZeroSentinel} drop, the empty-reason drop, and the
 * `(from, to, type, id)` sort. Filter-only columns (severity, rule_id,
 * ecosystem, method, entry_point_id, repo_uri, …) live INSIDE the payload and
 * are reached via SQLite JSON1 `payload->>'$.field'` extracts.
 *
 * NON-GOAL. No backwards compatibility. Clean slate: this adapter assumes a
 * fresh index, not a migration of existing `graph.lbug` / `temporal.duckdb`
 * artifacts (per the spike brief).
 */

// Install the experimental-warning guard BEFORE the node:sqlite binding loads.
import "./sqlite-runtime.js";

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  CodeRelation,
  DependencyNode,
  FindingNode,
  GraphNode,
  KnowledgeGraph,
  NodeId,
  NodeKind,
  NodeOfKind,
  RelationType,
  RepoNode,
  RouteNode,
} from "@opencodehub/core-types";
import { stepZeroSentinel } from "./column-encode.js";
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
import { classifyLicenseTier } from "./license.js";
import { getAllRelationTypes } from "./relations.js";
import { assertReadOnlySql } from "./sql-guard.js";

export interface SqliteStoreOptions {
  /** Open the file read-only. Query commands pass true; ingestion false. */
  readonly readOnly?: boolean;
  /** Embedding dimensionality. Defaults to 768 (Bedrock Titan / Cohere tier). */
  readonly embeddingDim?: number;
  /**
   * Journal mode. Defaults to WAL — the whole point of the spike. Overridable
   * to `MEMORY` for `:memory:` tests where WAL is a no-op anyway.
   */
  readonly journalMode?: "WAL" | "MEMORY" | "DELETE";
  /** Default query timeout for `exec()` calls in ms. Default 5000. */
  readonly timeoutMs?: number;
}

const DEFAULT_DIM = 768;
const SCHEMA_VERSION = "spike-sqlite-1";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COCHANGE_LOOKUP_LIMIT = 10;
const DEFAULT_COCHANGE_MIN_LIFT = 1.0;
const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Single-file store implementing the full IGraphStore + ITemporalStore
 * surface. Lifecycle mirrors the existing adapters:
 *   open → createSchema → bulkLoad → query/search/vectorSearch/traverse → close
 */
export class SqliteStore implements IGraphStore, ITemporalStore {
  /**
   * Dialect tag. node:sqlite speaks SQL, not Cypher, but {@link GraphDialect}
   * is currently the single literal `"cypher"`. Rather than widen the union
   * (and force every consumer to handle a second tag for a property OCH core
   * never branches on), we keep `"cypher"` and leave a TODO. The
   * {@link IGraphStore.execCypher} escape hatch is intentionally NOT
   * implemented here — this adapter exposes raw SQL via {@link exec} on the
   * temporal surface instead.
   *
   * TODO(P3): if a SQL community-adapter tag is ever needed, widen
   * `GraphDialect = "cypher" | "sql"` in interface.ts (one-line union change)
   * and set this to `"sql"`.
   */
  readonly dialect: GraphDialect = "cypher";

  private db: DatabaseSync | undefined;
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly dim: number;
  private readonly journalMode: "WAL" | "MEMORY" | "DELETE";
  private readonly defaultTimeoutMs: number;

  constructor(path: string, opts: SqliteStoreOptions = {}) {
    this.path = path;
    this.readOnly = opts.readOnly ?? false;
    this.dim = opts.embeddingDim ?? DEFAULT_DIM;
    this.journalMode = opts.journalMode ?? (path === ":memory:" ? "MEMORY" : "WAL");
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.db) return; // idempotent
    this.db = new DatabaseSync(this.path, { readOnly: this.readOnly });
    // WAL is the headline: concurrent readers never block the writer, the file
    // is crash-safe, and there is no server process. A read-only handle cannot
    // change journal mode, so only set it on a writable open.
    //
    // NOTE — these PRAGMAs run on the TRUSTED internal path, never through
    // {@link exec}. assertReadOnlySql blocks PRAGMA as a dangerous keyword, so
    // user SQL can never reach this surface.
    if (!this.readOnly) {
      this.db.exec(`PRAGMA journal_mode = ${this.journalMode};`);
      this.db.exec("PRAGMA synchronous = NORMAL;"); // WAL-safe, fast
      this.db.exec("PRAGMA foreign_keys = ON;");
    }
    // node:sqlite has no connection.interrupt(); a busy-timeout is the only
    // best-effort lever for lock contention (NOT a long-scan timeout).
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(this.defaultTimeoutMs))};`);
  }

  async close(): Promise<void> {
    if (!this.db) return;
    // One handle owns graph + temporal. No two-adapter ordered teardown.
    if (!this.readOnly) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.close();
    this.db = undefined;
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const row = this.conn().prepare("SELECT 1 AS ok;").get() as { ok: number };
      return { ok: row.ok === 1 };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async createSchema(): Promise<void> {
    const db = this.conn();
    // ── Graph tier ──
    // Generic node table: typed columns for the universal NodeBase fields
    // (id/kind/name/file_path) + a JSON `payload` overflow carrying the
    // kind-specific fields. This is the spike's central proposal: one table
    // for 37 node kinds, not 37 tables. Rehydration reads payload back
    // verbatim so canonicalJson sees the identical field set on rebuild.
    //
    // Filter-only fields (severity, rule_id, ecosystem, method, …) are reached
    // via SQLite JSON1 `payload->>'$.field'` extracts at query time — no extra
    // typed columns needed, which keeps the write path lossless.
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        file_path   TEXT,
        start_line  INTEGER,
        end_line    INTEGER,
        payload     TEXT          -- canonical JSON of remaining fields
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
    `);
    // Edges: one polymorphic table keyed by type, with the (from,to,type,step)
    // dedup tuple as the natural key — mirrors KnowledgeGraph.edgeDedupKey.
    db.exec(`
      CREATE TABLE IF NOT EXISTS edges (
        id          TEXT PRIMARY KEY,
        src         TEXT NOT NULL,
        dst         TEXT NOT NULL,
        type        TEXT NOT NULL,
        confidence  REAL NOT NULL DEFAULT 1.0,
        step        INTEGER,
        reason      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src, type);
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, type);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
    `);
    // Embeddings: the f32 vector lives in a BLOB (little-endian Float32Array
    // bytes). Composite PK matches the existing (granularity,node_id,chunk)
    // key. content_hash drives incremental skip-re-embed.
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        node_id      TEXT NOT NULL,
        granularity  TEXT NOT NULL DEFAULT 'symbol',
        chunk_index  INTEGER NOT NULL DEFAULT 0,
        start_line   INTEGER,
        end_line     INTEGER,
        dim          INTEGER NOT NULL,
        vector       BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (granularity, node_id, chunk_index)
      );
    `);
    // BM25 search: an FTS5 virtual table mirroring the THREE columns lbug's
    // QUERY_FTS_INDEX indexes — name + signature + description. node_id is
    // UNINDEXED (carried for the join back to `nodes`). Populated at bulkLoad
    // from nodes.name + payload.signature/description.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        node_id UNINDEXED,
        name,
        signature,
        description,
        tokenize='unicode61'
      );
    `);
    // ── Temporal / non-graph tier — same file, no second engine ──
    // Canonical 7-column cochanges shape (matches schema-ddl.ts:30-42).
    // last_cocommit_at is stored as a TEXT ISO-8601 string (SQLite has no
    // native TIMESTAMP type; the affinity is irrelevant for a TEXT round-trip).
    db.exec(`
      CREATE TABLE IF NOT EXISTS cochanges (
        source_file            TEXT NOT NULL,
        target_file            TEXT NOT NULL,
        cocommit_count         INTEGER NOT NULL,
        total_commits_source   INTEGER NOT NULL,
        total_commits_target   INTEGER NOT NULL,
        last_cocommit_at       TEXT NOT NULL,
        lift                   REAL NOT NULL,
        PRIMARY KEY (source_file, target_file)
      );
      CREATE INDEX IF NOT EXISTS idx_cochanges_source ON cochanges (source_file);
      CREATE INDEX IF NOT EXISTS idx_cochanges_target ON cochanges (target_file);
    `);
    // Canonical 9-column symbol_summaries shape (matches schema-ddl.ts:54-67).
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_summaries (
        node_id              TEXT NOT NULL,
        content_hash         TEXT NOT NULL,
        prompt_version       TEXT NOT NULL,
        model_id             TEXT NOT NULL,
        summary_text         TEXT NOT NULL,
        signature_summary    TEXT,
        returns_type_summary TEXT,
        structured_json      TEXT,
        created_at           TEXT NOT NULL,
        PRIMARY KEY (node_id, content_hash, prompt_version)
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_node ON symbol_summaries (node_id);
    `);
    // Single-row meta table keyed by id=1 (mirrors GraphDbStore's StoreMeta
    // {id:1} MERGE pattern). Typed columns so getMeta can re-attach optional
    // fields only when the column is non-null (exactOptional readback).
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version    TEXT NOT NULL,
        last_commit       TEXT,
        indexed_at        TEXT NOT NULL,
        node_count        INTEGER NOT NULL,
        edge_count        INTEGER NOT NULL,
        stats_json        TEXT,
        cache_hit_ratio   REAL,
        cache_size_bytes  INTEGER,
        last_compaction   TEXT,
        embedder_model_id TEXT
      );
    `);
  }

  // ── Bulk load (graph write path) ────────────────────────────────────────────

  async bulkLoad(graph: KnowledgeGraph, _opts?: BulkLoadOptions): Promise<BulkLoadStats> {
    const db = this.conn();
    const start = Date.now();
    const nodes = graph.orderedNodes();
    const edges = graph.orderedEdges();
    const insNode = db.prepare(
      `INSERT OR REPLACE INTO nodes (id,kind,name,file_path,start_line,end_line,payload)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const insEdge = db.prepare(
      `INSERT OR REPLACE INTO edges (id,src,dst,type,confidence,step,reason)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const insFts = db.prepare(
      `INSERT INTO nodes_fts (node_id,name,signature,description) VALUES (?,?,?,?)`,
    );
    // FTS5 has no UPSERT; in upsert mode we delete the per-node FTS row before
    // re-inserting so a re-loaded node does not duplicate its search entry.
    const delFtsForNode = db.prepare(`DELETE FROM nodes_fts WHERE node_id = ?`);
    // "replace" (default) truncates and reloads the whole graph. "upsert" MERGES
    // the supplied nodes/edges into the existing graph WITHOUT wiping — this is
    // the contract ingest-sarif relies on (it adds Finding nodes + FOUND_IN
    // edges to an already-loaded graph; a wipe here would destroy the index, as
    // it did before this fix). INSERT OR REPLACE handles the per-row upsert.
    const mode = _opts?.mode ?? "replace";
    // One transaction for the whole load — WAL turns this into a single fsync.
    db.exec("BEGIN");
    try {
      if (mode === "replace") {
        db.exec("DELETE FROM nodes");
        db.exec("DELETE FROM edges");
        db.exec("DELETE FROM nodes_fts");
      }
      for (const n of nodes) {
        this.writeNode(insNode, n);
        const anyNode = n as unknown as Record<string, unknown>;
        const sig = anyNode["signature"];
        const desc = anyNode["description"];
        if (mode === "upsert") delFtsForNode.run(String(n.id));
        insFts.run(
          String(n.id),
          String(n.name),
          typeof sig === "string" ? sig : "",
          typeof desc === "string" ? desc : "",
        );
      }
      for (const e of edges) {
        insEdge.run(e.id, e.from, e.to, e.type, e.confidence, e.step ?? null, e.reason ?? null);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    // Stamp store_meta from the ACTUAL post-write table counts, so an upsert
    // batch (which carries only the added rows) does not clobber the meta with
    // a partial count. Callers that own richer meta (analyze) overwrite this
    // with a full setMeta() afterward; this keeps a freshly-bulk-loaded store
    // self-consistent on its own.
    const totalNodes = (db.prepare("SELECT count(*) c FROM nodes").get() as { c: number }).c;
    const totalEdges = (db.prepare("SELECT count(*) c FROM edges").get() as { c: number }).c;
    const existing = await this.getMeta();
    await this.setMeta({
      ...(existing ?? {}),
      schemaVersion: existing?.schemaVersion ?? SCHEMA_VERSION,
      indexedAt: existing?.indexedAt ?? new Date().toISOString(),
      nodeCount: totalNodes,
      edgeCount: totalEdges,
    });
    // bulkLoad reports the rows IT loaded (the batch), not the table total.
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      durationMs: Date.now() - start,
    };
  }

  private writeNode(stmt: StatementSync, n: GraphNode): void {
    // Split the universal base off; everything else canonical-JSONs into payload.
    const anyNode = n as unknown as Record<string, unknown>;
    const {
      id,
      kind,
      name,
      filePath = undefined,
      startLine = undefined,
      endLine = undefined,
      ...rest
    } = anyNode;
    stmt.run(
      String(id),
      String(kind),
      String(name),
      filePath === undefined ? null : String(filePath),
      typeof startLine === "number" ? startLine : null,
      typeof endLine === "number" ? endLine : null,
      Object.keys(rest).length ? JSON.stringify(rest) : null,
    );
  }

  // ── Node finders ─────────────────────────────────────────────────────────────

  async getNode(id: NodeId): Promise<GraphNode | undefined> {
    const row = this.conn()
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get(String(id)) as unknown as NodeRow | undefined;
    return row ? rehydrateNode(row) : undefined;
  }

  async listNodes(opts: ListNodesOptions = {}): Promise<readonly GraphNode[]> {
    // Empty-array short-circuits BEFORE touching the connection (matches
    // GraphDbStore.listNodes:1115-1117 — pure-JS contract).
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length === 0) return [];
    const idsRaw = opts.ids;
    if (idsRaw !== undefined && idsRaw.length === 0) return [];
    const ids = idsRaw !== undefined ? Array.from(new Set(idsRaw)) : undefined;
    const limit = clampNonNegativeInt(opts.limit);
    const offset = clampNonNegativeInt(opts.offset);

    const wheres: string[] = [];
    const params: SqlParam[] = [];
    if (kinds && kinds.length > 0) {
      wheres.push(`kind IN (${placeholders(kinds.length)})`);
      for (const k of kinds) params.push(k);
    }
    if (ids !== undefined && ids.length > 0) {
      wheres.push(`id IN (${placeholders(ids.length)})`);
      for (const i of ids) params.push(i);
    }
    if (opts.filePath !== undefined) {
      wheres.push("file_path = ?");
      params.push(opts.filePath);
    }
    const sql = `SELECT * FROM nodes${whereClause(wheres)} ORDER BY id ASC${pageClause(limit, offset)}`;
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as NodeRow[];
    return sortById(rows.map(rehydrateNode));
  }

  async listNodesByKind<K extends NodeKind>(
    kind: K,
    opts: ListNodesByKindOptions = {},
  ): Promise<readonly NodeOfKind<K>[]> {
    const limit = clampNonNegativeInt(opts.limit);
    const offset = clampNonNegativeInt(opts.offset);
    const wheres: string[] = ["kind = ?"];
    const params: SqlParam[] = [kind];
    // NOTE: GraphDbStore ANDs filePath + filePathLike (impl 1201-1210) even
    // though the interface doc says "exact takes priority" — mirror the IMPL.
    if (opts.filePath !== undefined) {
      wheres.push("file_path = ?");
      params.push(opts.filePath);
    }
    if (opts.filePathLike !== undefined) {
      wheres.push("file_path LIKE '%' || ? || '%'");
      params.push(opts.filePathLike);
    }
    const sql = `SELECT * FROM nodes${whereClause(wheres)} ORDER BY id ASC${pageClause(limit, offset)}`;
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as NodeRow[];
    return sortById(rows.map(rehydrateNode)) as unknown as readonly NodeOfKind<K>[];
  }

  async listFindings(opts: ListFindingsOptions = {}): Promise<readonly FindingNode[]> {
    const wheres: string[] = ["kind = 'Finding'"];
    const params: SqlParam[] = [];
    if (opts.severity && opts.severity.length > 0) {
      wheres.push(`payload->>'$.severity' IN (${placeholders(opts.severity.length)})`);
      for (const s of opts.severity) params.push(s);
    }
    if (opts.ruleId !== undefined) {
      wheres.push("payload->>'$.ruleId' = ?");
      params.push(opts.ruleId);
    }
    if (opts.baselineState && opts.baselineState.length > 0) {
      wheres.push(`payload->>'$.baselineState' IN (${placeholders(opts.baselineState.length)})`);
      for (const s of opts.baselineState) params.push(s);
    }
    if (opts.suppressed === true) {
      wheres.push("payload->>'$.suppressedJson' IS NOT NULL");
    } else if (opts.suppressed === false) {
      wheres.push("payload->>'$.suppressedJson' IS NULL");
    }
    const limit = clampNonNegativeInt(opts.limit);
    const sql =
      "SELECT * FROM nodes" +
      whereClause(wheres) +
      " ORDER BY id ASC" +
      pageClause(limit, undefined);
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as NodeRow[];
    const out: FindingNode[] = [];
    for (const r of rows) {
      const node = rehydrateNode(r);
      if (node.kind === "Finding") out.push(node as FindingNode);
    }
    return sortById(out) as readonly FindingNode[];
  }

  async listDependencies(opts: ListDependenciesOptions = {}): Promise<readonly DependencyNode[]> {
    const wheres: string[] = ["kind = 'Dependency'"];
    const params: SqlParam[] = [];
    if (opts.ecosystem !== undefined) {
      wheres.push("payload->>'$.ecosystem' = ?");
      params.push(opts.ecosystem);
    }
    const limit = clampNonNegativeInt(opts.limit);
    const sql =
      "SELECT * FROM nodes" +
      whereClause(wheres) +
      " ORDER BY id ASC" +
      pageClause(limit, undefined);
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as NodeRow[];
    // licenseTier is a JS-side post-filter via classifyLicenseTier, NOT SQL —
    // the LIMIT above applies BEFORE the tier filter, matching the reference.
    const tierSet =
      opts.licenseTier && opts.licenseTier.length > 0 ? new Set(opts.licenseTier) : undefined;
    const out: DependencyNode[] = [];
    for (const r of rows) {
      const node = rehydrateNode(r);
      if (node.kind !== "Dependency") continue;
      if (tierSet) {
        const tier = classifyLicenseTier((node as DependencyNode).license);
        if (!tierSet.has(tier)) continue;
      }
      out.push(node as DependencyNode);
    }
    return sortById(out) as readonly DependencyNode[];
  }

  async listRoutes(opts: ListRoutesOptions = {}): Promise<readonly RouteNode[]> {
    const wheres: string[] = ["kind = 'Route'"];
    const params: SqlParam[] = [];
    if (opts.methods && opts.methods.length > 0) {
      wheres.push(`payload->>'$.method' IN (${placeholders(opts.methods.length)})`);
      for (const m of opts.methods) params.push(m);
    }
    if (opts.pathLike !== undefined) {
      wheres.push("payload->>'$.url' LIKE '%' || ? || '%'");
      params.push(opts.pathLike);
    }
    const limit = clampNonNegativeInt(opts.limit);
    const sql =
      "SELECT * FROM nodes" +
      whereClause(wheres) +
      " ORDER BY id ASC" +
      pageClause(limit, undefined);
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as NodeRow[];
    const out: RouteNode[] = [];
    for (const r of rows) {
      const node = rehydrateNode(r);
      if (node.kind === "Route") out.push(node as RouteNode);
    }
    return sortById(out) as readonly RouteNode[];
  }

  async getRepoNode(id: string): Promise<RepoNode | undefined> {
    // Double-guard kind='Repo': in the WHERE and again on the rehydrated node.
    const row = this.conn()
      .prepare("SELECT * FROM nodes WHERE id = ? AND kind = 'Repo' LIMIT 1")
      .get(String(id)) as unknown as NodeRow | undefined;
    if (!row) return undefined;
    const node = rehydrateNode(row);
    if (node.kind !== "Repo") return undefined;
    return node as RepoNode;
  }

  async listNodesByEntryPoint(entryPointId: string): Promise<readonly GraphNode[]> {
    // Kind-agnostic on read; entryPointId lives in the payload.
    const rows = this.conn()
      .prepare("SELECT * FROM nodes WHERE payload->>'$.entryPointId' = ? ORDER BY id ASC")
      .all(entryPointId) as unknown as NodeRow[];
    return sortById(rows.map(rehydrateNode));
  }

  async listNodesByName(
    name: string,
    opts: ListNodesByNameOptions = {},
  ): Promise<readonly GraphNode[]> {
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length === 0) return [];
    const wheres: string[] = ["name = ?"];
    const params: SqlParam[] = [name];
    if (kinds && kinds.length > 0) {
      wheres.push(`kind IN (${placeholders(kinds.length)})`);
      for (const k of kinds) params.push(k);
    }
    if (opts.filePath !== undefined) {
      wheres.push("file_path = ?");
      params.push(opts.filePath);
    }
    const limit = clampNonNegativeInt(opts.limit);
    const sql =
      "SELECT * FROM nodes" +
      whereClause(wheres) +
      " ORDER BY id ASC" +
      pageClause(limit, undefined);
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as NodeRow[];
    return sortById(rows.map(rehydrateNode));
  }

  async countNodesByKind(kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>> {
    const out = new Map<NodeKind, number>();
    // kinds:[] → empty Map (short-circuit before the connection).
    if (kinds !== undefined && kinds.length === 0) return out;
    let sql = "SELECT kind, COUNT(*) AS n FROM nodes";
    const params: SqlParam[] = [];
    if (kinds && kinds.length > 0) {
      sql += ` WHERE kind IN (${placeholders(kinds.length)})`;
      for (const k of kinds) params.push(k);
    }
    sql += " GROUP BY kind ORDER BY kind ASC";
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as {
      kind: string;
      n: number | bigint;
    }[];
    for (const r of rows) {
      out.set(r.kind as NodeKind, typeof r.n === "bigint" ? Number(r.n) : Number(r.n ?? 0));
    }
    // Backfill 0 for every requested kind absent from the result.
    if (kinds) {
      for (const k of kinds) if (!out.has(k)) out.set(k, 0);
    }
    return out;
  }

  async countEdgesByType(types?: readonly RelationType[]): Promise<Map<RelationType, number>> {
    const out = new Map<RelationType, number>();
    // types:[] → empty Map (short-circuit before the connection).
    if (types !== undefined && types.length === 0) return out;
    const requested: readonly RelationType[] =
      types && types.length > 0 ? types : (getAllRelationTypes() as readonly RelationType[]);
    let sql = "SELECT type, COUNT(*) AS n FROM edges";
    const params: SqlParam[] = [];
    if (types && types.length > 0) {
      sql += ` WHERE type IN (${placeholders(types.length)})`;
      for (const t of types) params.push(t);
    }
    sql += " GROUP BY type";
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as {
      type: string;
      n: number | bigint;
    }[];
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.type, typeof r.n === "bigint" ? Number(r.n) : Number(r.n ?? 0));
    }
    // Emit a 0 entry for every requested/all type with no rows (the
    // GraphDbStore per-type loop guarantees every input type appears).
    for (const t of requested) out.set(t, counts.get(t) ?? 0);
    return out;
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  async listEdges(opts: ListEdgesOptions = {}): Promise<readonly CodeRelation[]> {
    const wheres: string[] = [];
    const params: SqlParam[] = [];
    // types undefined OR empty → all types; non-empty → restrict.
    if (opts.types && opts.types.length > 0) {
      wheres.push(`type IN (${placeholders(opts.types.length)})`);
      for (const t of opts.types) params.push(t);
    }
    if (opts.fromIds && opts.fromIds.length > 0) {
      wheres.push(`src IN (${placeholders(opts.fromIds.length)})`);
      for (const f of opts.fromIds) params.push(f);
    }
    if (opts.toIds && opts.toIds.length > 0) {
      wheres.push(`dst IN (${placeholders(opts.toIds.length)})`);
      for (const t of opts.toIds) params.push(t);
    }
    // minConfidence: mirror the IMPL (`>=`, inclusive floor), NOT the prose
    // ("strictly below"). Both adapters must agree on `>=` for conformance.
    if (opts.minConfidence !== undefined) {
      wheres.push("confidence >= ?");
      params.push(opts.minConfidence);
    }
    const sql = `SELECT id, src, dst, type, confidence, step, reason FROM edges${whereClause(wheres)}`;
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as EdgeRow[];

    const collected: CodeRelation[] = [];
    for (const row of rows) {
      // step-0 sentinel: 0/null/undefined/non-finite → drop the key.
      const step = stepZeroSentinel(row.step);
      // reason: non-empty string kept; null OR "" → drop the key (.length > 0).
      const reasonVal = row.reason;
      const reason = typeof reasonVal === "string" && reasonVal.length > 0 ? reasonVal : undefined;
      collected.push({
        id: String(row.id ?? "") as CodeRelation["id"],
        from: String(row.src ?? "") as CodeRelation["from"],
        to: String(row.dst ?? "") as CodeRelation["to"],
        type: row.type as RelationType,
        confidence: Number(row.confidence ?? 0),
        ...(reason !== undefined ? { reason } : {}),
        ...(step !== undefined ? { step } : {}),
      });
    }
    // Final ordering: (from, to, type, id) — byte-for-byte the GraphDbStore key.
    collected.sort((x, y) => {
      if (x.from !== y.from) return x.from < y.from ? -1 : 1;
      if (x.to !== y.to) return x.to < y.to ? -1 : 1;
      if (x.type !== y.type) return x.type < y.type ? -1 : 1;
      if (x.id !== y.id) return x.id < y.id ? -1 : 1;
      return 0;
    });
    // limit/offset applied AFTER sort; clamp via clampNonNegativeInt.
    const limit = clampNonNegativeInt(opts.limit);
    const offset = clampNonNegativeInt(opts.offset);
    const startAt = offset ?? 0;
    const end = limit !== undefined ? startAt + limit : collected.length;
    return collected.slice(startAt, end);
  }

  async listEdgesByType(
    type: RelationType,
    opts: ListEdgesByTypeOptions = {},
  ): Promise<readonly CodeRelation[]> {
    // Pin types:[type], forward the rest (NO offset on ListEdgesByTypeOptions),
    // delegate to the same listEdges body.
    const merged: ListEdgesOptions = {
      types: [type],
      ...(opts.fromIds !== undefined ? { fromIds: opts.fromIds } : {}),
      ...(opts.toIds !== undefined ? { toIds: opts.toIds } : {}),
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    };
    return this.listEdges(merged);
  }

  async listConsumerProducerEdges(
    opts: { readonly repoUris?: readonly string[] } = {},
  ): Promise<readonly ConsumerProducerEdge[]> {
    // One row per FETCHES edge whose producer (target) is kind 'Operation'.
    // repo_uri / http_method / http_path live in the producer's payload
    // (camelCase: repoUri / method / path).
    const params: SqlParam[] = [];
    let repoPredicate = "";
    if (opts.repoUris && opts.repoUris.length > 0) {
      const phs = placeholders(opts.repoUris.length);
      repoPredicate =
        ` AND (consumer.payload->>'$.repoUri' IN (${phs}) ` +
        `OR producer.payload->>'$.repoUri' IN (${phs}))`;
      // The IN list appears twice in the SQL → bind the values twice.
      for (const u of opts.repoUris) params.push(u);
      for (const u of opts.repoUris) params.push(u);
    }
    const sql =
      "SELECT consumer.id AS consumer_node_id, " +
      "consumer.payload->>'$.repoUri' AS consumer_repo_uri, " +
      "producer.id AS producer_node_id, " +
      "producer.payload->>'$.repoUri' AS producer_repo_uri, " +
      "producer.payload->>'$.method' AS http_method, " +
      "producer.payload->>'$.path' AS http_path, " +
      "e.id AS r_id " +
      "FROM edges e " +
      "JOIN nodes consumer ON e.src = consumer.id " +
      "JOIN nodes producer ON e.dst = producer.id " +
      "WHERE e.type = 'FETCHES' AND producer.kind = 'Operation'" +
      repoPredicate +
      " ORDER BY consumer_repo_uri ASC, producer_repo_uri ASC, " +
      "http_method ASC, http_path ASC, r_id ASC";
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as Record<string, unknown>[];
    // SQL ORDER BY is authoritative here — NO JS re-sort.
    const out: ConsumerProducerEdge[] = [];
    for (const row of rows) {
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
  }

  // ── Embeddings ───────────────────────────────────────────────────────────────

  async upsertEmbeddings(rows: readonly EmbeddingRow[]): Promise<void> {
    const db = this.conn();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO embeddings
        (node_id,granularity,chunk_index,start_line,end_line,dim,vector,content_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    db.exec("BEGIN");
    try {
      for (const r of rows) {
        stmt.run(
          r.nodeId,
          r.granularity ?? "symbol",
          r.chunkIndex,
          r.startLine ?? null,
          r.endLine ?? null,
          r.vector.length,
          f32ToBlob(r.vector),
          r.contentHash,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async listEmbeddingHashes(): Promise<Map<string, string>> {
    const rows = this.conn()
      .prepare("SELECT node_id, granularity, chunk_index, content_hash FROM embeddings")
      .all() as unknown as {
      node_id: unknown;
      granularity: unknown;
      chunk_index: unknown;
      content_hash: unknown;
    }[];
    const out = new Map<string, string>();
    for (const r of rows) {
      const nodeId = r.node_id;
      const granularity = r.granularity;
      const chunkIndex = r.chunk_index;
      const contentHash = r.content_hash;
      if (
        typeof nodeId !== "string" ||
        typeof granularity !== "string" ||
        typeof contentHash !== "string" ||
        (typeof chunkIndex !== "number" && typeof chunkIndex !== "bigint")
      ) {
        continue;
      }
      const ci = typeof chunkIndex === "bigint" ? Number(chunkIndex) : chunkIndex;
      // Key separator is NUL (\0), NOT ':' (NodeIds contain ':').
      out.set(`${granularity}\0${nodeId}\0${ci}`, contentHash);
    }
    return out;
  }

  async *listEmbeddings(opts: ListEmbeddingsOptions = {}): AsyncIterable<EmbeddingRow> {
    const kinds = opts.kindFilter;
    // Empty kindFilter short-circuits to an empty stream.
    if (kinds !== undefined && kinds.length === 0) return;
    const limit = clampNonNegativeInt(opts.limit);
    const params: SqlParam[] = [];
    let sql =
      "SELECT e.node_id AS node_id, e.granularity AS granularity, " +
      "e.chunk_index AS chunk_index, e.start_line AS start_line, " +
      "e.end_line AS end_line, e.vector AS vector, e.content_hash AS content_hash " +
      "FROM embeddings e";
    if (kinds && kinds.length > 0) {
      sql += ` JOIN nodes n ON n.id = e.node_id WHERE n.kind IN (${placeholders(kinds.length)})`;
      for (const k of kinds) params.push(k);
    }
    sql += " ORDER BY e.node_id ASC, e.granularity ASC, e.chunk_index ASC";
    if (limit !== undefined) sql += ` LIMIT ${limit}`;
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as EmbRow[];
    for (const r of rows) {
      // exactOptionalPropertyTypes: spread optional fields conditionally
      // rather than assigning undefined.
      yield {
        nodeId: r.node_id,
        ...(r.granularity ? { granularity: r.granularity as EmbeddingRow["granularity"] } : {}),
        chunkIndex: r.chunk_index,
        ...(r.start_line != null ? { startLine: r.start_line } : {}),
        ...(r.end_line != null ? { endLine: r.end_line } : {}),
        vector: blobToF32(r.vector),
        contentHash: r.content_hash,
      } as EmbeddingRow;
    }
  }

  /**
   * Brute-force cosine KNN in JS. For repo-scale embedding counts (10²–10⁵
   * vectors) a linear scan with a typed-array dot product is sub-10ms and
   * dependency-free. If a repo ever needs ANN, sqlite-vec loads as a runtime
   * extension via the `loadExtension` seam proven in the spike — no rebuild.
   */
  async vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]> {
    if (q.vector.length !== this.dim) {
      throw new Error(`Vector dimension mismatch: got ${q.vector.length}, expected ${this.dim}`);
    }
    const limit = q.limit ?? 10;
    const query = q.vector;
    const rows = this.conn().prepare("SELECT node_id, vector FROM embeddings").all() as unknown as {
      node_id: string;
      vector: Uint8Array;
    }[];
    // VectorResult.distance is a DISTANCE (lower = closer). Cosine distance
    // = 1 - cosine similarity, so ranking ascending matches the lbug HNSW
    // contract (ORDER BY distance ASC).
    const scored: VectorResult[] = rows.map((r) => ({
      nodeId: r.node_id,
      distance: 1 - cosine(query, blobToF32(r.vector)),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit);
  }

  // ── BM25 search via FTS5 ─────────────────────────────────────────────────────

  async search(q: SearchQuery): Promise<readonly SearchResult[]> {
    const limit = q.limit ?? DEFAULT_SEARCH_LIMIT;
    const kindFilter = q.kinds && q.kinds.length > 0 ? q.kinds : undefined;
    const params: SqlParam[] = [q.text];
    let kindPredicate = "";
    if (kindFilter) {
      kindPredicate = ` AND n.kind IN (${placeholders(kindFilter.length)})`;
      for (const k of kindFilter) params.push(k);
    }
    // CRITICAL: SQLite bm25() returns a NEGATIVE number (more-negative =
    // more-relevant). To expose SearchResult.score as "higher = better"
    // (matching lbug's score DESC), set score = -bm25(...) and ORDER BY
    // bm25(...) ASC (== score DESC). Tiebreak (id, file_path, name) ASC
    // mirrors DuckDbStore.search.
    const sql =
      "SELECT n.id AS node_id, n.file_path AS file_path, n.name AS name, n.kind AS kind, " +
      "-bm25(nodes_fts) AS score, bm25(nodes_fts) AS rank " +
      "FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id " +
      "WHERE nodes_fts MATCH ?" +
      kindPredicate +
      ` ORDER BY rank ASC, n.id ASC, n.file_path ASC, n.name ASC LIMIT ${Number(limit)}`;
    const rows = this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as unknown as Record<string, unknown>[];
    const out: SearchResult[] = [];
    for (const row of rows) {
      // The storage-layer search() NEVER fills summary/signatureSummary —
      // they are a post-join done by MCP/CLI.
      out.push({
        nodeId: String(row["node_id"] ?? ""),
        score: Number(row["score"] ?? 0),
        filePath: String(row["file_path"] ?? ""),
        name: String(row["name"] ?? ""),
        kind: String(row["kind"] ?? ""),
      });
    }
    return out;
  }

  // ── Graph traversal (impact / blast-radius) via recursive CTE ────────────────

  /**
   * Reachability traversal as a single recursive CTE. `direction:"down"`
   * follows outgoing edges (callees / dependencies); `"up"` follows incoming
   * edges (callers / dependents — the blast-radius direction). Bounded by
   * maxDepth so a cyclic graph terminates. This is the LadybugDB-Cypher
   * replacement, and the whole reason traversal is feasible without a
   * graph engine.
   */
  async traverse(q: TraverseQuery): Promise<readonly TraverseResult[]> {
    const maxDepth = Math.max(0, Math.floor(q.maxDepth));
    if (maxDepth === 0) return [];
    const minConf = q.minConfidence ?? 0;
    // relationTypes empty/undefined → all types (no type predicate).
    const relTypes = q.relationTypes && q.relationTypes.length > 0 ? q.relationTypes : undefined;
    const typeParams: SqlParam[] = [];
    let typePredDown = "";
    let typePredUp = "";
    if (relTypes) {
      const phs = placeholders(relTypes.length);
      typePredDown = ` AND edges.type IN (${phs})`;
      typePredUp = ` AND edges.type IN (${phs})`;
    }
    const downStep =
      "SELECT edges.dst, reach.depth + 1, reach.path || ',' || edges.dst " +
      "FROM edges JOIN reach ON edges.src = reach.node_id " +
      `WHERE reach.depth < ? AND edges.confidence >= ? AND instr(reach.path, edges.dst) = 0${typePredDown}`;
    const upStep =
      "SELECT edges.src, reach.depth + 1, reach.path || ',' || edges.src " +
      "FROM edges JOIN reach ON edges.dst = reach.node_id " +
      `WHERE reach.depth < ? AND edges.confidence >= ? AND instr(reach.path, edges.src) = 0${typePredUp}`;

    let recursive: string;
    const stepParams: SqlParam[] = [];
    const pushStep = (down: boolean): void => {
      stepParams.push(maxDepth, minConf);
      if (relTypes) for (const t of relTypes) stepParams.push(t);
      void down;
    };
    if (q.direction === "down") {
      recursive = downStep;
      pushStep(true);
    } else if (q.direction === "up") {
      recursive = upStep;
      pushStep(false);
    } else {
      recursive = `${downStep} UNION ${upStep}`;
      pushStep(true);
      pushStep(false);
    }
    const sql = `
      WITH RECURSIVE reach(node_id, depth, path) AS (
        SELECT ?, 0, ?
        UNION
        ${recursive}
      )
      SELECT node_id, MIN(depth) AS depth, path
      FROM reach WHERE node_id != ?
      GROUP BY node_id ORDER BY depth ASC, node_id ASC`;
    const allParams: SqlParam[] = [
      String(q.startId),
      String(q.startId),
      ...stepParams,
      String(q.startId),
    ];
    void typeParams;
    const rows = this.conn()
      .prepare(sql)
      .all(...(allParams as SqliteParam[])) as unknown as {
      node_id: string;
      depth: number;
      path: string;
    }[];
    return rows.map((r) => ({
      nodeId: r.node_id,
      depth: r.depth,
      path: r.path.split(","),
    }));
  }

  async traverseAncestors(opts: AncestorTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.traverseDirectional(opts, "up");
  }

  async traverseDescendants(opts: DescendantTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.traverseDirectional(opts, "down");
  }

  private async traverseDirectional(
    opts: AncestorTraversalOptions | DescendantTraversalOptions,
    direction: "up" | "down",
  ): Promise<readonly TraverseResult[]> {
    // edgeTypes:[] → [] short-circuit (matches traverseDirectionalGd:1720).
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

  // ── Meta ─────────────────────────────────────────────────────────────────────

  async getMeta(): Promise<StoreMeta | undefined> {
    const row = this.conn().prepare("SELECT * FROM store_meta WHERE id = 1").get() as unknown as
      | MetaRow
      | undefined;
    if (!row) return undefined;
    const stats =
      typeof row.stats_json === "string" && row.stats_json.length > 0
        ? (JSON.parse(row.stats_json) as Record<string, number>)
        : undefined;
    // exactOptionalPropertyTypes: re-attach optional fields ONLY when the
    // column is non-null/non-undefined (mirrors getMeta:1936-1954).
    return {
      schemaVersion: String(row.schema_version),
      ...(row.last_commit !== null && row.last_commit !== undefined
        ? { lastCommit: String(row.last_commit) }
        : {}),
      indexedAt: String(row.indexed_at),
      nodeCount: Number(row.node_count ?? 0),
      edgeCount: Number(row.edge_count ?? 0),
      ...(stats ? { stats } : {}),
      ...(row.cache_hit_ratio !== null && row.cache_hit_ratio !== undefined
        ? { cacheHitRatio: Number(row.cache_hit_ratio) }
        : {}),
      ...(row.cache_size_bytes !== null && row.cache_size_bytes !== undefined
        ? { cacheSizeBytes: Number(row.cache_size_bytes) }
        : {}),
      ...(row.last_compaction !== null && row.last_compaction !== undefined
        ? { lastCompaction: String(row.last_compaction) }
        : {}),
      ...(row.embedder_model_id !== null && row.embedder_model_id !== undefined
        ? { embedderModelId: String(row.embedder_model_id) }
        : {}),
    };
  }

  async setMeta(meta: StoreMeta): Promise<void> {
    const statsJson = meta.stats ? JSON.stringify(meta.stats) : null;
    // UPSERT a single row keyed by id=1 (SQLite ON CONFLICT DO UPDATE).
    this.conn()
      .prepare(
        `INSERT INTO store_meta (
          id, schema_version, last_commit, indexed_at, node_count, edge_count,
          stats_json, cache_hit_ratio, cache_size_bytes, last_compaction, embedder_model_id
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          schema_version = excluded.schema_version,
          last_commit = excluded.last_commit,
          indexed_at = excluded.indexed_at,
          node_count = excluded.node_count,
          edge_count = excluded.edge_count,
          stats_json = excluded.stats_json,
          cache_hit_ratio = excluded.cache_hit_ratio,
          cache_size_bytes = excluded.cache_size_bytes,
          last_compaction = excluded.last_compaction,
          embedder_model_id = excluded.embedder_model_id`,
      )
      .run(
        meta.schemaVersion,
        meta.lastCommit ?? null,
        meta.indexedAt,
        meta.nodeCount,
        meta.edgeCount,
        statsJson,
        meta.cacheHitRatio ?? null,
        meta.cacheSizeBytes ?? null,
        meta.lastCompaction ?? null,
        meta.embedderModelId ?? null,
      );
  }

  // ── ITemporalStore: read-only SQL escape hatch ───────────────────────────────

  async exec(
    sql: string,
    params: readonly SqlParam[] = [],
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    // (1) Guard FIRST, before touching the connection — throws SqlGuardError.
    assertReadOnlySql(sql);
    void opts; // timeout is best-effort via PRAGMA busy_timeout (set at open);
    // node:sqlite has no per-statement interrupt, so opts.timeoutMs cannot be
    // hard-enforced here. Kept on the signature for interface compatibility.
    const stmt = this.conn().prepare(sql);
    // (2) Bind positional params 1..N, coercing undefined → null.
    const bound = params.map((p) => (p ?? null) as SqliteParam);
    const rows = stmt.all(...bound) as unknown as Record<string, unknown>[];
    return rows;
  }

  // ── ITemporalStore: cochanges ────────────────────────────────────────────────

  async bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void> {
    const db = this.conn();
    db.exec("BEGIN");
    try {
      // REPLACE semantics: clear the whole table even on empty input.
      db.exec("DELETE FROM cochanges");
      if (rows.length === 0) {
        db.exec("COMMIT");
        return;
      }
      // Sort by (sourceFile, targetFile) for deterministic insert order.
      const sorted = [...rows].sort((a, b) => {
        if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
        return a.targetFile < b.targetFile ? -1 : a.targetFile > b.targetFile ? 1 : 0;
      });
      const stmt = db.prepare(
        `INSERT INTO cochanges (
          source_file, target_file, cocommit_count,
          total_commits_source, total_commits_target,
          last_cocommit_at, lift
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of sorted) {
        stmt.run(
          r.sourceFile,
          r.targetFile,
          r.cocommitCount,
          r.totalCommitsSource,
          r.totalCommitsTarget,
          r.lastCocommitAt,
          r.lift,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async lookupCochangesForFile(
    file: string,
    opts: CochangeLookupOptions = {},
  ): Promise<readonly CochangeRow[]> {
    const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_COCHANGE_LOOKUP_LIMIT));
    const minLift = opts.minLift ?? DEFAULT_COCHANGE_MIN_LIFT;
    // Probe BOTH directions (signal is symmetric); ORDER BY lift DESC then
    // pair key ASC; LIMIT max(0, floor(limit)).
    const rows = this.conn()
      .prepare(
        `SELECT source_file, target_file, cocommit_count,
                total_commits_source, total_commits_target,
                last_cocommit_at, lift
           FROM cochanges
          WHERE (source_file = ? OR target_file = ?) AND lift >= ?
          ORDER BY lift DESC, source_file ASC, target_file ASC
          LIMIT ?`,
      )
      .all(file, file, minLift, limit) as unknown as Record<string, unknown>[];
    return rows.map(cochangeRowFromRecord);
  }

  async lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined> {
    const row = this.conn()
      .prepare(
        `SELECT source_file, target_file, cocommit_count,
                total_commits_source, total_commits_target,
                last_cocommit_at, lift
           FROM cochanges
          WHERE (source_file = ? AND target_file = ?)
             OR (source_file = ? AND target_file = ?)
          LIMIT 1`,
      )
      .get(fileA, fileB, fileB, fileA) as unknown as Record<string, unknown> | undefined;
    return row ? cochangeRowFromRecord(row) : undefined;
  }

  // ── ITemporalStore: symbol summaries ─────────────────────────────────────────

  async bulkLoadSymbolSummaries(rows: readonly SymbolSummaryRow[]): Promise<void> {
    // Empty input → no-op return (NOT a table clear — symbol summaries are
    // upserts, not replace).
    if (rows.length === 0) return;
    const db = this.conn();
    // Sort by (nodeId, contentHash, promptVersion) for insert determinism.
    const sorted = [...rows].sort((a, b) => {
      if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
      if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
      if (a.promptVersion !== b.promptVersion) return a.promptVersion < b.promptVersion ? -1 : 1;
      return 0;
    });
    db.exec("BEGIN");
    try {
      // DELETE+INSERT upsert per composite key (mirrors DuckDb's approach).
      const del = db.prepare(
        "DELETE FROM symbol_summaries WHERE node_id = ? AND content_hash = ? AND prompt_version = ?",
      );
      const ins = db.prepare(
        `INSERT INTO symbol_summaries (
          node_id, content_hash, prompt_version, model_id,
          summary_text, signature_summary, returns_type_summary,
          structured_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of sorted) {
        del.run(r.nodeId, r.contentHash, r.promptVersion);
        ins.run(
          r.nodeId,
          r.contentHash,
          r.promptVersion,
          r.modelId,
          r.summaryText,
          r.signatureSummary ?? null,
          r.returnsTypeSummary ?? null,
          r.structuredJson ?? null,
          r.createdAt,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async lookupSymbolSummary(
    nodeId: string,
    contentHash: string,
    promptVersion: string,
  ): Promise<SymbolSummaryRow | undefined> {
    const row = this.conn()
      .prepare(
        `SELECT node_id, content_hash, prompt_version, model_id,
                summary_text, signature_summary, returns_type_summary,
                structured_json, created_at
           FROM symbol_summaries
          WHERE node_id = ? AND content_hash = ? AND prompt_version = ?
          LIMIT 1`,
      )
      .get(nodeId, contentHash, promptVersion) as unknown as Record<string, unknown> | undefined;
    return row ? summaryRowFromRecord(row) : undefined;
  }

  async lookupSymbolSummariesByNode(
    nodeIds: readonly string[],
  ): Promise<readonly SymbolSummaryRow[]> {
    if (nodeIds.length === 0) return [];
    // ORDER BY (node_id, prompt_version, content_hash) — prompt_version
    // BEFORE content_hash (differs from the bulkLoad sort) so callers pick
    // the newest prompt deterministically.
    const sql = `SELECT node_id, content_hash, prompt_version, model_id,
              summary_text, signature_summary, returns_type_summary,
              structured_json, created_at
         FROM symbol_summaries
        WHERE node_id IN (${placeholders(nodeIds.length)})
        ORDER BY node_id ASC, prompt_version ASC, content_hash ASC`;
    const rows = this.conn()
      .prepare(sql)
      .all(...(nodeIds as unknown as SqliteParam[])) as unknown as Record<string, unknown>[];
    return rows.map(summaryRowFromRecord);
  }

  async countSymbolSummaries(): Promise<number> {
    // MUST catch all errors and return 0 — codehub status degrades gracefully.
    try {
      const row = this.conn()
        .prepare("SELECT COUNT(DISTINCT node_id) AS n FROM symbol_summaries")
        .get() as unknown as { n: number | bigint } | undefined;
      const n = row?.n;
      return typeof n === "bigint" ? Number(n) : typeof n === "number" ? n : 0;
    } catch {
      return 0;
    }
  }

  private conn(): DatabaseSync {
    if (!this.db) throw new Error("SqliteStore: open() not called");
    return this.db;
  }
}

// ── Row shapes + (de)serialization helpers ──────────────────────────────────────

/** Positional params node:sqlite's StatementSync accepts. */
type SqliteParam = string | number | bigint | null | Uint8Array;

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  payload: string | null;
}

interface EdgeRow {
  id: string;
  src: string;
  dst: string;
  type: string;
  confidence: number;
  step: number | null;
  reason: string | null;
}

interface EmbRow {
  node_id: string;
  granularity: string;
  chunk_index: number;
  start_line: number | null;
  end_line: number | null;
  vector: Uint8Array;
  content_hash: string;
}

interface MetaRow {
  id: number;
  schema_version: string;
  last_commit: string | null;
  indexed_at: string;
  node_count: number;
  edge_count: number;
  stats_json: string | null;
  cache_hit_ratio: number | null;
  cache_size_bytes: number | null;
  last_compaction: string | null;
  embedder_model_id: string | null;
}

function rehydrateNode(row: NodeRow): GraphNode {
  const base: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    name: row.name,
  };
  if (row.file_path != null) base["filePath"] = row.file_path;
  if (row.start_line != null) base["startLine"] = row.start_line;
  if (row.end_line != null) base["endLine"] = row.end_line;
  // The payload round-trips the full remaining field set verbatim — including
  // `keywords: []`, `languageStats: {}`, and Repo nullable `null`s — so
  // canonicalJson sees the identical shape on rebuild (graphHash parity).
  if (row.payload) Object.assign(base, JSON.parse(row.payload));
  return base as unknown as GraphNode;
}

/** Convert a SQLite cochanges row back into a {@link CochangeRow}. */
function cochangeRowFromRecord(row: Record<string, unknown>): CochangeRow {
  // last_cocommit_at is stored as a TEXT ISO string → trivial string decode.
  return {
    sourceFile: String(row["source_file"] ?? ""),
    targetFile: String(row["target_file"] ?? ""),
    cocommitCount: Number(row["cocommit_count"] ?? 0),
    totalCommitsSource: Number(row["total_commits_source"] ?? 0),
    totalCommitsTarget: Number(row["total_commits_target"] ?? 0),
    lastCocommitAt: String(row["last_cocommit_at"] ?? ""),
    lift: Number(row["lift"] ?? 0),
  };
}

/** Convert a SQLite symbol_summaries row back into a {@link SymbolSummaryRow}. */
function summaryRowFromRecord(row: Record<string, unknown>): SymbolSummaryRow {
  const sig = row["signature_summary"];
  const ret = row["returns_type_summary"];
  const structured = row["structured_json"];
  return {
    nodeId: String(row["node_id"] ?? ""),
    contentHash: String(row["content_hash"] ?? ""),
    promptVersion: String(row["prompt_version"] ?? ""),
    modelId: String(row["model_id"] ?? ""),
    summaryText: String(row["summary_text"] ?? ""),
    ...(sig !== null && sig !== undefined ? { signatureSummary: String(sig) } : {}),
    ...(ret !== null && ret !== undefined ? { returnsTypeSummary: String(ret) } : {}),
    ...(structured !== null && structured !== undefined
      ? { structuredJson: String(structured) }
      : {}),
    createdAt: String(row["created_at"] ?? ""),
  };
}

/**
 * Clamp a number to a non-negative integer. Semantics match
 * `clampNonNegativeIntGd` (graphdb-adapter.ts:2202-2207): `undefined` / `null`
 * / negative / non-finite → `undefined` (no clause); `0` preserved; else
 * `Math.floor`.
 */
function clampNonNegativeInt(v: number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (v < 0) return undefined;
  return Math.floor(v);
}

/** Build a `?,?,…` placeholder list of length `n`. */
function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

/** Build a ` WHERE a AND b …` clause, or `""` when there are no predicates. */
function whereClause(wheres: readonly string[]): string {
  return wheres.length > 0 ? ` WHERE ${wheres.join(" AND ")}` : "";
}

/**
 * Build a ` LIMIT n OFFSET m` clause. `limit`/`offset` are pre-clamped to
 * finite non-negative integers (no injection risk). SQLite requires LIMIT
 * before OFFSET, and an OFFSET with no LIMIT needs a `LIMIT -1` sentinel.
 */
function pageClause(limit: number | undefined, offset: number | undefined): string {
  let out = "";
  if (limit !== undefined) out += ` LIMIT ${limit}`;
  else if (offset !== undefined) out += " LIMIT -1";
  if (offset !== undefined) out += ` OFFSET ${offset}`;
  return out;
}

/** Lex-stable JS-side `id ASC` tiebreak — the cross-adapter determinism guarantee. */
function sortById<T extends { id: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Float32Array → little-endian BLOB. node:sqlite accepts Uint8Array for BLOB. */
function f32ToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** BLOB → Float32Array. Copies so the view is independent of the row buffer. */
function blobToF32(b: Uint8Array): Float32Array {
  const copy = b.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
