/**
 * DDL emitter for the DuckDB-backed graph store.
 *
 * Every node kind collapses into a single polymorphic `nodes` table. Kinds
 * that don't populate a column leave it NULL — the cost is a few NULL slots
 * per row in exchange for avoiding 31 near-identical CREATE TABLE statements
 * and 31 different SELECT paths in the reader. Relations live in `relations`
 * with a `type` discriminator. Embeddings live in a separate `embeddings`
 * table whose vector column is a FIXED-SIZE FLOAT array of the dimension
 * configured at construction time.
 */

export interface SchemaOptions {
  /** Dimension for the fixed-size FLOAT array used by the embeddings column. */
  readonly embeddingDim: number;
}

/**
 * Returns a sequence of DDL statements that must be executed in order. The
 * adapter runs them one-at-a-time so it can also run `INSTALL`/`LOAD` calls
 * interleaved at the right moments.
 */
export function generateSchemaDDL(opts: SchemaOptions): readonly string[] {
  if (!Number.isInteger(opts.embeddingDim) || opts.embeddingDim <= 0) {
    throw new Error(`Invalid embeddingDim: ${opts.embeddingDim}`);
  }
  const dim = opts.embeddingDim;

  return [
    `CREATE TABLE IF NOT EXISTS nodes (
      id                   TEXT PRIMARY KEY,
      kind                 TEXT NOT NULL,
      name                 TEXT NOT NULL,
      file_path            TEXT NOT NULL,
      start_line           INTEGER,
      end_line             INTEGER,
      is_exported          BOOLEAN,
      signature            TEXT,
      parameter_count      INTEGER,
      return_type          TEXT,
      declared_type        TEXT,
      owner                TEXT,
      url                  TEXT,
      method               TEXT,
      tool_name            TEXT,
      content              TEXT,
      content_hash         TEXT,
      inferred_label       TEXT,
      symbol_count         INTEGER,
      cohesion             DOUBLE,
      keywords             TEXT[],
      entry_point_id       TEXT,
      step_count           INTEGER,
      level                INTEGER,
      response_keys        TEXT[],
      description          TEXT,
      -- Finding (SARIF)
      severity             TEXT,
      rule_id              TEXT,
      scanner_id           TEXT,
      message              TEXT,
      properties_bag       TEXT,
      -- Dependency (SBOM / manifest)
      version              TEXT,
      license              TEXT,
      lockfile_source      TEXT,
      ecosystem            TEXT,
      -- Operation (OpenAPI)
      http_method          TEXT,
      http_path            TEXT,
      summary              TEXT,
      operation_id         TEXT,
      -- Contributor (git blame)
      email_hash           TEXT,
      email_plain          TEXT,
      -- ProjectProfile
      languages_json       TEXT,
      frameworks_json      TEXT,
      iac_types_json       TEXT,
      api_contracts_json   TEXT,
      manifests_json       TEXT,
      src_dirs_json        TEXT,
      -- File ownership (H.5) and Community ownership (H.4)
      orphan_grade         TEXT,
      is_orphan            BOOLEAN,
      truck_factor         INTEGER,
      ownership_drift_30d  DOUBLE,
      ownership_drift_90d  DOUBLE,
      ownership_drift_365d DOUBLE,
      -- v1.2 extensions (append-only: preserves load-bearing column order).
      -- dead-code phase: deadness. coverage phase: coverage_percent and
      -- covered_lines_json. complexity phase: cyclomatic_complexity,
      -- nesting_depth, nloc, halstead_volume. tools phase:
      -- input_schema_json. SARIF ingest: partial_fingerprint,
      -- baseline_state, suppressed_json.
      deadness             TEXT,
      coverage_percent     DOUBLE,
      covered_lines_json   TEXT,
      cyclomatic_complexity INTEGER,
      nesting_depth        INTEGER,
      nloc                 INTEGER,
      halstead_volume      DOUBLE,
      input_schema_json    TEXT,
      partial_fingerprint  TEXT,
      baseline_state       TEXT,
      suppressed_json      TEXT
    )`,

    `CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes (kind)`,
    `CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes (file_path)`,
    `CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes (name)`,

    `CREATE TABLE IF NOT EXISTS relations (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL,
      to_id       TEXT NOT NULL,
      type        TEXT NOT NULL,
      confidence  DOUBLE NOT NULL,
      reason      TEXT,
      step        INTEGER NOT NULL DEFAULT 0
    )`,

    `CREATE INDEX IF NOT EXISTS idx_relations_from ON relations (from_id)`,
    `CREATE INDEX IF NOT EXISTS idx_relations_to ON relations (to_id)`,
    `CREATE INDEX IF NOT EXISTS idx_relations_type ON relations (type)`,
    `CREATE INDEX IF NOT EXISTS idx_relations_confidence ON relations (confidence)`,

    // `granularity` discriminates hierarchical embedding tiers (P03): rows at
    // 'symbol' granularity mirror the v1.0 behaviour; 'file' and 'community'
    // tiers are additive. The DEFAULT clause backfills legacy v1.0 rows to
    // 'symbol' when a v1.2 reader opens an older file — no re-index required.
    // A single HNSW index covers the column; filter-aware traversal via
    // `hnsw_acorn` push-down keeps one index serving all three tiers.
    `CREATE TABLE IF NOT EXISTS embeddings (
      id            TEXT PRIMARY KEY,
      node_id       TEXT NOT NULL,
      granularity   TEXT NOT NULL DEFAULT 'symbol',
      chunk_index   INTEGER NOT NULL,
      start_line    INTEGER,
      end_line      INTEGER,
      vector        FLOAT[${dim}] NOT NULL,
      content_hash  TEXT NOT NULL
    )`,

    // In-place migration: older DuckDB files that were created against the
    // v1.0 schema lack the `granularity` column entirely. DuckDB rejects
    // ADD COLUMN … NOT NULL (see DuckDB "Parser Error: Adding columns with
    // constraints not yet supported"), so we add it nullable with a
    // DEFAULT, then fill rows where the column is NULL. On a fresh index
    // the CREATE TABLE above already shipped the column — this pair of
    // statements is a cheap no-op in that case.
    `ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS granularity TEXT DEFAULT 'symbol'`,
    `UPDATE embeddings SET granularity = 'symbol' WHERE granularity IS NULL`,

    `CREATE INDEX IF NOT EXISTS idx_embeddings_node ON embeddings (node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings (content_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_embeddings_granularity ON embeddings (granularity)`,

    `CREATE TABLE IF NOT EXISTS store_meta (
      id                INTEGER PRIMARY KEY,
      schema_version    TEXT NOT NULL,
      last_commit       TEXT,
      indexed_at        TEXT NOT NULL,
      node_count        INTEGER NOT NULL,
      edge_count        INTEGER NOT NULL,
      stats_json        TEXT,
      cache_hit_ratio   DOUBLE,
      cache_size_bytes  BIGINT,
      last_compaction   TEXT
    )`,

    // File-level co-change table. Separate from `relations` because the signal
    // is statistical (not deterministic), file-granular, and rewrites on every
    // commit; stretching it across the symbol-level graph inflated edge counts
    // by ~5x on real repos and swamped impact traversals with noise.
    `CREATE TABLE IF NOT EXISTS cochanges (
      source_file            TEXT NOT NULL,
      target_file            TEXT NOT NULL,
      cocommit_count         INTEGER NOT NULL,
      total_commits_source   INTEGER NOT NULL,
      total_commits_target   INTEGER NOT NULL,
      last_cocommit_at       TIMESTAMP NOT NULL,
      lift                   DOUBLE NOT NULL,
      PRIMARY KEY (source_file, target_file)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_cochanges_source ON cochanges (source_file)`,
    `CREATE INDEX IF NOT EXISTS idx_cochanges_target ON cochanges (target_file)`,

    // Symbol-level structured summaries. Keyed by (node_id, content_hash,
    // prompt_version) so prompt iteration and source-text drift don't
    // collide. Summaries are side-channel content — they do NOT participate
    // in the graph edge set. Separate from `embeddings` because summaries
    // and their embeddings are fused at query time, not at write time.
    `CREATE TABLE IF NOT EXISTS symbol_summaries (
      node_id              TEXT NOT NULL,
      content_hash         TEXT NOT NULL,
      prompt_version       TEXT NOT NULL,
      model_id             TEXT NOT NULL,
      summary_text         TEXT NOT NULL,
      signature_summary    TEXT,
      returns_type_summary TEXT,
      created_at           TIMESTAMP NOT NULL,
      PRIMARY KEY (node_id, content_hash, prompt_version)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_summaries_node ON symbol_summaries (node_id)`,
  ];
}
