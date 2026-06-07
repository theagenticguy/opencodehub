/**
 * Graph-database backend for {@link IGraphStore} (phase-2 implementation).
 *
 * This adapter is the second implementation behind the `IGraphStore` seam.
 * DuckDbStore remains the default; this file ships the full lifecycle +
 * bulk-load surface so the lbug graph backend already drives a
 * round-trip-clean graph write.
 *
 * Design notes:
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
import { dedupeLastById, NODE_COLUMNS, nodeToColumns } from "./column-encode.js";
import { assertReadOnlyCypher } from "./cypher-guard.js";
import { classifyLicenseTier } from "./duckdb-adapter.js";
import { GraphDbPool, type GraphDbPoolConfig } from "./graphdb-pool.js";
import { generateSchemaDdl, getAllRelationTypes } from "./graphdb-schema.js";
import type {
  AncestorTraversalOptions,
  BulkLoadOptions,
  BulkLoadStats,
  ConsumerProducerEdge,
  DescendantTraversalOptions,
  EmbeddingRow,
  GraphDialect,
  IGraphStore,
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
 * Thrown by adapter surfaces that are not yet wired. The cochange + symbol
 * summary surfaces live on {@link ITemporalStore}, never on the graph
 * adapter. The class export is retained because downstream packages still
 * import it for typed fallback handling on graph-only failure modes.
 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`graph-db: ${method} not yet wired`);
    this.name = "NotImplementedError";
  }
}

/**
 * Single source of truth for the user-facing summary of the `@ladybugdb/core`
 * platform-support matrix. Shared by {@link GraphDbBindingError} (the runtime
 * abort message) and `codehub doctor`'s graph-binding check (the diagnostic
 * hint) so the two never drift. `@ladybugdb/core` ships prebuilt binaries only
 * for darwin-x64, darwin-arm64, linux-x64 (glibc), linux-arm64 (glibc), and
 * win32-x64.
 */
export const GRAPH_BINDING_SUPPORTED_PLATFORMS =
  "Supported platforms: macOS x64/arm64, Linux x64/arm64 (glibc), Windows x64.";

/**
 * Platform-specific guidance for a missing `@ladybugdb/core` prebuilt. The
 * graph tier is mandatory (no fallback), so on an UNSUPPORTED platform —
 * notably win32-arm64 and any musl-libc Linux (Alpine) — there is no prebuilt
 * to load and OpenCodeHub cannot run. Naming those cases explicitly makes the
 * failure diagnosable rather than a bare module-load error.
 *
 * Returns an empty string on a supported platform (no extra note to add).
 * `platform`/`arch` default to the running process so callers can pass
 * `process.platform` / `process.arch` implicitly; tests inject fixtures.
 */
export function graphBindingPlatformNote(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "win32" && arch === "arm64") {
    return " Windows on ARM64 (win32-arm64) has no @ladybugdb/core prebuilt and is not currently supported.";
  }
  if (platform === "linux") {
    return " On Alpine / musl-libc Linux there is no @ladybugdb/core prebuilt; use a glibc-based image (e.g. debian/ubuntu, node:* not node:*-alpine).";
  }
  return "";
}

/**
 * Missing peer-binding error. Surfaced when the native `@ladybugdb/core`
 * module is not available on the current platform (no prebuilt binary, or
 * the package was pruned by a `--production` install).
 */
export class GraphDbBindingError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      "@ladybugdb/core native binding unavailable on this platform. " +
        "OpenCodeHub requires the lbug graph backend (it has no fallback). " +
        GRAPH_BINDING_SUPPORTED_PLATFORMS +
        graphBindingPlatformNote() +
        ` Underlying cause: ${detail}`,
    );
    this.name = "GraphDbBindingError";
  }
}

// ---------------------------------------------------------------------------
// Column layouts — `NODE_COLUMNS` lives in `./column-encode.ts` and is the
// canonical column ordering shared with the DuckDB adapter. Adding a column
// means: (1) extend the schema DDL in `graphdb-schema.ts` AND
// `schema-ddl.ts`, (2) append it to `NODE_COLUMNS` in `column-encode.ts`,
// (3) append the writer slot in `nodeToColumns` in `column-encode.ts`,
// (4) append the reader in `ROUND_TRIP_COLUMN_MAP` below + the readback
// path. Order matters because both directions are index-aligned with the
// prepared statement parameter list.
// ---------------------------------------------------------------------------

// Edge columns are encoded inline in edgeToCsvLine() — no separate constant needed.

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
 * `rebuildGraphFromStore` walks this list so the returned graph carries
 * the same field set the bulk writer ingested.
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
// Transient bulk-load retry
// ---------------------------------------------------------------------------

/** Resolve after `ms` milliseconds. Used for bulk-load retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

/**
 * True for the transient lbug WAL→checkpoint rename failure that surfaces
 * under load — e.g. `IO exception: Error renaming file <db>.wal to
 * <db>.wal.checkpoint. ErrorMessage: No such file or directory`. The data is
 * already in the WAL (a reopen recovers it), so this specific failure is
 * safe to retry. Matched on the stable token trio (renaming + .wal +
 * checkpoint) rather than the OS-specific errno suffix, which varies by
 * platform. Every other error returns false and rethrows.
 */
export function isTransientCheckpointError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /renaming/i.test(msg) && /\.wal\b/i.test(msg) && /checkpoint/i.test(msg);
}

/**
 * Run `fn`, retrying up to `maxAttempts` times when it throws a transient
 * WAL→checkpoint rename error (see {@link isTransientCheckpointError}). Any
 * other error rethrows immediately; the transient error on the final attempt
 * also rethrows. Backoff scales with attempt (25ms, 50ms, …) to let the OS
 * settle the WAL file. Extracted as a pure helper so the retry policy is unit-
 * testable without provoking a native race. Used only by replace-mode-safe
 * bulk-load, which is idempotent (truncate-then-insert).
 */
export async function retryTransientCheckpoint<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  backoff: (attempt: number) => Promise<void> = (attempt) => delay(attempt * 25),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientCheckpointError(err)) throw err;
      await backoff(attempt);
    }
  }
}

// ---------------------------------------------------------------------------
// COPY FROM (subquery) bulk insert
// ---------------------------------------------------------------------------
//
// lbug v0.16.1 infers struct-field types per-row from JS values: integer-
// valued numbers (Number.isInteger) → INT64, others → DOUBLE. A
// `confidence=1.0` edge binds as INT64 and round-trips as garbage from a
// DOUBLE column.
//
// The fix: COPY <Table> FROM (UNWIND $rows AS r RETURN ...) where numeric
// columns use CAST(r.col AS <DDLtype>) and the raw values are passed as
// strings. The COPY FROM path resolves types from the pre-defined table
// schema, CAST converts the string to the correct type, and per-row
// inference never runs on numerics.
//
// No temp files required — rows travel as a prepared-statement parameter.
// ---------------------------------------------------------------------------

/**
 * Column DDL type tags used to decide how to encode each value in the
 * UNWIND row object and whether to wrap its RETURN expression in CAST.
 * Must stay in the same order as NODE_COLUMNS.
 */
type ColKind = "str" | "int" | "double" | "bool" | "strarray";

const NODE_COL_KINDS: readonly ColKind[] = (() => {
  const map: Record<string, ColKind> = {
    start_line: "int",
    end_line: "int",
    parameter_count: "int",
    step_count: "int",
    level: "int",
    symbol_count: "int",
    cyclomatic_complexity: "int",
    nesting_depth: "int",
    nloc: "int",
    truck_factor: "int",
    is_exported: "bool",
    is_orphan: "bool",
    cohesion: "double",
    coverage_percent: "double",
    halstead_volume: "double",
    ownership_drift_30d: "double",
    ownership_drift_90d: "double",
    ownership_drift_365d: "double",
    keywords: "strarray",
    response_keys: "strarray",
  };
  return NODE_COLUMNS.map((col) => map[col] ?? "str");
})();

/**
 * Build the `COPY CodeNode FROM (UNWIND $rows AS r RETURN ...)` statement.
 * Numeric columns (INT32, DOUBLE) use CAST(r.col AS <type>) so that string-
 * encoded values (e.g. "1", "0.9") reach the correct column type regardless
 * of how the JS binding inferred the struct-field type. Non-numeric columns
 * project directly as `r.col`.
 */
function buildNodeCopySubquery(): string {
  const returnCols = NODE_COLUMNS.map((col, i) => {
    switch (NODE_COL_KINDS[i]) {
      case "int":
        return `CAST(r.${col} AS INT32)`;
      case "double":
        return `CAST(r.${col} AS DOUBLE)`;
      default:
        return `r.${col}`;
    }
  }).join(", ");
  // WITH r WHERE filters out the type-seeding sentinel row (see NODE_SENTINEL_ID).
  return (
    `COPY CodeNode FROM (UNWIND $rows AS r ` +
    `WITH r WHERE r.id <> '${NODE_SENTINEL_ID}' ` +
    `RETURN ${returnCols})`
  );
}

/**
 * Sentinel id prepended to every UNWIND batch. Row 0 of `$rows` seeds the
 * struct-field type for every column. When row 0 has a null field, the binder
 * infers ANY for that field's type and fails with "Trying to create a vector
 * with ANY type". The sentinel carries a concrete non-null value for every
 * column, and the `WITH r WHERE r.id <> NODE_SENTINEL_ID` clause in the
 * COPY subquery filters it out before any row lands in storage.
 */
const NODE_SENTINEL_ID = "__OCH_SENTINEL__";
const EDGE_SENTINEL_ID = "__OCH_EDGE_SENTINEL__";

/**
 * Marker element used to encode an explicit empty `STRING[]` value.
 *
 * lbug v0.16.1 collapses a 0-length array literal to SQL NULL on write, so
 * an empty `keywords: []` is indistinguishable from an absent column on
 * read-back — which would break `graphHash` byte-identity against the
 * canonical-JSON projection (`{}` vs `{"keywords":[]}` are distinct). We
 * write a single-element array carrying this marker instead; the read side
 * ({@link setStringArrayFieldGd}) recognises it and reconstructs `[]`,
 * while a truly absent field is written as `[]` (→ stored NULL → dropped).
 *
 * The marker is pure ASCII with no leading whitespace because lbug rewrites
 * a leading space to a NUL byte; a plain token round-trips byte-for-byte.
 */
const EMPTY_STRING_ARRAY_MARKER = "__OCH_EMPTY_STRING_ARRAY__";

/** Pre-built node copy statement (constant — column list never changes). */
const NODE_COPY_SUBQUERY = buildNodeCopySubquery();

function buildEdgeCopySubquery(kind: string): string {
  // IGNORE_ERRORS=true skips rows where the FROM/TO node lookup fails — this
  // handles the type-seeding sentinel row whose from/to point to a
  // non-existent CodeNode. Real rows should always have valid endpoints; if
  // they don't, the edge is silently dropped (same behaviour as the old
  // per-row path which would throw on MATCH failure).
  return (
    // Row struct fields use `src`/`dst` instead of `from`/`to` because FROM
    // and TO are Cypher keywords — using them as `r.from`/`r.to` is
    // ambiguous and silently causes the COPY to misinterpret columns.
    // The COPY column list `(id, confidence, reason, step)` specifies which rel
    // properties to populate. The RETURN uses `r.eid` (not `r.id`) for the
    // edge id to avoid lbug misinterpreting it as a CodeNode PK lookup: lbug
    // treats a RETURN column named `id` as a node-PK reference when it matches
    // the referenced node table's primary key column name. Using a different
    // alias breaks the false match while the positional column list maps it to
    // the rel's `id STRING` property.
    `COPY ${kind}(id, confidence, reason, step) FROM ` +
    `(UNWIND $rows AS r WITH r WHERE r.eid <> '${EDGE_SENTINEL_ID}' ` +
    `RETURN r.src, r.dst, r.eid, CAST(r.confidence AS DOUBLE), r.reason, CAST(r.step AS INT32))`
  );
}

/**
 * Encode a GraphNode column value for the UNWIND parameter object.
 * Numeric columns are encoded as strings so lbug's binder does not infer
 * INT64 for integer-valued numbers; CAST in the RETURN expression then
 * converts to the correct DDL type. All other values pass through as-is.
 */
function encodeNodeCol(v: unknown, kind: ColKind): unknown {
  // strarray must never be null — lbug infers LIST(ANY) from a null field and
  // fails with "Trying to create a vector with ANY type". Check before the
  // null short-circuit so absent arrays become [] rather than null.
  if (kind === "strarray") {
    // Absent / non-array → []  (lbug stores [] as NULL; the reader drops the
    // field, matching the "absent" canonical-JSON shape).
    if (!Array.isArray(v)) return [] as string[];
    const items = (v as unknown[]).filter((x) => typeof x === "string") as string[];
    // Explicit empty array → single-element marker so the "[] vs absent"
    // distinction survives lbug's empty-array → NULL collapse. The reader
    // ({@link setStringArrayFieldGd}) maps the marker back to []. A
    // non-empty array passes through verbatim.
    if (items.length === 0) return [EMPTY_STRING_ARRAY_MARKER];
    return items;
  }
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "int":
      return typeof v === "number" && Number.isFinite(v) ? String(Math.trunc(v)) : null;
    case "double":
      return typeof v === "number" && Number.isFinite(v) ? String(v) : null;
    case "bool":
      return typeof v === "boolean" ? v : null;
    default:
      return typeof v === "string" ? v : String(v);
  }
}

/**
 * Build the type-seeding sentinel row for a node batch. Every column gets a
 * concrete non-null value matching its DDL type so lbug's binder can resolve
 * every struct field at prepare time. The WITH/WHERE clause in the COPY
 * subquery filters it out before any storage write.
 *
 * STRING[] columns get a single-element seed (`["__sentinel__"]`) — lbug's
 * struct-field inference looks at the FIRST row's array contents to fix
 * the LIST element type. An empty-array sentinel forces LIST(ANY) and the
 * binder later throws "Trying to create a vector with ANY type" when a
 * data row supplies a string. The seed value never reaches storage; the
 * sentinel row is filtered before COPY writes.
 */
function buildNodeSentinel(): Record<string, unknown> {
  const sentinel: Record<string, unknown> = {};
  for (let i = 0; i < NODE_COLUMNS.length; i++) {
    const col = NODE_COLUMNS[i] as string;
    switch (NODE_COL_KINDS[i]) {
      case "int":
        sentinel[col] = "0";
        break;
      case "double":
        sentinel[col] = "0.0";
        break;
      case "bool":
        sentinel[col] = false;
        break;
      case "strarray":
        sentinel[col] = ["__sentinel__"] as string[];
        break;
      default:
        sentinel[col] = "";
        break;
    }
  }
  sentinel["id"] = NODE_SENTINEL_ID;
  return sentinel;
}

/** Pre-built node sentinel row (constant — same shape for every batch). */
const NODE_SENTINEL_ROW = buildNodeSentinel();

/**
 * Walk the edge set and synthesize a stub `Repository` node for every
 * `from`/`to` id that doesn't appear in the node set. The pipeline's
 * fetches phase (and any future cross-repo edge that points at a
 * not-yet-resolved target) emits ids like `fetches:unresolved:GET:/users/1`
 * that intentionally have no corresponding node — the URL template lives
 * on the edge's `reason` for downstream lookup. lbug's COPY rejects
 * those edges because the to-node primary key is missing; DuckDB used to
 * accept them silently. Synthesize a minimal placeholder so the bulk
 * load completes, with the original id preserved for round-trip.
 */
/** Distinct from/to ids referenced by an edge batch. */
function edgeEndpointIds(
  edges: readonly { readonly from: NodeId; readonly to: NodeId }[],
): readonly string[] {
  const ids = new Set<string>();
  for (const e of edges) {
    ids.add(e.from as string);
    ids.add(e.to as string);
  }
  return [...ids];
}

/**
 * Synthesize a placeholder CodeNode for every edge endpoint id that has no
 * real node, so lbug's COPY (which requires a real PK for each rel endpoint)
 * succeeds.
 *
 * `alreadyPersisted` (upsert mode only) lists endpoint ids that already exist
 * in the store. Those must NOT be synthesized: a placeholder would later be
 * `mergeNodes`-ed (DETACH DELETE + re-insert), clobbering the real node. In
 * replace mode the store was just truncated, so pass `undefined`.
 */
function synthesizePlaceholderNodes(
  nodes: readonly GraphNode[],
  edges: readonly { readonly from: NodeId; readonly to: NodeId }[],
  alreadyPersisted?: ReadonlySet<string>,
): GraphNode[] {
  const known = new Set<string>();
  for (const n of nodes) known.add(n.id as string);
  const missing = new Set<string>();
  for (const e of edges) {
    if (!known.has(e.from as string) && !(alreadyPersisted?.has(e.from as string) ?? false)) {
      missing.add(e.from as string);
    }
    if (!known.has(e.to as string) && !(alreadyPersisted?.has(e.to as string) ?? false)) {
      missing.add(e.to as string);
    }
  }
  if (missing.size === 0) return [];
  const out: GraphNode[] = [];
  for (const id of missing) {
    // Route is the right kind for unresolved-fetch placeholders (the
    // edge that referenced it was a FETCHES targeting an HTTP endpoint).
    // For other orphan id shapes the kind is still cosmetic — the only
    // load-bearing requirement is that the COPY finds a primary key.
    out.push({
      id: id as NodeId,
      kind: "Route",
      name: id,
      filePath: "<placeholder>",
      url: id,
    } as GraphNode);
  }
  return out;
}

/**
 * Sentinel row for edge batches. Typed seed for every EDGE column so
 * lbug's binder resolves struct fields even when the real batch has nulls.
 */
const EDGE_SENTINEL_ROW: Record<string, unknown> = {
  eid: EDGE_SENTINEL_ID,
  src: "",
  dst: "",
  confidence: "0.0",
  reason: null,
  step: null,
};

async function bulkInsertNodes(pool: GraphDbPool, nodes: readonly GraphNode[]): Promise<void> {
  if (nodes.length === 0) return;
  const rows: Record<string, unknown>[] = [NODE_SENTINEL_ROW];
  for (const node of nodes) {
    const cols = nodeToColumns(node);
    const row: Record<string, unknown> = {};
    for (let i = 0; i < NODE_COLUMNS.length; i++) {
      const col = NODE_COLUMNS[i] as string;
      const kind = NODE_COL_KINDS[i] as ColKind;
      row[col] = encodeNodeCol(cols[col], kind);
    }
    rows.push(row);
  }
  await pool.execWrite(NODE_COPY_SUBQUERY, { rows });
}

async function mergeNodes(pool: GraphDbPool, nodes: readonly GraphNode[]): Promise<void> {
  if (nodes.length === 0) return;
  for (const n of nodes) {
    await pool.query(`MATCH (n:CodeNode {id: $p1}) DETACH DELETE n`, [n.id]);
  }
  await bulkInsertNodes(pool, nodes);
}

async function bulkInsertEdges(
  pool: GraphDbPool,
  kind: string,
  edges: readonly EdgeRow[],
): Promise<void> {
  if (edges.length === 0) return;
  const rows: Record<string, unknown>[] = [EDGE_SENTINEL_ROW];
  for (const e of edges) {
    rows.push({
      eid: e.id,
      src: e.from,
      dst: e.to,
      confidence:
        typeof e.confidence === "number" && Number.isFinite(e.confidence)
          ? String(e.confidence)
          : null,
      reason: e.reason ?? null,
      step:
        e.step !== undefined && typeof e.step === "number" && Number.isFinite(e.step)
          ? String(e.step)
          : null,
    });
  }
  await pool.execWrite(buildEdgeCopySubquery(kind), { rows });
}

async function mergeEdges(
  pool: GraphDbPool,
  kind: string,
  edges: readonly EdgeRow[],
): Promise<void> {
  if (edges.length === 0) return;
  for (const e of edges) {
    await pool.query(`MATCH ()-[r:${kind} {id: $p1}]->() DELETE r`, [e.id]);
  }
  await bulkInsertEdges(pool, kind, edges);
}

function buildEmbeddingCreateCypher(): string {
  const propPairs = EMBEDDING_COLUMNS.map((col, i) => `${col}: $p${i + 1}`).join(", ");
  return `CREATE (e:Embedding {${propPairs}})`;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class GraphDbStore implements IGraphStore {
  /**
   * Cypher dialect marker. The graph-db backend speaks Cypher natively;
   * the optional {@link IGraphStore.execCypher} escape hatch is wired
   * below so community tooling that needs raw Cypher (APOC analogues,
   * etc.) can call through.
   */
  readonly dialect: GraphDialect = "cypher";
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
    // Surface missing-binding failures as a typed error so the pool's own
    // lazy import doesn't produce a raw module-not-found error. When the
    // caller injected a `binding` in `poolConfig` (tests) we skip the
    // probe — the fake already provides the types.
    if (!this.poolConfig.binding) {
      try {
        await import("@ladybugdb/core");
      } catch (err) {
        throw new GraphDbBindingError(err);
      }
    }
    // Guard: lbug v0.16.1 creates an empty database file even when opened
    // with readOnly=true if the path doesn't exist yet. The empty DB then
    // fails on any write (INSTALL FTS, INSTALL VECTOR, schema creation) with
    // "Cannot create an empty database under READ ONLY mode". Fail-fast here
    // so callers that catch `open()` errors (augment, countPriorCallable,
    // openEmbeddingHashCacheAdapter) get the error they expect — and the
    // lbug file is never created for a read-only probe on a missing DB.
    if ((this.poolConfig.readOnly ?? this.readOnly) && this.path !== ":memory:") {
      const { access } = await import("node:fs/promises");
      try {
        await access(this.path);
      } catch {
        throw new Error(
          `graph-db: database file does not exist at ${this.path} (read-only open refused)`,
        );
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

  /**
   * Bulk-load with a bounded retry for the transient lbug WAL→checkpoint
   * IO race. Under CPU/IO pressure the native binding's auto-checkpoint can
   * fail to rename `graph.lbug.wal` → `.wal.checkpoint` ("No such file or
   * directory") even though the data is already durably in the WAL. The
   * write otherwise succeeds (a reopen recovers the WAL), so the failure is
   * a flaky teardown artifact, not data loss — but unretried it bubbles to
   * the CLI's top-level catch and fails `analyze` with exit 1. Observed only
   * on loaded CI runners (varies by leg), never on an idle box.
   *
   * replace-mode bulkLoad is idempotent (truncate-then-insert fully replaces
   * prior contents), so a retry is safe. We retry only the transient
   * checkpoint-rename class; every other error rethrows immediately.
   */
  async bulkLoad(graph: KnowledgeGraph, opts: BulkLoadOptions = {}): Promise<BulkLoadStats> {
    return retryTransientCheckpoint(() => this.#bulkLoadOnce(graph, opts));
  }

  async #bulkLoadOnce(graph: KnowledgeGraph, opts: BulkLoadOptions = {}): Promise<BulkLoadStats> {
    const pool = this.requirePool();
    const started = performance.now();
    const mode = opts.mode ?? "replace";
    // The FTS extension must be loaded on the active connection before
    // any DELETE / DETACH DELETE on CodeNode runs. lbug builds the FTS
    // index against the table; without the extension loaded, deletes
    // surface "Trying to delete from an index on table CodeNode but its
    // extension is not loaded". Both replace-mode `truncateAll` and
    // upsert-mode `mergeNodes` issue such deletes, so load it
    // unconditionally up front. Failures are swallowed: the extension
    // may not be available on the host platform, in which case the
    // search-side codepath surfaces a clearer error from
    // `ensureFtsExtension` later.
    await this.ensureFtsExtension().catch(() => {});
    const reportProgress = (
      ev: Parameters<NonNullable<BulkLoadOptions["onProgress"]>>[0],
    ): void => {
      if (opts.onProgress === undefined) return;
      try {
        opts.onProgress(ev);
      } catch {
        // Progress-callback errors must never mask bulk-load failures.
      }
    };

    if (mode === "replace") {
      reportProgress({ kind: "truncate-start", elapsedMs: performance.now() - started });
      await this.truncateAll();
      reportProgress({ kind: "truncate-end", elapsedMs: performance.now() - started });
    }

    const nodes = dedupeLastById(graph.orderedNodes(), (n) => n.id);
    const edges = dedupeLastById(graph.orderedEdges(), (e) => e.id);
    // lbug's COPY enforces that every relation's from/to is a real
    // CodeNode primary key. The pipeline emits synthetic edge targets
    // (e.g. unresolved FETCHES placeholders carrying the URL template
    // in `reason`) that never have a matching node. Synthesize one
    // CodeNode per orphan id so the COPY succeeds; downstream tools
    // recognise these by their well-known id prefix.
    //
    // Upsert mode caveat: a batch that carries ONLY new nodes (e.g.
    // `ingest-sarif` upserts Finding nodes plus FOUND_IN edges into the
    // already-persisted graph) references real, previously-loaded nodes
    // that are absent from THIS batch. Synthesizing a placeholder for
    // such an id and then `mergeNodes`-ing it (DETACH DELETE + re-insert)
    // would DESTROY the real node — turning, e.g., the Function a finding
    // was found in into a `<placeholder>` Route. So in upsert mode we must
    // exclude ids that already exist in the store from synthesis; only
    // genuinely-orphan ids (no node in the batch AND none in the store)
    // get a placeholder.
    const existingIds =
      mode === "upsert"
        ? await this.filterExistingNodeIds(pool, edgeEndpointIds(edges))
        : undefined;
    const synthetic = synthesizePlaceholderNodes(nodes, edges, existingIds);
    const allNodes = synthetic.length > 0 ? [...nodes, ...synthetic] : nodes;
    await this.insertNodes(pool, allNodes, mode, reportProgress, started);

    const byKind = new Map<RelationType, EdgeRow[]>();
    for (const e of edges) {
      const bucket = byKind.get(e.type) ?? [];
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
    if (edges.length > 0) {
      reportProgress({
        kind: "edges-start",
        total: edges.length,
        elapsedMs: performance.now() - started,
      });
    }
    let edgesDone = 0;
    for (const [kind, bucket] of byKind) {
      await this.insertEdgesForKind(pool, kind, bucket, mode, reportProgress, () => {
        edgesDone += bucket.length;
        return { done: edgesDone, total: edges.length, elapsedMs: performance.now() - started };
      });
    }
    if (edges.length > 0) {
      reportProgress({
        kind: "edges-end",
        done: edges.length,
        total: edges.length,
        elapsedMs: performance.now() - started,
      });
    }

    // Build the search-side indexes here so subsequent read-only opens
    // can query without triggering writes. lbug rejects
    // `CALL CREATE_FTS_INDEX` / `CALL CREATE_VECTOR_INDEX` on a readOnly
    // Database — and `ensureFtsIndex` / `ensureVectorIndex` correctly
    // no-op in that mode. Any failure at this stage is non-fatal: the
    // FTS / VECTOR extension may not be available on the host platform,
    // in which case search/vectorSearch will surface a clearer error
    // from the extension load path the next time they're called.
    await this.ensureFtsExtension().catch(() => {});
    await this.ensureFtsIndex().catch(() => {});

    const durationMs = performance.now() - started;
    return {
      nodeCount: graph.nodeCount(),
      edgeCount: graph.edgeCount(),
      durationMs,
    };
  }

  private async truncateAll(): Promise<void> {
    const pool = this.requirePool();
    // Drop the search-side indexes BEFORE any node delete. lbug 0.16.1
    // hard-crashes with SIGBUS (bus error — an un-catchable native signal,
    // not a JS exception the retry wrapper could survive) when a
    // `MATCH (n:CodeNode) DELETE n` runs while the `och_fts` full-text index
    // is live on that table. The index is rebuilt by the trailing
    // `ensureFtsIndex()` / `ensureVectorIndex()` in `#bulkLoadOnce` after the
    // fresh rows are inserted, so dropping it here is lossless. `och_vec` on
    // `Embedding` gets the same treatment for symmetry (the vector index is
    // built on the write path too); the failure mode is structural — any live
    // index over rows being deleted is unsafe — so we never delete indexed
    // rows out from under an index again.
    await this.dropSearchIndexes();
    // Delete edges first so node deletes stay side-effect free. The graph-db
    // engine rejects deletes of a node that still has dangling rels.
    for (const kind of getAllRelationTypes()) {
      await pool.query(`MATCH ()-[r:${kind}]->() DELETE r`);
    }
    await pool.query("MATCH ()-[r:EMBEDS]->() DELETE r");
    await pool.query("MATCH (n:Embedding) DELETE n");
    await pool.query("MATCH (n:CodeNode) DELETE n");
  }

  /**
   * Drop the FTS (`och_fts` on `CodeNode`) and VECTOR (`och_vec` on
   * `Embedding`) indexes ahead of a truncate. A `DROP_*_INDEX` for an index
   * that does not exist throws a catchable "doesn't have an index" Binder
   * exception (NOT a SIGBUS) — we swallow exactly that so the drop is
   * idempotent across fresh stores, embeddings-disabled runs, and repeated
   * bulk-loads. Any other error (missing table, permission) surfaces.
   *
   * Resets `ftsIndexBuilt` / `vectorIndexBuilt` so the post-insert
   * `ensureFtsIndex()` / `ensureVectorIndex()` calls actually rebuild the
   * indexes against the freshly-loaded rows instead of short-circuiting on a
   * now-stale "already built" flag.
   */
  private async dropSearchIndexes(): Promise<void> {
    const pool = this.requirePool();
    // The FTS extension must be loaded before DROP_FTS_INDEX is bindable;
    // `#bulkLoadOnce` already loads it up front, but load defensively here so
    // `truncateAll` is correct if ever called on its own. A load failure
    // (extension unavailable on this host) means there is no index to drop.
    const dropIfPresent = async (stmt: string): Promise<void> => {
      try {
        await pool.query(stmt);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        // Both of these mean "there is no index to drop", which is the
        // idempotent no-op case:
        //   - Binder:  "Table X doesn't have an index with name Y" — the
        //     index was never created (fresh store, embeddings disabled,
        //     repeated truncate).
        //   - Catalog: "function DROP_VECTOR_INDEX is not defined ... VECTOR
        //     extension" — the extension isn't loaded on this connection, so
        //     no vector index can exist to drop. (`#bulkLoadOnce` loads FTS
        //     up front but not VECTOR; loading VECTOR solely to drop a
        //     usually-absent index isn't worth the cost.)
        const noIndexToDrop =
          /does(?:n't| not) have an index|no index|not exist/i.test(msg) ||
          (/is not defined/i.test(msg) && /extension/i.test(msg));
        if (!noIndexToDrop) throw err;
      }
    };
    await dropIfPresent("CALL DROP_FTS_INDEX('CodeNode', 'och_fts')");
    await dropIfPresent("CALL DROP_VECTOR_INDEX('Embedding', 'och_vec')");
    this.ftsIndexBuilt = false;
    this.vectorIndexBuilt = false;
  }

  /**
   * Return the subset of `candidateIds` that already exist as CodeNodes in the
   * store. Used by upsert-mode bulkLoad to avoid synthesizing a placeholder
   * (and then `mergeNodes`-clobbering) for an edge endpoint that is a real,
   * previously-persisted node not present in the current batch. Reuses the
   * `listNodes({ ids })` finder so id decoding stays in one place; passes no
   * `limit` so every match is returned.
   */
  private async filterExistingNodeIds(
    _pool: GraphDbPool,
    candidateIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (candidateIds.length === 0) return new Set<string>();
    const found = await this.listNodes({ ids: candidateIds as readonly NodeId[] });
    return new Set(found.map((n) => n.id as string));
  }

  private async insertNodes(
    pool: GraphDbPool,
    nodes: readonly GraphNode[],
    mode: "replace" | "upsert",
    reportProgress: (ev: Parameters<NonNullable<BulkLoadOptions["onProgress"]>>[0]) => void,
    bulkStartedAt: number,
  ): Promise<void> {
    if (nodes.length === 0) return;
    reportProgress({
      kind: "nodes-start",
      total: nodes.length,
      elapsedMs: performance.now() - bulkStartedAt,
    });
    if (mode === "upsert") {
      await mergeNodes(pool, nodes);
    } else {
      await bulkInsertNodes(pool, nodes);
    }
    reportProgress({
      kind: "nodes-end",
      done: nodes.length,
      total: nodes.length,
      elapsedMs: performance.now() - bulkStartedAt,
    });
  }

  private async insertEdgesForKind(
    pool: GraphDbPool,
    kind: string,
    edges: readonly EdgeRow[],
    mode: "replace" | "upsert",
    reportProgress: (ev: Parameters<NonNullable<BulkLoadOptions["onProgress"]>>[0]) => void,
    cumulative: () => { done: number; total: number; elapsedMs: number },
  ): Promise<void> {
    if (edges.length === 0) return;
    if (mode === "upsert") {
      await mergeEdges(pool, kind, edges);
    } else {
      await bulkInsertEdges(pool, kind, edges);
    }
    const c = cumulative();
    reportProgress({ kind: "edges-batch", relType: kind, ...c });
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
    // Refuse write keywords so the user surface stays read-only. The
    // full Cypher-guard lives in `cypher-guard.ts`; this call mirrors
    // the DuckDB backend's `assertReadOnlySql` approach and trips every
    // write verb the native binding accepts.
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
    const idsRaw = opts.ids;
    if (idsRaw !== undefined && idsRaw.length === 0) return [];
    const ids = idsRaw !== undefined ? Array.from(new Set(idsRaw)) : undefined;
    const pool = this.requirePool();
    const limit = clampNonNegativeIntGd(opts.limit);
    const offset = clampNonNegativeIntGd(opts.offset);

    // RETURN every column the writer emits. Each column → field mapping
    // mirrors `nodeToParams` exactly so the round-trip is symmetric.
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");

    const params: SqlParam[] = [];
    const wheres: string[] = [];
    let next = 1;
    if (kinds && kinds.length > 0) {
      const phs: string[] = [];
      for (const k of kinds) {
        phs.push(`$p${next}`);
        params.push(k);
        next += 1;
      }
      wheres.push(`n.kind IN [${phs.join(", ")}]`);
    }
    if (ids !== undefined && ids.length > 0) {
      const phs: string[] = [];
      for (const id of ids) {
        phs.push(`$p${next}`);
        params.push(id);
        next += 1;
      }
      wheres.push(`n.id IN [${phs.join(", ")}]`);
    }
    if (opts.filePath !== undefined) {
      wheres.push(`n.file_path = $p${next}`);
      params.push(opts.filePath);
      next += 1;
    }
    const wherePredicate = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")} ` : "";
    // SKIP / LIMIT bound via inline literals after the clampNonNegativeInt
    // guard has confirmed they are finite non-negative integers — no
    // injection risk because `Number.isFinite` + `Math.floor` enforce a
    // strict integer encoding before we interpolate.
    let pagination = "";
    if (offset !== undefined) pagination += `SKIP ${offset} `;
    if (limit !== undefined) pagination += `LIMIT ${limit} `;

    const cypher = (
      `MATCH (n:CodeNode) ${wherePredicate}` +
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

  // --------------------------------------------------------------------------
  // Typed finders — service-layer foundation
  // --------------------------------------------------------------------------
  //
  // Cypher stays LOCAL to this file — never exported. Determinism: node
  // finders ORDER BY n.id ASC + JS-side lex tiebreak; edge finders ORDER BY
  // (from, to, type); the consumer-producer finder orders by (consumer
  // repo, producer repo, method, path).

  /** Single-kind shorthand. Mirror of {@link DuckDbStore.listNodesByKind}. */
  async listNodesByKind<K extends NodeKind>(
    kind: K,
    opts: ListNodesByKindOptions = {},
  ): Promise<readonly NodeOfKind<K>[]> {
    const pool = this.requirePool();
    const limit = clampNonNegativeIntGd(opts.limit);
    const offset = clampNonNegativeIntGd(opts.offset);
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");

    const wheres: string[] = ["n.kind = $p1"];
    const params: SqlParam[] = [kind];
    let next = 2;
    if (opts.filePath !== undefined) {
      wheres.push(`n.file_path = $p${next}`);
      params.push(opts.filePath);
      next += 1;
    }
    if (opts.filePathLike !== undefined) {
      wheres.push(`n.file_path CONTAINS $p${next}`);
      params.push(opts.filePathLike);
      next += 1;
    }
    let pagination = "";
    if (offset !== undefined) pagination += `SKIP ${offset} `;
    if (limit !== undefined) pagination += `LIMIT ${limit} `;
    const cypher = (
      `MATCH (n:CodeNode) WHERE ${wheres.join(" AND ")} ` +
      `RETURN ${returnList} ORDER BY n.id ASC ${pagination}`
    ).trim();

    const rows = await pool.query(cypher, params);
    const out: GraphNode[] = [];
    for (const row of rows) {
      const node = recordToGraphNode(row as Record<string, unknown>);
      if (node) out.push(node);
    }
    const sorted = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return sorted as unknown as readonly NodeOfKind<K>[];
  }

  /** All edges, optionally filtered + paged. Mirrors DuckDb ordering. */
  async listEdges(opts: ListEdgesOptions = {}): Promise<readonly CodeRelation[]> {
    const pool = this.requirePool();
    return this.listEdgesInternalGd(pool, opts);
  }

  /** Single-type shorthand. Pins the type and forwards to {@link listEdges}. */
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

  /** Findings filter. Mirrors {@link DuckDbStore.listFindings} on Cypher. */
  async listFindings(opts: ListFindingsOptions = {}): Promise<readonly FindingNode[]> {
    const pool = this.requirePool();
    const wheres: string[] = ["n.kind = 'Finding'"];
    const params: SqlParam[] = [];
    let next = 1;
    if (opts.severity && opts.severity.length > 0) {
      const phs: string[] = [];
      for (const s of opts.severity) {
        phs.push(`$p${next}`);
        params.push(s);
        next += 1;
      }
      wheres.push(`n.severity IN [${phs.join(", ")}]`);
    }
    if (opts.ruleId !== undefined) {
      wheres.push(`n.rule_id = $p${next}`);
      params.push(opts.ruleId);
      next += 1;
    }
    if (opts.baselineState && opts.baselineState.length > 0) {
      const phs: string[] = [];
      for (const s of opts.baselineState) {
        phs.push(`$p${next}`);
        params.push(s);
        next += 1;
      }
      wheres.push(`n.baseline_state IN [${phs.join(", ")}]`);
    }
    if (opts.suppressed === true) {
      wheres.push("n.suppressed_json IS NOT NULL");
    } else if (opts.suppressed === false) {
      wheres.push("n.suppressed_json IS NULL");
    }
    const limit = clampNonNegativeIntGd(opts.limit);
    const limitClause = limit !== undefined ? `LIMIT ${limit} ` : "";
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");
    const cypher = (
      `MATCH (n:CodeNode) WHERE ${wheres.join(" AND ")} ` +
      `RETURN ${returnList} ORDER BY n.id ASC ${limitClause}`
    ).trim();
    const rows = await pool.query(cypher, params);
    const out: FindingNode[] = [];
    for (const row of rows) {
      const node = recordToGraphNode(row as Record<string, unknown>);
      if (node && node.kind === "Finding") out.push(node as FindingNode);
    }
    return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Dependencies filter. License classification matches DuckDb. */
  async listDependencies(opts: ListDependenciesOptions = {}): Promise<readonly DependencyNode[]> {
    const pool = this.requirePool();
    const wheres: string[] = ["n.kind = 'Dependency'"];
    const params: SqlParam[] = [];
    let next = 1;
    if (opts.ecosystem !== undefined) {
      wheres.push(`n.ecosystem = $p${next}`);
      params.push(opts.ecosystem);
      next += 1;
    }
    const limit = clampNonNegativeIntGd(opts.limit);
    const limitClause = limit !== undefined ? `LIMIT ${limit} ` : "";
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");
    const cypher = (
      `MATCH (n:CodeNode) WHERE ${wheres.join(" AND ")} ` +
      `RETURN ${returnList} ORDER BY n.id ASC ${limitClause}`
    ).trim();
    const rows = await pool.query(cypher, params);
    const tierSet =
      opts.licenseTier && opts.licenseTier.length > 0 ? new Set(opts.licenseTier) : undefined;
    const out: DependencyNode[] = [];
    for (const row of rows) {
      const node = recordToGraphNode(row as Record<string, unknown>);
      if (node?.kind !== "Dependency") continue;
      if (tierSet) {
        const tier = classifyLicenseTier((node as DependencyNode).license);
        if (!tierSet.has(tier)) continue;
      }
      out.push(node as DependencyNode);
    }
    return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Routes filter. Mirrors {@link DuckDbStore.listRoutes} on Cypher. */
  async listRoutes(opts: ListRoutesOptions = {}): Promise<readonly RouteNode[]> {
    const pool = this.requirePool();
    const wheres: string[] = ["n.kind = 'Route'"];
    const params: SqlParam[] = [];
    let next = 1;
    if (opts.methods && opts.methods.length > 0) {
      const phs: string[] = [];
      for (const m of opts.methods) {
        phs.push(`$p${next}`);
        params.push(m);
        next += 1;
      }
      wheres.push(`n.method IN [${phs.join(", ")}]`);
    }
    if (opts.pathLike !== undefined) {
      wheres.push(`n.url CONTAINS $p${next}`);
      params.push(opts.pathLike);
      next += 1;
    }
    const limit = clampNonNegativeIntGd(opts.limit);
    const limitClause = limit !== undefined ? `LIMIT ${limit} ` : "";
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");
    const cypher = (
      `MATCH (n:CodeNode) WHERE ${wheres.join(" AND ")} ` +
      `RETURN ${returnList} ORDER BY n.id ASC ${limitClause}`
    ).trim();
    const rows = await pool.query(cypher, params);
    const out: RouteNode[] = [];
    for (const row of rows) {
      const node = recordToGraphNode(row as Record<string, unknown>);
      if (node && node.kind === "Route") out.push(node as RouteNode);
    }
    return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Repo-node by id. Returns `undefined` when row is missing or non-Repo. */
  async getRepoNode(id: string): Promise<RepoNode | undefined> {
    const pool = this.requirePool();
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");
    const rows = await pool.query(
      `MATCH (n:CodeNode {id: $p1, kind: 'Repo'}) RETURN ${returnList} LIMIT 1`,
      [id],
    );
    const first = rows[0];
    if (!first) return undefined;
    const node = recordToGraphNode(first as Record<string, unknown>);
    if (node?.kind !== "Repo") return undefined;
    return node as RepoNode;
  }

  /**
   * Specialized finder for `analysis/impact.ts:131-135`. Cypher mirror of
   * the DuckDB `WHERE entry_point_id = ?` predicate; the property name is
   * the snake-cased column the writer emits via `nodeToParams`.
   */
  async listNodesByEntryPoint(entryPointId: string): Promise<readonly GraphNode[]> {
    const pool = this.requirePool();
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");
    const cypher = `MATCH (n:CodeNode) WHERE n.entry_point_id = $p1 RETURN ${returnList} ORDER BY n.id ASC`;
    const rows = await pool.query(cypher, [entryPointId]);
    const out: GraphNode[] = [];
    for (const row of rows) {
      const node = recordToGraphNode(row as Record<string, unknown>);
      if (node) out.push(node);
    }
    return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Specialized finder for `analysis/rename.ts:51,59` — `WHERE name = ?`
   * with optional `kinds` / `filePath` narrowing. Mirrors
   * {@link DuckDbStore.listNodesByName} exactly.
   */
  async listNodesByName(
    name: string,
    opts: ListNodesByNameOptions = {},
  ): Promise<readonly GraphNode[]> {
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length === 0) return [];
    const pool = this.requirePool();
    const limit = clampNonNegativeIntGd(opts.limit);
    const returnList = NODE_COLUMNS.map((c) => `n.${c} AS ${c}`).join(", ");
    const wheres: string[] = ["n.name = $p1"];
    const params: SqlParam[] = [name];
    let next = 2;
    if (kinds && kinds.length > 0) {
      const phs: string[] = [];
      for (const k of kinds) {
        phs.push(`$p${next}`);
        params.push(k);
        next += 1;
      }
      wheres.push(`n.kind IN [${phs.join(", ")}]`);
    }
    if (opts.filePath !== undefined) {
      wheres.push(`n.file_path = $p${next}`);
      params.push(opts.filePath);
      next += 1;
    }
    const limitClause = limit !== undefined ? `LIMIT ${limit} ` : "";
    const cypher = (
      `MATCH (n:CodeNode) WHERE ${wheres.join(" AND ")} ` +
      `RETURN ${returnList} ORDER BY n.id ASC ${limitClause}`
    ).trim();
    const rows = await pool.query(cypher, params);
    const out: GraphNode[] = [];
    for (const row of rows) {
      const node = recordToGraphNode(row as Record<string, unknown>);
      if (node) out.push(node);
    }
    return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Counts grouped by kind. Same backfill semantics as DuckDb. */
  async countNodesByKind(kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>> {
    const pool = this.requirePool();
    const out = new Map<NodeKind, number>();
    if (kinds !== undefined && kinds.length === 0) return out;
    const params: SqlParam[] = [];
    let predicate = "";
    if (kinds && kinds.length > 0) {
      const phs: string[] = [];
      for (let i = 0; i < kinds.length; i += 1) {
        phs.push(`$p${i + 1}`);
        params.push(kinds[i] ?? "");
      }
      predicate = `WHERE n.kind IN [${phs.join(", ")}] `;
    }
    const cypher = `MATCH (n:CodeNode) ${predicate}RETURN n.kind AS kind, count(n) AS n ORDER BY kind ASC`;
    const rows = await pool.query(cypher, params);
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const kindVal = row["kind"];
      const n = row["n"];
      if (typeof kindVal === "string") {
        const num = typeof n === "bigint" ? Number(n) : Number(n ?? 0);
        out.set(kindVal as NodeKind, num);
      }
    }
    if (kinds) {
      for (const k of kinds) {
        if (!out.has(k)) out.set(k, 0);
      }
    }
    return out;
  }

  /** Counts grouped by edge type. Walks every relation kind (no per-type rel-table fan-out). */
  async countEdgesByType(types?: readonly RelationType[]): Promise<Map<RelationType, number>> {
    const pool = this.requirePool();
    const out = new Map<RelationType, number>();
    if (types !== undefined && types.length === 0) return out;
    const allTypes: readonly RelationType[] =
      types && types.length > 0 ? types : (getAllRelationTypes() as readonly RelationType[]);
    // The graph-db schema partitions edges into per-type rel tables, so a
    // single MATCH across every label is the cheapest count path. We loop
    // per type and aggregate — N is bounded (~24) and one round-trip per
    // label is amortized against the rest of the query workload.
    for (const t of allTypes) {
      const rows = await pool.query(`MATCH ()-[r:${t}]->() RETURN count(r) AS n`);
      const first = rows[0] as Record<string, unknown> | undefined;
      const n = first?.["n"];
      const num = typeof n === "bigint" ? Number(n) : Number(n ?? 0);
      out.set(t, num);
    }
    return out;
  }

  /**
   * Stream embeddings via Cypher MATCH against the `Embedding` nodes.
   * `async function*` so the caller can `for await` without
   * materializing the full row set.
   */
  async *listEmbeddings(opts: ListEmbeddingsOptions = {}): AsyncIterable<EmbeddingRow> {
    const kinds = opts.kindFilter;
    if (kinds !== undefined && kinds.length === 0) return;
    const pool = this.requirePool();
    const limit = clampNonNegativeIntGd(opts.limit);

    const params: SqlParam[] = [];
    let next = 1;
    let matchAndPredicate = "MATCH (e:Embedding)";
    if (kinds && kinds.length > 0) {
      const phs: string[] = [];
      for (const k of kinds) {
        phs.push(`$p${next}`);
        params.push(k);
        next += 1;
      }
      matchAndPredicate = `MATCH (e:Embedding)-[:EMBEDS]->(n:CodeNode) WHERE n.kind IN [${phs.join(", ")}]`;
    }
    const limitClause = limit !== undefined ? `LIMIT ${limit}` : "";
    const cypher =
      `${matchAndPredicate} ` +
      `RETURN e.node_id AS node_id, e.granularity AS granularity, ` +
      `e.chunk_index AS chunk_index, e.start_line AS start_line, ` +
      `e.end_line AS end_line, e.vector AS vector, ` +
      `e.content_hash AS content_hash ` +
      `ORDER BY e.node_id ASC, e.granularity ASC, e.chunk_index ASC ${limitClause}`;
    const rows = await pool.query(cypher, params);
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const vec = row["vector"];
      let vector: Float32Array;
      if (vec instanceof Float32Array) vector = vec;
      else if (Array.isArray(vec)) vector = Float32Array.from(vec.map((v) => Number(v)));
      else continue;
      const granularityRaw = String(row["granularity"]);
      const granularity =
        granularityRaw === "file" || granularityRaw === "community" ? granularityRaw : "symbol";
      const chunkVal = row["chunk_index"];
      const chunkIndex = typeof chunkVal === "bigint" ? Number(chunkVal) : Number(chunkVal ?? 0);
      const startVal = row["start_line"];
      const endVal = row["end_line"];
      const baseRow: EmbeddingRow = {
        nodeId: String(row["node_id"]),
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
  }

  /** Ancestor traversal via a Cypher variable-length upward walk (the lbug analogue of a recursive ancestor query). */
  async traverseAncestors(opts: AncestorTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.traverseDirectionalGd(opts, "up");
  }

  /** Symmetric of {@link traverseAncestors}. */
  async traverseDescendants(opts: DescendantTraversalOptions): Promise<readonly TraverseResult[]> {
    return this.traverseDirectionalGd(opts, "down");
  }

  /**
   * Producer-consumer edges across repos. Cypher mirror of the DuckDB
   * FETCHES + Operation join. The graph-db schema collapses every node
   * kind into a single `:CodeNode` label, so this is a simple two-hop
   * pattern with property predicates rather than a true table join.
   */
  async listConsumerProducerEdges(
    opts: { readonly repoUris?: readonly string[] } = {},
  ): Promise<readonly ConsumerProducerEdge[]> {
    const pool = this.requirePool();
    const params: SqlParam[] = [];
    let next = 1;
    let repoPredicate = "";
    if (opts.repoUris && opts.repoUris.length > 0) {
      const phs: string[] = [];
      for (const u of opts.repoUris) {
        phs.push(`$p${next}`);
        params.push(u);
        next += 1;
      }
      repoPredicate = ` AND (consumer.repo_uri IN [${phs.join(", ")}] OR producer.repo_uri IN [${phs.join(", ")}])`;
    }
    const cypher =
      `MATCH (consumer:CodeNode)-[r:FETCHES]->(producer:CodeNode) ` +
      `WHERE producer.kind = 'Operation'${repoPredicate} ` +
      `RETURN consumer.id AS consumer_node_id, ` +
      `consumer.repo_uri AS consumer_repo_uri, ` +
      `producer.id AS producer_node_id, ` +
      `producer.repo_uri AS producer_repo_uri, ` +
      `producer.http_method AS http_method, ` +
      `producer.http_path AS http_path, ` +
      `r.id AS r_id ` +
      `ORDER BY consumer_repo_uri ASC, producer_repo_uri ASC, ` +
      `http_method ASC, http_path ASC, r_id ASC`;
    const rows = await pool.query(cypher, params);
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
  }

  /**
   * Shared `listEdges` body. The graph-db schema partitions edges into
   * per-type rel tables, so a no-types query needs to walk every label —
   * we fall back to the canonical relation list and emit one MATCH per
   * type, then merge + sort. With a `types` filter the pattern is one
   * MATCH per requested type, which keeps the round-trip cost
   * proportional to the filter set.
   */
  private async listEdgesInternalGd(
    pool: GraphDbPool,
    opts: ListEdgesOptions,
  ): Promise<readonly CodeRelation[]> {
    const allTypes: readonly RelationType[] =
      opts.types && opts.types.length > 0
        ? opts.types
        : (getAllRelationTypes() as readonly RelationType[]);
    const minConfidence = opts.minConfidence;
    const limit = clampNonNegativeIntGd(opts.limit);
    const offset = clampNonNegativeIntGd(opts.offset);

    const collected: CodeRelation[] = [];
    for (const t of allTypes) {
      const params: SqlParam[] = [];
      let next = 1;
      const wheres: string[] = [];
      if (opts.fromIds && opts.fromIds.length > 0) {
        const phs: string[] = [];
        for (const f of opts.fromIds) {
          phs.push(`$p${next}`);
          params.push(f);
          next += 1;
        }
        wheres.push(`a.id IN [${phs.join(", ")}]`);
      }
      if (opts.toIds && opts.toIds.length > 0) {
        const phs: string[] = [];
        for (const id of opts.toIds) {
          phs.push(`$p${next}`);
          params.push(id);
          next += 1;
        }
        wheres.push(`b.id IN [${phs.join(", ")}]`);
      }
      if (minConfidence !== undefined) {
        wheres.push(`r.confidence >= $p${next}`);
        params.push(minConfidence);
        next += 1;
      }
      const wherePart = wheres.length > 0 ? ` WHERE ${wheres.join(" AND ")}` : "";
      const cypher =
        `MATCH (a:CodeNode)-[r:${t}]->(b:CodeNode)${wherePart} ` +
        `RETURN a.id AS from_id, b.id AS to_id, r.id AS r_id, ` +
        `r.confidence AS confidence, r.reason AS reason, r.step AS step`;
      const rows = await pool.query(cypher, params);
      for (const row of rows) {
        const rec = row as Record<string, unknown>;
        const stepVal = rec["step"];
        const step = stepVal === null || stepVal === undefined ? undefined : Number(stepVal);
        const reasonVal = rec["reason"];
        const reason =
          typeof reasonVal === "string" && reasonVal.length > 0 ? reasonVal : undefined;
        collected.push({
          id: String(rec["r_id"] ?? "") as CodeRelation["id"],
          from: String(rec["from_id"] ?? "") as CodeRelation["from"],
          to: String(rec["to_id"] ?? "") as CodeRelation["to"],
          type: t,
          confidence: Number(rec["confidence"] ?? 0),
          ...(reason !== undefined ? { reason } : {}),
          ...(step !== undefined && step !== 0 ? { step } : {}),
        });
      }
    }
    // Final ordering: (from, to, type, id) — same key order DuckDb uses.
    collected.sort((x, y) => {
      if (x.from !== y.from) return x.from < y.from ? -1 : 1;
      if (x.to !== y.to) return x.to < y.to ? -1 : 1;
      if (x.type !== y.type) return x.type < y.type ? -1 : 1;
      if (x.id !== y.id) return x.id < y.id ? -1 : 1;
      return 0;
    });
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : collected.length;
    return collected.slice(start, end);
  }

  /**
   * Shared body for ancestor/descendant traversal. Defers to the existing
   * {@link traverse} method which handles the variable-length pattern
   * inlining for the native graph-db engine.
   */
  private async traverseDirectionalGd(
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
        `m.cache_size_bytes AS cache_size_bytes, m.last_compaction AS last_compaction, ` +
        `m.embedder_model_id AS embedder_model_id ` +
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
    const embedderModelId = row["embedder_model_id"];
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
      ...(embedderModelId !== null && embedderModelId !== undefined
        ? { embedderModelId: String(embedderModelId) }
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
        `m.cache_hit_ratio = $p7, m.cache_size_bytes = $p8, m.last_compaction = $p9, ` +
        `m.embedder_model_id = $p10`,
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
        meta.embedderModelId ?? null,
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
  // execCypher — IGraphStore optional escape hatch
  // --------------------------------------------------------------------------

  /**
   * {@link IGraphStore.execCypher} implementation. Delegates to the
   * pre-existing {@link query} method which already enforces read-only
   * Cypher via {@link assertReadOnlyCypher}.
   *
   * OCH core never calls this — it exists so community tooling that
   * needs raw Cypher (e.g. APOC analogues on a Neo4j adapter fork) can
   * route through `OpenStoreResult.graph.execCypher(...)`. The signature
   * accepts a `Record<string, unknown>` params bag (Cypher's bound-name
   * model) rather than the positional `SqlParam[]` shape the legacy
   * `query` method takes.
   */
  async execCypher(
    statement: string,
    params: Record<string, unknown> = {},
  ): Promise<readonly Record<string, unknown>[]> {
    if (!this.pool) {
      throw new Error("graph-db: execCypher called before open()");
    }
    assertReadOnlyCypher(statement);
    // Lower-cast to readonly SqlParam[] expected by the existing pool API.
    // The pool driver accepts a record of named params or a positional list;
    // we forward a positional list extracted from the values for now.
    const positional: SqlParam[] = [];
    for (const v of Object.values(params)) {
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        typeof v === "bigint"
      ) {
        positional.push(v as SqlParam);
      } else {
        positional.push(JSON.stringify(v));
      }
    }
    return this.pool.query(statement, positional, { timeoutMs: this.defaultTimeoutMs });
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
    // Read-only opens cannot run `CALL CREATE_FTS_INDEX` (lbug rejects
    // writes against a readOnly Database). The index is built at
    // bulk-load time on the write path; readers just query it.
    if (this.readOnly) {
      this.ftsIndexBuilt = true;
      return;
    }
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
    if (this.readOnly) {
      this.vectorIndexBuilt = true;
      return;
    }
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
  // lbug v0.16.1 collapses an empty `STRING[]` to SQL NULL on write, so an
  // absent column and an empty `[]` one both read back as `null`. The writer
  // ({@link encodeNodeCol}) disambiguates them: a genuinely empty array is
  // stored as a single-element marker, while an absent field is stored as
  // `[]` (→ NULL). Here we invert that:
  //   - null / non-array  → absent: omit the key entirely.
  //   - [marker]          → explicit empty array: set `[]`.
  //   - any other array   → reconstruct the string elements verbatim.
  // This keeps `{keywords: []}` byte-identical under `graphHash` to the
  // canonical-JSON projection it was built from, distinct from `{}`.
  if (!Array.isArray(v)) return;
  if (v.length === 1 && v[0] === EMPTY_STRING_ARRAY_MARKER) {
    out[key] = [];
    return;
  }
  const arr: string[] = [];
  for (const item of v) if (typeof item === "string") arr.push(item);
  out[key] = arr;
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
