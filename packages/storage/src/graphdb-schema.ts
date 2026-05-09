/**
 * DDL translator for the graph-database backend.
 *
 * Emits Cypher `CREATE NODE TABLE` + `CREATE REL TABLE` statements that
 * mirror the semantic shape of the DuckDB schema ({@link generateSchemaDDL})
 * while honouring two architectural decisions from spec 004:
 *
 *   1. **Polymorphic rel tables, one per edge kind.** Each OCH relation
 *      kind (24 live in `duckdb-adapter.ts:ALL_RELATION_TYPES` at the time
 *      of writing — the v1.1 schema added `OWNED_BY` / `DEPENDS_ON` /
 *      `FOUND_IN` past the spec 004 draft's "23 kinds" count) gets its own
 *      named REL TABLE with multiple `FROM/TO` pairs. A single
 *      `CodeRelation` table with a `type` discriminator column would
 *      defeat columnar predicate push-down, so we fan out to keep the
 *      planner honest. See the graph-db backend's
 *      `cypher/data-definition/create-table` doc page.
 *
 *   2. **Source-level naming avoids banned clean-room literals.** OCH
 *      uses `PROCESS_STEP` where a prior-art project used a different
 *      identifier; this translator only ever emits `PROCESS_STEP` so
 *      Cypher queries match the graph's own relation-type enum.
 *
 * The DuckDB schema collapses every node kind into a polymorphic `nodes`
 * table (`schema-ddl.ts`). For the graph-db backend we keep the same
 * collapse — a single `CodeNode` NODE TABLE — so graphHash parity (U1) is
 * straightforward: round-trips read the same column set from both stores.
 * Later ACs may split the table per kind once profile data justifies the
 * extra surface area.
 */

export interface GraphDbSchemaOptions {
  /** Dimension for the fixed-size FLOAT array used by the embedding rel. */
  readonly embeddingDim?: number;
}

const DEFAULT_EMBEDDING_DIM = 768;

/**
 * 23 edge kinds taken verbatim from `duckdb-adapter.ts` `ALL_RELATION_TYPES`
 * (re-exported via `getAllRelationTypes()` below so this file stays
 * self-contained without a circular-import risk on the adapter module). The
 * ordering is load-bearing for commit diffs — append new kinds, never
 * reorder.
 */
const RELATION_KINDS: readonly string[] = [
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
  "TYPE_OF",
];

/**
 * Exported for the round-trip parity tests so they can compare against
 * the same source of truth as the DDL emitter.
 */
export function getAllRelationTypes(): readonly string[] {
  return RELATION_KINDS;
}

/**
 * Returns the complete Cypher DDL as a single string — statements separated
 * by `;` so callers can split on that boundary if they need per-statement
 * execution. The last statement carries a trailing `;` for symmetry.
 */
export function generateSchemaDdl(opts: GraphDbSchemaOptions = {}): string {
  const embeddingDim = opts.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    throw new Error(`Invalid embeddingDim: ${String(embeddingDim)}`);
  }

  const statements: string[] = [];

  // -------------------------------------------------------------------------
  // Node tables. CodeNode collapses every kind (File / Folder / Function /
  // Class / Interface / Method / CodeElement / Community / Process / Route /
  // Tool / Section / Finding / Dependency / Operation / Contributor /
  // ProjectProfile / Repo) behind a `kind` discriminator, mirroring the
  // DuckDB `nodes` table. Embeddings live in their own NODE TABLE so the
  // vector column stays homogeneous and an HNSW index can attach.
  // -------------------------------------------------------------------------
  statements.push(`CREATE NODE TABLE IF NOT EXISTS CodeNode (
  id STRING,
  kind STRING,
  name STRING,
  file_path STRING,
  start_line INT32,
  end_line INT32,
  is_exported BOOL,
  signature STRING,
  parameter_count INT32,
  return_type STRING,
  declared_type STRING,
  owner STRING,
  url STRING,
  method STRING,
  tool_name STRING,
  content STRING,
  content_hash STRING,
  inferred_label STRING,
  symbol_count INT32,
  cohesion DOUBLE,
  keywords STRING[],
  entry_point_id STRING,
  step_count INT32,
  level INT32,
  response_keys STRING[],
  description STRING,
  severity STRING,
  rule_id STRING,
  scanner_id STRING,
  message STRING,
  properties_bag STRING,
  version STRING,
  license STRING,
  lockfile_source STRING,
  ecosystem STRING,
  http_method STRING,
  http_path STRING,
  summary STRING,
  operation_id STRING,
  email_hash STRING,
  email_plain STRING,
  languages_json STRING,
  frameworks_json STRING,
  iac_types_json STRING,
  api_contracts_json STRING,
  manifests_json STRING,
  src_dirs_json STRING,
  orphan_grade STRING,
  is_orphan BOOL,
  truck_factor INT32,
  ownership_drift_30d DOUBLE,
  ownership_drift_90d DOUBLE,
  ownership_drift_365d DOUBLE,
  deadness STRING,
  coverage_percent DOUBLE,
  covered_lines_json STRING,
  cyclomatic_complexity INT32,
  nesting_depth INT32,
  nloc INT32,
  halstead_volume DOUBLE,
  input_schema_json STRING,
  partial_fingerprint STRING,
  baseline_state STRING,
  suppressed_json STRING,
  origin_url STRING,
  repo_uri STRING,
  default_branch STRING,
  commit_sha STRING,
  index_time STRING,
  repo_group STRING,
  visibility STRING,
  indexer STRING,
  language_stats_json STRING,
  PRIMARY KEY (id)
)`);

  statements.push(`CREATE NODE TABLE IF NOT EXISTS Embedding (
  id STRING,
  node_id STRING,
  granularity STRING,
  chunk_index INT32,
  start_line INT32,
  end_line INT32,
  vector FLOAT[${embeddingDim}],
  content_hash STRING,
  PRIMARY KEY (id)
)`);

  statements.push(`CREATE NODE TABLE IF NOT EXISTS StoreMeta (
  id INT32,
  schema_version STRING,
  last_commit STRING,
  indexed_at STRING,
  node_count INT64,
  edge_count INT64,
  stats_json STRING,
  cache_hit_ratio DOUBLE,
  cache_size_bytes INT64,
  last_compaction STRING,
  embedder_model_id STRING,
  PRIMARY KEY (id)
)`);

  // Cochange + SymbolSummary live exclusively on the paired DuckDB-backed
  // ITemporalStore — the graph adapter never stores those rows, so the
  // Cypher schema does not declare them.
  // -------------------------------------------------------------------------
  // Rel tables — one per edge kind. FROM/TO is CodeNode on both sides;
  // a future schema revision may narrow the endpoints per kind once the
  // node-kind split lands. We DO NOT emit a single CodeRelation rel
  // table with a type column — that defeats the predicate push-down the
  // graph-db gives us.
  // -------------------------------------------------------------------------
  for (const kind of RELATION_KINDS) {
    statements.push(`CREATE REL TABLE IF NOT EXISTS ${kind} (
  FROM CodeNode TO CodeNode,
  id STRING,
  confidence DOUBLE,
  reason STRING,
  step INT32
)`);
  }

  // Dedicated rel linking Embedding rows to their CodeNode source, so HNSW
  // traversals can join back through the graph without a property lookup.
  statements.push(`CREATE REL TABLE IF NOT EXISTS EMBEDS (
  FROM Embedding TO CodeNode
)`);

  return `${statements.join(";\n\n")};\n`;
}
