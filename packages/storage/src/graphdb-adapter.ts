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
import { GraphDbPool, type GraphDbPoolConfig } from "./graphdb-pool.js";
import { generateSchemaDdl, getAllRelationTypes } from "./graphdb-schema.js";
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
];

/** Edge rel-table property columns. Matches graphdb-schema.ts. */
const EDGE_COLUMNS: readonly string[] = ["id", "confidence", "reason", "step"];

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
      const params: SqlParam[] = [e.from, e.to, e.id, e.confidence, e.reason ?? null, e.step ?? 0];
      await pool.query(cypher, params);
    }
  }

  // --------------------------------------------------------------------------
  // Embeddings (deferred to AC-M3-3 Commit 3)
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
  ];
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
