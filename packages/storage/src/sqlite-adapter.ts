/**
 * SqliteStore — single-file storage spike (branch `spike/sqlite-single-file`).
 *
 * THESIS. One `*.sqlite` file in WAL mode backs EVERYTHING: graph nodes,
 * edges, embeddings, and the temporal/non-graph tables (cochanges, symbol
 * summaries, findings) that today live in two native-binding engines
 * (`graph.lbug` via @ladybugdb/core + `temporal.duckdb` via @duckdb/node-api).
 * Collapsing both onto Node 24's built-in `node:sqlite` removes the last two
 * native dependencies, which is what unlocks the real goal: a zero-dep,
 * one-command, no-Docker install (`npm i -g @opencodehub/cli` and nothing else).
 *
 * SCOPE OF THE SPIKE. This is a representative-slice proof, not the full
 * adapter. It implements the load-bearing, riskiest methods of `IGraphStore`
 * and `ITemporalStore` end-to-end against one file so we can answer the only
 * questions that matter before committing the migration:
 *   1. Does `node:sqlite` actually exist + work on our Node baseline? (yes — 24.17)
 *   2. Can WAL coexist with the read-heavy query path? (yes — set at open)
 *   3. Can embeddings (Float32Array) round-trip through a BLOB with no precision
 *      loss and be ranked by cosine similarity fast enough in JS? (yes — proven)
 *   4. Can graph traversal (impact / blast-radius) run as a recursive CTE
 *      instead of LadybugDB Cypher? (yes — proven, bounded by maxDepth)
 *   5. Can one connection own graph + temporal tables without the two-file,
 *      two-adapter, deterministic-close dance? (yes — single `close()`)
 *
 * WHAT IS DELIBERATELY STUBBED. The 37-kind node union is encoded generically
 * (typed columns for the common base + a `payload` JSON overflow) rather than
 * 37 per-kind tables — that is itself the design proposal, see WORKFLOW.md.
 * Full kind-rehydration, the `--sql` guard, Parquet export, and the complete
 * finder surface are out of scope for the spike and throw `NotImplementedError`
 * with a pointer. The full rollout is phased in WORKFLOW.md.
 *
 * NON-GOAL. No backwards compatibility. Clean slate: this adapter assumes a
 * fresh index, not a migration of existing `graph.lbug` / `temporal.duckdb`
 * artifacts (per the spike brief).
 */

// Install the experimental-warning guard BEFORE the node:sqlite binding loads.
import "./sqlite-runtime.js";

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { GraphNode, KnowledgeGraph, NodeId } from "@opencodehub/core-types";

import { NotImplementedError } from "./graphdb-adapter.js";
import type {
  BulkLoadOptions,
  BulkLoadStats,
  EmbeddingRow,
  ListEmbeddingsOptions,
  ListNodesOptions,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "./interface.js";

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
}

const DEFAULT_DIM = 768;
const SCHEMA_VERSION = "spike-sqlite-1";

/**
 * Single-file store implementing the representative slice of IGraphStore +
 * ITemporalStore. Lifecycle mirrors the existing adapters:
 *   open → createSchema → bulkLoad → query/search/vectorSearch/traverse → close
 */
export class SqliteStore {
  private db: DatabaseSync | undefined;
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly dim: number;
  private readonly journalMode: "WAL" | "MEMORY" | "DELETE";

  constructor(path: string, opts: SqliteStoreOptions = {}) {
    this.path = path;
    this.readOnly = opts.readOnly ?? false;
    this.dim = opts.embeddingDim ?? DEFAULT_DIM;
    this.journalMode = opts.journalMode ?? (path === ":memory:" ? "MEMORY" : "WAL");
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.db) return; // idempotent
    this.db = new DatabaseSync(this.path, { readOnly: this.readOnly });
    // WAL is the headline: concurrent readers never block the writer, the file
    // is crash-safe, and there is no server process. A read-only handle cannot
    // change journal mode, so only set it on a writable open.
    if (!this.readOnly) {
      this.db.exec(`PRAGMA journal_mode = ${this.journalMode};`);
      this.db.exec("PRAGMA synchronous = NORMAL;"); // WAL-safe, fast
      this.db.exec("PRAGMA foreign_keys = ON;");
    }
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
    // for 37 node kinds, not 37 tables. Rehydration reads payload back.
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
    // ── Temporal / non-graph tier — same file, no second engine ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS cochanges (
        file_a TEXT NOT NULL, file_b TEXT NOT NULL,
        support INTEGER NOT NULL, lift REAL NOT NULL,
        PRIMARY KEY (file_a, file_b)
      );
      CREATE TABLE IF NOT EXISTS symbol_summaries (
        node_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL, summary TEXT NOT NULL,
        PRIMARY KEY (node_id, content_hash, prompt_version)
      );
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY, v TEXT NOT NULL
      );
    `);
  }

  // ── Bulk load (graph write path) ────────────────────────────────────────────

  async bulkLoad(graph: KnowledgeGraph, _opts?: BulkLoadOptions): Promise<BulkLoadStats> {
    const db = this.conn();
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
    // One transaction for the whole load — WAL turns this into a single fsync.
    db.exec("BEGIN");
    try {
      for (const n of nodes) this.writeNode(insNode, n);
      for (const e of edges) {
        insEdge.run(
          e.id,
          e.from,
          e.to,
          e.type,
          e.confidence,
          e.step ?? null,
          e.reason ?? null,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    this.setMeta({ nodeCount: nodes.length, edgeCount: edges.length });
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      durationMs: 0, // spike: not timed; real adapter measures the txn
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

  async listNodes(opts?: ListNodesOptions): Promise<readonly GraphNode[]> {
    const limit = opts?.limit ?? 1_000_000;
    const rows = this.conn()
      .prepare("SELECT * FROM nodes ORDER BY id ASC LIMIT ?")
      .all(limit) as unknown as NodeRow[];
    return rows.map(rehydrateNode);
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

  async *listEmbeddings(opts?: ListEmbeddingsOptions): AsyncIterable<EmbeddingRow> {
    const limit = opts?.limit ?? 1_000_000;
    const rows = this.conn()
      .prepare(
        `SELECT node_id,granularity,chunk_index,start_line,end_line,vector,content_hash
         FROM embeddings ORDER BY node_id ASC, granularity ASC, chunk_index ASC LIMIT ?`,
      )
      .all(limit) as unknown as EmbRow[];
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
      throw new Error(
        `Vector dimension mismatch: got ${q.vector.length}, expected ${this.dim}`,
      );
    }
    const limit = q.limit ?? 10;
    const query = q.vector;
    const rows = this.conn()
      .prepare("SELECT node_id, vector FROM embeddings")
      .all() as unknown as { node_id: string; vector: Uint8Array }[];
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
    if (q.maxDepth === 0) return [];
    const minConf = q.minConfidence ?? 0;
    // direction "both" walks edges either way; "up"/"down" pick one column pair.
    const downStep = "SELECT edges.dst, reach.depth + 1, reach.path || ',' || edges.dst " +
      "FROM edges JOIN reach ON edges.src = reach.node_id " +
      `WHERE reach.depth < ? AND edges.confidence >= ${minConf} AND instr(reach.path, edges.dst) = 0`;
    const upStep = "SELECT edges.src, reach.depth + 1, reach.path || ',' || edges.src " +
      "FROM edges JOIN reach ON edges.dst = reach.node_id " +
      `WHERE reach.depth < ? AND edges.confidence >= ${minConf} AND instr(reach.path, edges.src) = 0`;
    let recursive: string;
    let depthParams: number[];
    if (q.direction === "down") {
      recursive = downStep;
      depthParams = [q.maxDepth];
    } else if (q.direction === "up") {
      recursive = upStep;
      depthParams = [q.maxDepth];
    } else {
      recursive = `${downStep} UNION ${upStep}`;
      depthParams = [q.maxDepth, q.maxDepth];
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
    const rows = this.conn()
      .prepare(sql)
      .all(String(q.startId), String(q.startId), ...depthParams, String(q.startId)) as unknown as {
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

  // ── Meta ─────────────────────────────────────────────────────────────────────

  async getMeta(): Promise<StoreMeta | undefined> {
    const row = this.conn().prepare("SELECT v FROM meta WHERE k='store'").get() as
      | { v: string }
      | undefined;
    return row ? (JSON.parse(row.v) as StoreMeta) : undefined;
  }

  private setMeta(partial: { nodeCount: number; edgeCount: number }): void {
    const meta: StoreMeta = {
      schemaVersion: SCHEMA_VERSION,
      indexedAt: "spike", // deterministic placeholder; real adapter stamps ISO time
      nodeCount: partial.nodeCount,
      edgeCount: partial.edgeCount,
    };
    this.conn()
      .prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('store', ?)")
      .run(JSON.stringify(meta));
  }

  // ── Out-of-spike-scope surface (documented, not faked) ───────────────────────

  exec(): never {
    throw new NotImplementedError(
      "SqliteStore.exec (--sql escape hatch) is out of spike scope; see WORKFLOW.md Phase 3",
    );
  }
  exportEmbeddingsToParquet(): never {
    throw new NotImplementedError(
      "Parquet sidecar export is out of spike scope; node:sqlite has no COPY-to-Parquet — " +
        "WORKFLOW.md Phase 4 decides keep-duckdb-for-export vs write-parquet-in-JS",
    );
  }

  private conn(): DatabaseSync {
    if (!this.db) throw new Error("SqliteStore: open() not called");
    return this.db;
  }
}

// ── Row shapes + (de)serialization helpers ──────────────────────────────────────

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  payload: string | null;
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

function rehydrateNode(row: NodeRow): GraphNode {
  const base: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    name: row.name,
  };
  if (row.file_path != null) base["filePath"] = row.file_path;
  if (row.start_line != null) base["startLine"] = row.start_line;
  if (row.end_line != null) base["endLine"] = row.end_line;
  if (row.payload) Object.assign(base, JSON.parse(row.payload));
  return base as unknown as GraphNode;
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
