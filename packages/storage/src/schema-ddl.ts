/**
 * DDL emitter for the SQLite-backed temporal store.
 *
 * Two tables only:
 *   - `cochanges` — file-level association statistics from git history.
 *   - `symbol_summaries` — structured per-symbol summaries from the
 *     ingestion summarize phase, keyed by
 *     `(node_id, content_hash, prompt_version)`.
 *
 * The graph tier (nodes/edges/embeddings/store_meta) lives in the lbug
 * graph artifact; this DDL is intentionally narrow.
 */

export interface SchemaOptions {
  /**
   * Retained for API symmetry with the prior multi-tier schema; the
   * temporal-only DDL never references it. Callers that supply it pay
   * one validation check; omitting it is also accepted.
   */
  readonly embeddingDim?: number;
}

/**
 * Returns a sequence of DDL statements that must be executed in order.
 */
export function generateSchemaDDL(_opts: SchemaOptions = {}): readonly string[] {
  return [
    // File-level co-change table. The signal is statistical (not deterministic),
    // file-granular, and rewrites on every commit.
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
    // in the graph edge set. `structured_json` carries the validated
    // structured payload (citations + side_effects + invariants + per-input
    // descriptions + returns.details) as a canonical-JSON blob so the
    // citation-grounded fields the summarizer validates survive ingestion
    // instead of being discarded after `summaryText` / `signatureSummary` /
    // `returnsTypeSummary` are extracted. NULL when the producing prompt
    // emitted no structured payload (e.g. a pre-structured-summaries row).
    `CREATE TABLE IF NOT EXISTS symbol_summaries (
      node_id              TEXT NOT NULL,
      content_hash         TEXT NOT NULL,
      prompt_version       TEXT NOT NULL,
      model_id             TEXT NOT NULL,
      summary_text         TEXT NOT NULL,
      signature_summary    TEXT,
      returns_type_summary TEXT,
      structured_json      TEXT,
      created_at           TIMESTAMP NOT NULL,
      PRIMARY KEY (node_id, content_hash, prompt_version)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_summaries_node ON symbol_summaries (node_id)`,
  ];
}
