/**
 * Graph-database backend for {@link IGraphStore} (phase-2 implementation).
 *
 * This adapter is the second implementation behind the `IGraphStore` seam.
 * DuckDbStore remains the default through M7; this file ships the full
 * lifecycle + bulk-load surface so `CODEHUB_STORE=lbug` can already drive a
 * round-trip-clean graph write. Query, search, vector, and embedding
 * surfaces follow in AC-M3-3 sibling commits.
 *
 * Design notes (spec 004 §Architectural decisions):
 *   1. Rel tables are polymorphic per edge kind — one named rel table per
 *      relation type, each with multiple `FROM/TO` pairs. The DDL lives in
 *      {@link graphdb-schema.ts}; this file never emits DDL inline.
 *   2. Source-level naming avoids the banned clean-room literals. The class
 *      is {@link GraphDbStore}; files are `graphdb-*.ts`. The native binding
 *      package `@ladybugdb/core` is a dep, not a source-level identifier.
 *   3. Every mutating path uses parameterized Cypher via the pool — no
 *      string-concatenated values ever touch the connection.
 *
 * Lifecycle mirrors {@link DuckDbStore}: open → createSchema → bulkLoad →
 * query / search / vectorSearch / traverse → close.
 */

import type { GraphNode, KnowledgeGraph, NodeId, RelationType } from "@opencodehub/core-types";
import { canonicalJson } from "@opencodehub/core-types";
import { assertReadOnlyCypher } from "./cypher-guard.js";
import { GraphDbPool, type GraphDbPoolConfig } from "./graphdb-pool.js";
import { generateSchemaDdl, getAllRelationTypes } from "./graphdb-schema.js";
import type {
  BulkLoadOptions,
  BulkLoadStats,
  CochangeLookupOptions,
  CochangeRow,
  EmbeddingRow,
  IGraphStore,
  ListNodesOptions,
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
 * Thrown by every method that has not been wired yet. Remaining stubs are
 * in the query / search / embedding / cochange / summary surfaces —
 * sibling commits of AC-M3-3 and AC-M3-4 replace them.
 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`graph-db: ${method} not yet wired (AC-M3-3/4)`);
    this.name = "NotImplementedError";
  }
}

/**
 * Missing peer-binding error. Surfaced when the native `@ladybugdb/core`
 * module is not available on the current platform (no prebuilt binary, or
 * the package was pruned by a `--production` install). The message
 * satisfies spec 004 §S-M3-2.
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

// ---------------------------------------------------------------------------
// Column layouts — kept in lock-step with graphdb-schema.ts CREATE NODE TABLE
// CodeNode body. Adding a column means: (1) extend the schema DDL,
// (2) append it to NODE_COLUMNS, (3) append the reader in nodeToParams,
// (4) append the column → field mapping in ROUND_TRIP_COLUMN_MAP. Order
// matters because both directions are index-aligned with the prepared
// statement parameter list.
// ---------------------------------------------------------------------------

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
  "severity",
  "rule_id",
  "scanner_id",
  "message",
  "properties_bag",
  "version",
  "license",
  "lockfile_source",
  "ecosystem",
  "http_method",
  "http_path",
  "summary",
  "operation_id",
  "email_hash",
  "email_plain",
  "languages_json",
  "frameworks_json",
  "iac_types_json",
  "api_contracts_json",
  "manifests_json",
  "src_dirs_json",
  "orphan_grade",
  "is_orphan",
  "truck_factor",
  "ownership_drift_30d",
  "ownership_drift_90d",
  "ownership_drift_365d",
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
  // Repo (AC-M6-1). Append-only so existing parameter slots stay stable.
  "origin_url",
  "repo_uri",
  "default_branch",
  "commit_sha",
  "index_time",
  "repo_group",
  "visibility",
  "indexer",
  "language_stats_json",
];

/** Edge rel-table property columns. Matches graphdb-schema.ts. */
const EDGE_COLUMNS: readonly string[] = ["id", "confidence", "reason", "step"];

/**
 * Column layout for the `Embedding` node table. Matches graphdb-schema.ts.
 * `vector` is a FLOAT[dim] fixed-size array column; everything else is
 * bound as a plain scalar.
 */
const EMBEDDING_COLUMNS: readonly string[] = [
  "id",
  "node_id",
  "granularity",
  "chunk_index",
  "start_line",
  "end_line",
  "vector",
  "content_hash",
];

/**
 * Column → node-field descriptors used by the round-trip readback path.
 * AC-M3-3 Commit 4's `rebuildGraphFromStore` walks this list so the
 * returned graph carries the same field set the bulk writer ingested.
 */
export const ROUND_TRIP_COLUMN_MAP: readonly (readonly [
  string,
  string,
  "string" | "number" | "boolean" | "string[]",
])[] = [
  ["start_line", "startLine", "number"],
  ["end_line", "endLine", "number"],
  ["is_exported", "isExported", "boolean"],
  ["signature", "signature", "string"],
  ["parameter_count", "parameterCount", "number"],
  ["return_type", "returnType", "string"],
  ["declared_type", "declaredType", "string"],
  ["owner", "owner", "string"],
  ["content_hash", "contentHash", "string"],
];

// ---------------------------------------------------------------------------
// Cypher template builders — amortising the string work across a full bulk
// load. Closed over NODE_COLUMNS/EDGE_COLUMNS so any column rename is
// caught at compile time.
// ---------------------------------------------------------------------------

function buildNodeCreateCypher(): string {
  const propPairs = NODE_COLUMNS.map((col, i) => `${col}: $p${i + 1}`).join(", ");
  return `CREATE (n:CodeNode {${propPairs}})`;
}

function buildNodeMergeCypher(): string {
  // MERGE by primary key; SET every non-id field on both the create and
  // match branches so the row's state is always the caller's newest view.
  const setClauses = NODE_COLUMNS.slice(1)
    .map((col, i) => `n.${col} = $p${i + 2}`)
    .join(", ");
  return `MERGE (n:CodeNode {id: $p1}) SET ${setClauses}`;
}

function buildEdgeCreateCypher(kind: string): string {
  // p1 = from id, p2 = to id, p3..p6 = EDGE_COLUMNS.
  const propPairs = EDGE_COLUMNS.map((col, i) => `${col}: $p${i + 3}`).join(", ");
  return `MATCH (a:CodeNode {id: $p1}), (b:CodeNode {id: $p2}) CREATE (a)-[:${kind} {${propPairs}}]->(b)`;
}

function buildEdgeMergeCypher(kind: string): string {
  // Pattern-match then SET. Matching by endpoints + label collapses duplicate
  // edges that share (from, to, type); a second edge with the same triple
  // updates the same rel's properties rather than adding a parallel edge.
  const setClauses = EDGE_COLUMNS.map((col, i) => `r.${col} = $p${i + 3}`).join(", ");
  return (
    `MATCH (a:CodeNode {id: $p1}), (b:CodeNode {id: $p2}) ` +
    `MERGE (a)-[r:${kind}]->(b) SET ${setClauses}`
  );
}

function buildEmbeddingCreateCypher(): string {
  const propPairs = EMBEDDING_COLUMNS.map((col, i) => `${col}: $p${i + 1}`).join(", ");
  return `CREATE (e:Embedding {${propPairs}})`;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class GraphDbStore implements IGraphStore {
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly embeddingDim: number;
  private readonly defaultTimeoutMs: number;
  private readonly poolConfig: GraphDbPoolConfig;
  private pool: GraphDbPool | null = null;
  private ftsExtensionLoaded = false;
  private vectorExtensionLoaded = false;
  private ftsIndexBuilt = false;
  private vectorIndexBuilt = false;

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
    // Clear lazy-init latches so a subsequent open() re-probes the
    // extensions against the freshly opened database.
    this.ftsExtensionLoaded = false;
    this.vectorExtensionLoaded = false;
    this.ftsIndexBuilt = false;
    this.vectorIndexBuilt = false;
    await pool.close();
  }

  async createSchema(): Promise<void> {
    const pool = this.requirePool();
    const ddl = generateSchemaDdl({ embeddingDim: this.embeddingDim });
    // Split on semicolons (each statement was emitted with a trailing `;\n`).
    // Firing statements independently keeps error messages tied to the exact
    // CREATE that failed rather than a concatenated batch.
    const stmts = ddl
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of stmts) {
      await pool.query(stmt);
    }
  }

  // --------------------------------------------------------------------------
  // Bulk load
  // --------------------------------------------------------------------------

  async bulkLoad(graph: KnowledgeGraph, opts: BulkLoadOptions = {}): Promise<BulkLoadStats> {
    const pool = this.requirePool();
    const started = performance.now();
    const mode = opts.mode ?? "replace";

    if (mode === "replace") {
      await this.truncateAll();
    }

    const nodes = dedupeLastById(graph.orderedNodes(), (n) => n.id);
    await this.insertNodes(pool, nodes, mode);

    // Group edges by relation type so we build one Cypher template per kind
    // and iterate its bucket with a single parameter set. The native binding
    // does not let us parameterize the rel label, so each kind needs its own
    // template.
    const edges = dedupeLastById(graph.orderedEdges(), (e) => e.id);
    const byKind = new Map<RelationType, EdgeRow[]>();
    for (const e of edges) {
      const bucket = byKind.get(e.type) ?? [];
      // `exactOptionalPropertyTypes` rejects explicit `undefined` on an
      // optional property — spread the narrow fields then conditionally
      // attach `reason`/`step` only when they carry a real value.
      const row: EdgeRow = {
        id: e.id,
        from: e.from,
        to: e.to,
        type: e.type,
        confidence: e.confidence,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
        ...(e.step !== undefined ? { step: e.step } : {}),
      };
      bucket.push(row);
      byKind.set(e.type, bucket);
    }
    for (const [kind, bucket] of byKind) {
      await this.insertEdgesForKind(pool, kind, bucket, mode);
    }

    const durationMs = performance.now() - started;
    return {
      nodeCount: graph.nodeCount(),
      edgeCount: graph.edgeCount(),
      durationMs,
    };
  }

  private async truncateAll(): Promise<void> {
    const pool = this.requirePool();
    // Delete edges first so node deletes stay side-effect free. The graph-db
    // engine rejects deletes of a node that still has dangling rels.
    for (const kind of getAllRelationTypes()) {
      await pool.query(`MATCH ()-[r:${kind}]->() DELETE r`);
    }
    await pool.query("MATCH ()-[r:EMBEDS]->() DELETE r");
    await pool.query("MATCH (n:Embedding) DELETE n");
    await pool.query("MATCH (n:CodeNode) DELETE n");
  }

  private async insertNodes(
    pool: GraphDbPool,
    nodes: readonly GraphNode[],
    mode: "replace" | "upsert",
  ): Promise<void> {
    if (nodes.length === 0) return;
    const cypher = mode === "upsert" ? buildNodeMergeCypher() : buildNodeCreateCypher();
    for (const node of nodes) {
      const params = nodeToParams(node);
      await pool.query(cypher, params);
    }
  }

  private async insertEdgesForKind(
    pool: GraphDbPool,
    kind: string,
    edges: readonly EdgeRow[],
    mode: "replace" | "upsert",
  ): Promise<void> {
    if (edges.length === 0) return;
    const cypher = mode === "upsert" ? buildEdgeMergeCypher(kind) : buildEdgeCreateCypher(kind);
    for (const e of edges) {
      // `step` is preserved as NULL when the source edge omits it so the
      // round-trip reader can distinguish "intentionally absent" from
      // "explicit zero". DuckDbStore stores 0 in both cases because the
      // column is NOT NULL; the graph-db schema declares it as nullable
      // INT32 and the canonical-JSON hash stays stable across backends as
      // long as both adapters agree on the sentinel (AC-M3-4 gate).
      const params: SqlParam[] = [
        e.from,
        e.to,
        e.id,
        e.confidence,
        e.reason ?? null,
        e.step ?? null,
      ];
      await pool.query(cypher, params);
    }
  }

  // --------------------------------------------------------------------------
  // Embeddings
  // --------------------------------------------------------------------------

  async upsertEmbeddings(rows: readonly EmbeddingRow[]): Promise<void> {
    if (rows.length === 0) return;
    const pool = this.requirePool();
    const dim = this.embeddingDim;

    // Delete any existing rows that match (node_id, granularity,
    // chunk_index). Mirrors duckdb-adapter.ts — MERGE on Embedding would
    // work but the composite key is not the primary key, so the safest
    // pattern is delete-then-create. DETACH DELETE because the prior row
    // may have an EMBEDS rel attached, and the native engine refuses a
    // bare DELETE on a node with dangling rels.
    const delCypher =
      `MATCH (e:Embedding) WHERE e.node_id = $p1 AND e.granularity = $p2 ` +
      `AND e.chunk_index = $p3 DETACH DELETE e`;
    for (const r of rows) {
      const granularity = r.granularity ?? "symbol";
      await pool.query(delCypher, [r.nodeId, granularity, r.chunkIndex]);
    }

    // Create one Embedding node per row + an EMBEDS rel linking it back
    // to its source CodeNode (so the vectorSearch post-filter can join
    // back through the graph without an extra property lookup).
    const createCypher = buildEmbeddingCreateCypher();
    const embedsCypher = `MATCH (e:Embedding {id: $p1}), (n:CodeNode {id: $p2}) CREATE (e)-[:EMBEDS]->(n)`;
    for (const r of rows) {
      if (r.vector.length !== dim) {
        throw new Error(`Embedding dimension mismatch: got ${r.vector.length}, expected ${dim}`);
      }
      const granularity = r.granularity ?? "symbol";
      const embeddingId = `Emb:${granularity}:${r.nodeId}:${r.chunkIndex}`;
      // The native binding does not accept Float32Array directly for a
      // FLOAT[dim] column; Array.from converts once per row and keeps the
      // serialized shape a plain number[]. The cast to `SqlParam` is a structural
      // narrowing — the pool forwards arbitrary JS values to the native
      // binding, which accepts arrays for fixed-dim float columns.
      const vector = Array.from(r.vector) as unknown as SqlParam;
      const params: readonly SqlParam[] = [
        embeddingId,
        r.nodeId,
        granularity,
        r.chunkIndex,
        r.startLine ?? null,
        r.endLine ?? null,
        vector,
        r.contentHash,
      ];
      await pool.query(createCypher, params);
      // Best-effort EMBEDS rel. Missing CodeNode is not a hard error —
      // this mirrors the DuckDB embeddings table (which doesn't require a
      // join target) but still gives the graph traversal tools a hook.
      try {
        await pool.query(embedsCypher, [embeddingId, r.nodeId]);
      } catch {
        // Node not yet loaded; the traversal side will treat the embedding
        // as orphaned. Round-trip cases always bulkLoad before upserting,
        // so this only fires when callers write embeddings for nodes that
        // have been purged by a prior replace.
      }
    }
  }

  async listEmbeddingHashes(): Promise<Map<string, string>> {
    const pool = this.requirePool();
    const rows = await pool.query(
      `MATCH (e:Embedding) RETURN e.node_id AS node_id, e.granularity AS granularity, ` +
        `e.chunk_index AS chunk_index, e.content_hash AS content_hash`,
    );
    const out = new Map<string, string>();
    for (const row of rows) {
      const rec = row as Record<string, unknown>;
      const nodeId = rec["node_id"];
      const granularity = rec["granularity"];
      const chunkIndex = rec["chunk_index"];
      const contentHash = rec["content_hash"];
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
    // Refuse write keywords so the user surface stays read-only. A full
    // Cypher-guard lands in AC-M3-5; this minimal deny-list matches the
    // DuckDB backend's assertReadOnlySql approach and trips every write
    // verb the native binding accepts.
    assertReadOnlyCypher(sql);
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return this.pool.query(sql, params, { timeoutMs });
  }

  /**
   * Enumerate fully-rehydrated GraphNodes by kind. Mirror of the
   * DuckStore implementation — same input/output contract so the M5 BOM
   * bodies render identical results regardless of which backend the user
   * picked.
   *
   * The graph-db schema stores every kind under the single label
   * `:CodeNode` with `kind` as a discriminator property (see
   * graphdb-schema.ts). One MATCH plus an optional `WHERE n.kind IN [...]`
   * predicate is therefore sufficient — no per-kind table fan-out.
   *
   * Determinism: ORDER BY n.id ASC at the Cypher layer, plus a JS-side
   * lex-stable tiebreak on the rehydrated nodes so the output matches
   * DuckStore byte-for-byte.
   */
  async listNodes(opts: ListNodesOptions = {}): Promise<readonly GraphNode[]> {
    const kinds = opts.kinds;
    // Empty-kinds short-circuit BEFORE the pool guard — the contract is
    // pure-JS ("kinds: [] returns []") and must hold even when the store
    // has not been opened yet. Saves callers a defensive .open() when
    // they know the kinds list is empty.
    if (kinds !== undefined && kinds.length === 0) return [];
    const pool = this.requirePool();
    const limit = clampNonNegativeIntGd(opts.limit);
    const offset = clampNonNegativeIntGd(opts.offset);

    // RETURN every column the writer emits. Each column → field mapping
    // mirrors `nodeToParams` exactly so the round-trip is symmetric.
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");

    const params: SqlParam[] = [];
    let kindPredicate = "";
    if (kinds && kinds.length > 0) {
      const phs: string[] = [];
      for (let i = 0; i < kinds.length; i += 1) {
        phs.push(`$p${i + 1}`);
        params.push(kinds[i] ?? "");
      }
      kindPredicate = `WHERE n.kind IN [${phs.join(", ")}] `;
    }
    // SKIP / LIMIT bound via inline literals after the clampNonNegativeInt
    // guard has confirmed they are finite non-negative integers — no
    // injection risk because `Number.isFinite` + `Math.floor` enforce a
    // strict integer encoding before we interpolate.
    let pagination = "";
    if (offset !== undefined) pagination += `SKIP ${offset} `;
    if (limit !== undefined) pagination += `LIMIT ${limit} `;

    const cypher = (
      `MATCH (n:CodeNode) ${kindPredicate}` +
      `RETURN ${returnList} ` +
      `ORDER BY n.id ASC ${pagination}`
    ).trim();

    const rows = await pool.query(cypher, params);
    const out: GraphNode[] = [];
    for (const row of rows) {
      const node = recordToGraphNode(row as Record<string, unknown>);
      if (node) out.push(node);
    }
    // Lex-stable tiebreak on id so DuckStore + GraphDbStore agree
    // byte-for-byte when graphHash is computed over the result.
    return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async search(q: SearchQuery): Promise<readonly SearchResult[]> {
    const pool = this.requirePool();
    await this.ensureFtsExtension();
    await this.ensureFtsIndex();
    const limit = q.limit ?? 50;
    const kindFilter = q.kinds && q.kinds.length > 0 ? q.kinds : undefined;

    // $p1 = FTS query text, $p2..$pN+1 = optional kind filter values,
    // $p(limit) = LIMIT. The index maps back to the kind-filter array when
    // present.
    const params: SqlParam[] = [q.text];
    let kindPredicate = "";
    if (kindFilter) {
      const phs = kindFilter.map((_, i) => `$p${i + 2}`).join(", ");
      kindPredicate = ` WHERE node.kind IN [${phs}]`;
      for (const k of kindFilter) params.push(k);
    }
    // Tiebreaker columns mirror DuckDbStore.search — (id, file_path, name)
    // ascending so identical scores yield a stable order across runs.
    const cypher =
      `CALL QUERY_FTS_INDEX('CodeNode', 'och_fts', $p1) ` +
      `WITH node, score${kindPredicate} ` +
      `RETURN node.id AS id, node.name AS name, node.kind AS kind, ` +
      `node.file_path AS file_path, score ` +
      `ORDER BY score DESC, id ASC, file_path ASC, name ASC LIMIT ${Number(limit)}`;
    const rows = await pool.query(cypher, params);
    const out: SearchResult[] = [];
    for (const row of rows) {
      out.push({
        nodeId: String((row as Record<string, unknown>)["id"]),
        name: String((row as Record<string, unknown>)["name"] ?? ""),
        kind: String((row as Record<string, unknown>)["kind"] ?? ""),
        filePath: String((row as Record<string, unknown>)["file_path"] ?? ""),
        score: Number((row as Record<string, unknown>)["score"] ?? 0),
      });
    }
    return out;
  }

  async vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]> {
    // Dimension guard runs before any pool access so it fails fast on
    // misconfigured callers — an 'not open' message would hide the real
    // problem.
    if (q.vector.length !== this.embeddingDim) {
      throw new Error(
        `Vector dimension mismatch: got ${q.vector.length}, expected ${this.embeddingDim}`,
      );
    }
    const pool = this.requirePool();
    await this.ensureVectorExtension();
    await this.ensureVectorIndex();
    const limit = q.limit ?? 10;
    const granularities: readonly string[] | undefined =
      q.granularity === undefined
        ? undefined
        : Array.isArray(q.granularity)
          ? (q.granularity as readonly string[])
          : [q.granularity as string];

    // Over-fetch k so the post-filter WHERE still leaves `limit` rows when
    // some of the top-k are dropped by the predicate. 4x limit (min 32)
    // is the same headroom DuckDbStore uses for its granularity filter.
    const k = Math.max(limit * 4, 32);

    // $p1 = query vector, $p2 = k. Subsequent params are the WHERE clause
    // values (callers pass `?` placeholders, we rewrite to $pN).
    const params: SqlParam[] = [Array.from(q.vector) as unknown as SqlParam, k];
    let nextPh = 3;
    const whereParts: string[] = [];

    if (q.whereClause && q.whereClause.length > 0) {
      const localParams = q.params ?? [];
      const rewritten = rewriteWhereClause(q.whereClause, () => {
        const name = `$p${nextPh}`;
        nextPh += 1;
        return name;
      });
      whereParts.push(`(${rewritten})`);
      for (const p of localParams) params.push(p);
    }
    if (granularities !== undefined && granularities.length > 0) {
      const phs: string[] = [];
      for (const g of granularities) {
        phs.push(`$p${nextPh}`);
        nextPh += 1;
        params.push(g);
      }
      whereParts.push(`e.granularity IN [${phs.join(", ")}]`);
    }

    const wherePredicate = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";

    // CALL QUERY_VECTOR_INDEX returns rows with `node` (the Embedding
    // record) and `distance`. We pull the `e.node_id` column through so
    // callers get the CodeNode id — the join to CodeNode via EMBEDS is
    // only needed when the caller-supplied whereClause references `n.*`.
    const needsJoin = (q.whereClause ?? "").trim().length > 0;
    const joinClause = needsJoin ? `MATCH (e)-[:EMBEDS]->(node:CodeNode) ` : "";
    const cypher =
      `CALL QUERY_VECTOR_INDEX('Embedding', 'och_vec', $p1, $p2) ` +
      `WITH node AS e, distance ` +
      `${joinClause}` +
      `${wherePredicate} ` +
      `RETURN e.node_id AS node_id, distance ORDER BY distance LIMIT ${Number(limit)}`;

    const rows = await pool.query(cypher, params);
    const out: VectorResult[] = [];
    for (const row of rows) {
      const rec = row as Record<string, unknown>;
      out.push({
        nodeId: String(rec["node_id"]),
        distance: Number(rec["distance"] ?? 0),
      });
    }
    return out;
  }

  async traverse(q: TraverseQuery): Promise<readonly TraverseResult[]> {
    const pool = this.requirePool();
    const maxDepth = Math.max(0, Math.floor(q.maxDepth));
    if (maxDepth === 0) return [];
    const minConfidence = q.minConfidence ?? 0;
    const relTypes: readonly string[] =
      q.relationTypes && q.relationTypes.length > 0 ? q.relationTypes : getAllRelationTypes();
    // Variable-length MATCH: `[r:T1|T2*1..N]`. The native engine accepts
    // the pipe-separated label union and the lower..upper bound syntax.
    // Depth is inlined because the native binding rejects a prepared
    // statement whose variable-length bounds are bound via parameters.
    const typeLabels = relTypes.join("|");
    const { head, tail } =
      q.direction === "up"
        ? { head: "<-", tail: "-" }
        : q.direction === "down"
          ? { head: "-", tail: "->" }
          : { head: "-", tail: "-" };

    // NOTE: `[n IN nodes(p) | n.id]` is rejected by the native engine
    // (v0.16.1 `Binder exception: Variable n is not in scope`). Use
    // `list_transform` instead.
    //
    // The native prepared-statement planner asserts `UNREACHABLE_CODE` when
    // a variable-length pattern (`*1..N`) co-exists with ANY bound
    // parameter. Work-around: inline the two inputs this traversal needs
    // (startId and minConfidence), then route through `pool.query()`
    // without a param list so the pool picks the direct-query path. Both
    // values are validated before interpolation — startId is either a
    // UUID-shaped NodeId or a composite identifier from `makeNodeId`, and
    // minConfidence is a finite number — so the inlining cannot smuggle a
    // Cypher fragment.
    const startIdLiteral = cypherStringLiteral(q.startId);
    const confLiteral = cypherNumberLiteral(minConfidence);
    const cypher =
      `MATCH p = (start:CodeNode {id: ${startIdLiteral}})${head}` +
      `[r:${typeLabels}*1..${maxDepth}]${tail}(other:CodeNode) ` +
      `WHERE ALL(x IN rels(p) WHERE x.confidence >= ${confLiteral}) ` +
      `AND other.id <> ${startIdLiteral} ` +
      `RETURN other.id AS node_id, length(p) AS depth, ` +
      `list_transform(nodes(p), x -> x.id) AS path ` +
      `ORDER BY depth, node_id`;

    const rows = await pool.query(cypher);
    const out: TraverseResult[] = [];
    for (const row of rows) {
      const rec = row as Record<string, unknown>;
      const pathVal = rec["path"];
      const path = Array.isArray(pathVal) ? pathVal.map((v) => String(v)) : [];
      out.push({
        nodeId: String(rec["node_id"]),
        depth: Number(rec["depth"] ?? 0),
        path,
      });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Meta + health
  // --------------------------------------------------------------------------

  async getMeta(): Promise<StoreMeta | undefined> {
    const pool = this.requirePool();
    const rows = await pool.query(
      `MATCH (m:StoreMeta {id: 1}) RETURN m.schema_version AS schema_version, ` +
        `m.last_commit AS last_commit, m.indexed_at AS indexed_at, ` +
        `m.node_count AS node_count, m.edge_count AS edge_count, ` +
        `m.stats_json AS stats_json, m.cache_hit_ratio AS cache_hit_ratio, ` +
        `m.cache_size_bytes AS cache_size_bytes, m.last_compaction AS last_compaction ` +
        `LIMIT 1`,
    );
    const first = rows[0];
    if (!first) return undefined;
    const row = first as Record<string, unknown>;
    const statsStr = row["stats_json"];
    const stats =
      typeof statsStr === "string" && statsStr.length > 0
        ? (JSON.parse(statsStr) as Record<string, number>)
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
    const pool = this.requirePool();
    const statsJson = meta.stats ? JSON.stringify(meta.stats) : null;
    // MERGE by id=1 so repeat writes update in place without carrying a
    // separate DELETE pass.
    await pool.query(
      `MERGE (m:StoreMeta {id: 1}) ` +
        `SET m.schema_version = $p1, m.last_commit = $p2, m.indexed_at = $p3, ` +
        `m.node_count = $p4, m.edge_count = $p5, m.stats_json = $p6, ` +
        `m.cache_hit_ratio = $p7, m.cache_size_bytes = $p8, m.last_compaction = $p9`,
      [
        meta.schemaVersion,
        meta.lastCommit ?? null,
        meta.indexedAt,
        meta.nodeCount,
        meta.edgeCount,
        statsJson,
        meta.cacheHitRatio ?? null,
        meta.cacheSizeBytes ?? null,
        meta.lastCompaction ?? null,
      ],
    );
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    if (!this.pool?.isOpen()) {
      return { ok: false, message: "graph-db: pool not open" };
    }
    try {
      await this.pool.query("RETURN 1 AS one");
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // --------------------------------------------------------------------------
  // CochangeStore (deferred to AC-M3-4)
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
  // SymbolSummaryStore (deferred to AC-M3-4)
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
  // Internal helpers
  // --------------------------------------------------------------------------

  private requirePool(): GraphDbPool {
    if (!this.pool?.isOpen()) {
      throw new Error("graph-db: query called before open()");
    }
    return this.pool;
  }

  private async ensureFtsExtension(): Promise<void> {
    if (this.ftsExtensionLoaded) return;
    const pool = this.requirePool();
    try {
      if (!this.readOnly) await pool.query("INSTALL FTS;");
      await pool.query("LOAD EXTENSION FTS;");
      this.ftsExtensionLoaded = true;
    } catch (err) {
      throw new Error(`graph-db: FTS extension unavailable: ${(err as Error).message}`);
    }
  }

  private async ensureVectorExtension(): Promise<void> {
    if (this.vectorExtensionLoaded) return;
    const pool = this.requirePool();
    try {
      if (!this.readOnly) await pool.query("INSTALL VECTOR;");
      await pool.query("LOAD EXTENSION VECTOR;");
      this.vectorExtensionLoaded = true;
    } catch (err) {
      throw new Error(`graph-db: VECTOR extension unavailable: ${(err as Error).message}`);
    }
  }

  private async ensureFtsIndex(): Promise<void> {
    if (this.ftsIndexBuilt) return;
    const pool = this.requirePool();
    // `CALL CREATE_FTS_INDEX` fails if the index already exists; swallow
    // that specific failure so the call is idempotent from the adapter's
    // point of view. Any other error (missing table, permission) surfaces.
    try {
      await pool.query(
        "CALL CREATE_FTS_INDEX('CodeNode', 'och_fts', ['name', 'signature', 'description'])",
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!/exist|already/i.test(msg)) throw err;
    }
    this.ftsIndexBuilt = true;
  }

  private async ensureVectorIndex(): Promise<void> {
    if (this.vectorIndexBuilt) return;
    const pool = this.requirePool();
    try {
      await pool.query("CALL CREATE_VECTOR_INDEX('Embedding', 'och_vec', 'vector')");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!/exist|already/i.test(msg)) throw err;
    }
    this.vectorIndexBuilt = true;
  }

  // --------------------------------------------------------------------------
  // Public getters retained for option introspection.
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

// ---------------------------------------------------------------------------
// Helpers — parameter building, column translation.
// ---------------------------------------------------------------------------

interface EdgeRow {
  readonly id: string;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly type: RelationType;
  readonly confidence: number;
  readonly reason?: string;
  readonly step?: number;
}

function dedupeLastById<T>(items: readonly T[], idOf: (t: T) => string): readonly T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(idOf(item), item);
  return [...seen.values()];
}

/**
 * Convert a GraphNode into the positional parameter list matching
 * NODE_COLUMNS. `null` is used for any field the node does not carry.
 * Arrays are passed through as string[] — the native binding accepts a JS
 * array directly for the STRING[] column type.
 */
function nodeToParams(node: GraphNode): readonly SqlParam[] {
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
    // Route.method → method; Operation.method goes to http_method below.
    isOperation ? null : stringOrNull(n["method"]),
    stringOrNull(n["toolName"]),
    stringOrNull(n["content"]),
    stringOrNull(n["contentHash"]),
    stringOrNull(n["inferredLabel"]),
    numberOrNull(n["symbolCount"]),
    numberOrNull(n["cohesion"]),
    stringArrayOrNull(n["keywords"]) as unknown as SqlParam,
    stringOrNull(n["entryPointId"]),
    numberOrNull(n["stepCount"]),
    numberOrNull(n["level"]),
    stringArrayOrNull(n["responseKeys"]) as unknown as SqlParam,
    stringOrNull(n["description"]),
    stringOrNull(n["severity"]),
    stringOrNull(n["ruleId"]),
    stringOrNull(n["scannerId"]),
    stringOrNull(n["message"]),
    jsonObjectOrNull(n["propertiesBag"]),
    stringOrNull(n["version"]),
    stringOrNull(n["license"]),
    stringOrNull(n["lockfileSource"]),
    stringOrNull(n["ecosystem"]),
    // Operation kind uses its `.method` / `.path` fields.
    isOperation ? stringOrNull(n["method"]) : null,
    isOperation ? stringOrNull(n["path"]) : null,
    stringOrNull(n["summary"]),
    stringOrNull(n["operationId"]),
    stringOrNull(n["emailHash"]),
    stringOrNull(n["emailPlain"]),
    jsonArrayOrNull(n["languages"]),
    jsonArrayOrNull(n["frameworks"]),
    jsonArrayOrNull(n["iacTypes"]),
    jsonArrayOrNull(n["apiContracts"]),
    jsonArrayOrNull(n["manifests"]),
    jsonArrayOrNull(n["srcDirs"]),
    stringOrNull(n["orphanGrade"]),
    booleanOrNull(n["isOrphan"]),
    numberOrNull(n["truckFactor"]),
    numberOrNull(n["ownershipDrift30d"]),
    numberOrNull(n["ownershipDrift90d"]),
    numberOrNull(n["ownershipDrift365d"]),
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
    // Repo (AC-M6-1). Populated only when `node.kind === "Repo"`; NULL for
    // every other kind.
    repoStringOrNull(n, "originUrl"),
    stringOrNull(n["repoUri"]),
    repoStringOrNull(n, "defaultBranch"),
    stringOrNull(n["commitSha"]),
    stringOrNull(n["indexTime"]),
    repoStringOrNull(n, "group"),
    stringOrNull(n["visibility"]),
    stringOrNull(n["indexer"]),
    languageStatsJsonOrNull(n["languageStats"]),
  ];
}

/**
 * Resolve a RepoNode field whose interface-level type is `string | null`.
 * Named helper keeps intent explicit at the call site — the collapse is the
 * same as `stringOrNull`, but we surface the semantic separately.
 */
function repoStringOrNull(n: Record<string, unknown>, key: string): string | null {
  const v = n[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/**
 * Serialize `RepoNode.languageStats` to byte-stable canonical JSON (sorted
 * keys). NULL for non-object / empty inputs so the column stays NULL for
 * every non-Repo row.
 */
function languageStatsJsonOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  if (Object.keys(v as object).length === 0) return null;
  return canonicalJson(v);
}

function normalizeDeadness(v: unknown): unknown {
  if (v === "unreachable-export") return "unreachable_export";
  return v;
}

function coveredLinesOrNull(coveredLines: unknown, coveredLinesJson: unknown): string | null {
  if (typeof coveredLinesJson === "string" && coveredLinesJson.length > 0) {
    return coveredLinesJson;
  }
  return jsonArrayOrNull(coveredLines);
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
  for (const item of v) if (typeof item === "string") out.push(item);
  return out.length > 0 ? out : null;
}

function jsonArrayOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return null;
  return JSON.stringify(v);
}

function jsonObjectOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return JSON.stringify(v);
}

/**
 * Rewrite a DuckDB-style whereClause (using `?` placeholders and `n.*`
 * column references) into Cypher (using `$pN` placeholders and `node.*`).
 * The substitution is positional — every `?` is replaced by the next
 * `$pN` as chosen by the caller-provided name generator.
 */
function rewriteWhereClause(clause: string, nextName: () => string): string {
  let rewritten = clause.replace(/\bn\./g, "node.");
  rewritten = rewritten.replace(/\?/g, () => nextName());
  return rewritten;
}

/**
 * Emit `'escaped'` form for a string that MUST be inlined into a Cypher
 * statement (e.g. inside a variable-length traversal where the native
 * engine rejects bound parameters). The caller is responsible for
 * guaranteeing the value is string-typed; we only escape `\\` and `'`.
 */
function cypherStringLiteral(value: string): string {
  if (typeof value !== "string") {
    throw new Error(`cypherStringLiteral expects a string, got ${typeof value}`);
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/**
 * Emit a Cypher numeric literal from a finite JS number. Used when the
 * native engine's parameter path is unavailable — the caller pre-validates
 * the input so non-finite values surface as a clean error rather than a
 * silent string concat.
 */
function cypherNumberLiteral(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`cypherNumberLiteral expects a finite number, got ${String(value)}`);
  }
  return value.toString();
}

// ---------------------------------------------------------------------------
// listNodes rehydration helpers — read every column the writer emits and
// rebuild a typed GraphNode with the same field set the original write
// carried. Mirrors the DuckStore `rowToGraphNode` helper byte-for-byte so
// cross-adapter parity holds when callers serialise via canonicalJson.
// ---------------------------------------------------------------------------

/**
 * Clamp a number to a non-negative integer. Local to this adapter so the
 * file remains self-contained; semantics match the DuckStore helper of
 * the same shape — `0` is preserved, `undefined`/negative/non-finite all
 * fall through to `undefined`.
 */
function clampNonNegativeIntGd(v: number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (v < 0) return undefined;
  return Math.floor(v);
}

/**
 * Rehydrate a Cypher record from `MATCH (n:CodeNode) RETURN n.col AS col …`
 * into a typed {@link GraphNode}. Inverse of {@link nodeToParams}: every
 * column it writes is read back here.
 *
 * Returns `undefined` if the load-bearing primary-key columns (`id` /
 * `kind` / `name` / `file_path`) are missing.
 */
function recordToGraphNode(rec: Record<string, unknown>): GraphNode | undefined {
  const id = rec["id"];
  const kindVal = rec["kind"];
  const name = rec["name"];
  const filePath = rec["file_path"];
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

  setStringFieldGd(out, "signature", rec["signature"]);
  setNumberFieldGd(out, "startLine", rec["start_line"]);
  setNumberFieldGd(out, "endLine", rec["end_line"]);
  setBooleanFieldGd(out, "isExported", rec["is_exported"]);
  setNumberFieldGd(out, "parameterCount", rec["parameter_count"]);
  setStringFieldGd(out, "returnType", rec["return_type"]);
  setStringFieldGd(out, "declaredType", rec["declared_type"]);
  setStringFieldGd(out, "owner", rec["owner"]);
  setStringFieldGd(out, "url", rec["url"]);
  if (isOperation) {
    setStringFieldGd(out, "method", rec["http_method"]);
    setStringFieldGd(out, "path", rec["http_path"]);
  } else {
    setStringFieldGd(out, "method", rec["method"]);
  }
  setStringFieldGd(out, "toolName", rec["tool_name"]);
  setStringFieldGd(out, "content", rec["content"]);
  setStringFieldGd(out, "contentHash", rec["content_hash"]);
  setStringFieldGd(out, "inferredLabel", rec["inferred_label"]);
  setNumberFieldGd(out, "symbolCount", rec["symbol_count"]);
  setNumberFieldGd(out, "cohesion", rec["cohesion"]);
  setStringArrayFieldGd(out, "keywords", rec["keywords"]);
  setStringFieldGd(out, "entryPointId", rec["entry_point_id"]);
  setNumberFieldGd(out, "stepCount", rec["step_count"]);
  setNumberFieldGd(out, "level", rec["level"]);
  setStringArrayFieldGd(out, "responseKeys", rec["response_keys"]);
  setStringFieldGd(out, "description", rec["description"]);
  setStringFieldGd(out, "severity", rec["severity"]);
  setStringFieldGd(out, "ruleId", rec["rule_id"]);
  setStringFieldGd(out, "scannerId", rec["scanner_id"]);
  setStringFieldGd(out, "message", rec["message"]);
  setJsonObjectFieldGd(out, "propertiesBag", rec["properties_bag"]);
  setStringFieldGd(out, "version", rec["version"]);
  setStringFieldGd(out, "license", rec["license"]);
  setStringFieldGd(out, "lockfileSource", rec["lockfile_source"]);
  setStringFieldGd(out, "ecosystem", rec["ecosystem"]);
  setStringFieldGd(out, "summary", rec["summary"]);
  setStringFieldGd(out, "operationId", rec["operation_id"]);
  setStringFieldGd(out, "emailHash", rec["email_hash"]);
  setStringFieldGd(out, "emailPlain", rec["email_plain"]);
  setJsonArrayFieldGd(out, "languages", rec["languages_json"]);
  applyFrameworksJsonReadbackGd(out, rec["frameworks_json"]);
  setJsonArrayFieldGd(out, "iacTypes", rec["iac_types_json"]);
  setJsonArrayFieldGd(out, "apiContracts", rec["api_contracts_json"]);
  setJsonArrayFieldGd(out, "manifests", rec["manifests_json"]);
  setJsonArrayFieldGd(out, "srcDirs", rec["src_dirs_json"]);
  setStringFieldGd(out, "orphanGrade", rec["orphan_grade"]);
  setBooleanFieldGd(out, "isOrphan", rec["is_orphan"]);
  setNumberFieldGd(out, "truckFactor", rec["truck_factor"]);
  setNumberFieldGd(out, "ownershipDrift30d", rec["ownership_drift_30d"]);
  setNumberFieldGd(out, "ownershipDrift90d", rec["ownership_drift_90d"]);
  setNumberFieldGd(out, "ownershipDrift365d", rec["ownership_drift_365d"]);
  setStringFieldGd(out, "deadness", denormalizeDeadnessGd(rec["deadness"]));
  setNumberFieldGd(out, "coveragePercent", rec["coverage_percent"]);
  setStringFieldGd(out, "coveredLinesJson", rec["covered_lines_json"]);
  setNumberFieldGd(out, "cyclomaticComplexity", rec["cyclomatic_complexity"]);
  setNumberFieldGd(out, "nestingDepth", rec["nesting_depth"]);
  setNumberFieldGd(out, "nloc", rec["nloc"]);
  setNumberFieldGd(out, "halsteadVolume", rec["halstead_volume"]);
  setStringFieldGd(out, "inputSchemaJson", rec["input_schema_json"]);
  setStringFieldGd(out, "partialFingerprint", rec["partial_fingerprint"]);
  setStringFieldGd(out, "baselineState", rec["baseline_state"]);
  setStringFieldGd(out, "suppressedJson", rec["suppressed_json"]);
  if (kindVal === "Repo") {
    out["originUrl"] = readNullableStringGd(rec["origin_url"]);
    setStringFieldGd(out, "repoUri", rec["repo_uri"]);
    out["defaultBranch"] = readNullableStringGd(rec["default_branch"]);
    setStringFieldGd(out, "commitSha", rec["commit_sha"]);
    setStringFieldGd(out, "indexTime", rec["index_time"]);
    out["group"] = readNullableStringGd(rec["repo_group"]);
    setStringFieldGd(out, "visibility", rec["visibility"]);
    setStringFieldGd(out, "indexer", rec["indexer"]);
    out["languageStats"] = readLanguageStatsGd(rec["language_stats_json"]);
  }
  return out as unknown as GraphNode;
}

function setStringFieldGd(out: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v === "string" && v.length > 0) out[key] = v;
}

function setNumberFieldGd(out: Record<string, unknown>, key: string, v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v === "number" && Number.isFinite(v)) {
    out[key] = v;
    return;
  }
  if (typeof v === "bigint") {
    out[key] = Number(v);
    return;
  }
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[key] = n;
  }
}

function setBooleanFieldGd(out: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v === "boolean") out[key] = v;
}

function setStringArrayFieldGd(out: Record<string, unknown>, key: string, v: unknown): void {
  if (!Array.isArray(v)) return;
  const arr: string[] = [];
  for (const item of v) if (typeof item === "string") arr.push(item);
  if (arr.length > 0) out[key] = arr;
}

function setJsonArrayFieldGd(out: Record<string, unknown>, key: string, v: unknown): void {
  if (typeof v !== "string" || v.length === 0) return;
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) out[key] = parsed;
  } catch {
    /* skip */
  }
}

function setJsonObjectFieldGd(out: Record<string, unknown>, key: string, v: unknown): void {
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

function applyFrameworksJsonReadbackGd(out: Record<string, unknown>, v: unknown): void {
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
    /* skip */
  }
}

function denormalizeDeadnessGd(v: unknown): unknown {
  if (v === "unreachable_export") return "unreachable-export";
  return v;
}

function readNullableStringGd(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function readLanguageStatsGd(v: unknown): Readonly<Record<string, number>> {
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
