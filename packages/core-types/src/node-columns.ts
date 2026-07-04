/**
 * Canonical column rosters for the polymorphic graph store — pure,
 * dependency-free.
 *
 * These two lists are the SINGLE SOURCE OF TRUTH for the logical field
 * vocabulary of the graph. They live in `@opencodehub/core-types` (the
 * deepest, zero-runtime-dep package) so every downstream consumer stays in
 * lock-step:
 *   - `@opencodehub/storage` re-exports {@link NODE_COLUMNS} from
 *     `column-encode.ts` as the encoder's canonical field ordering, which a
 *     community-fork `IGraphStore` adapter (AGE / Memgraph / Neo4j / Neptune)
 *     consumes when it stores the universal base as typed columns.
 *   - `@opencodehub/mcp` advertises both lists in the
 *     `codehub://repo/{name}/schema` resource so SQL-authoring agents see the
 *     full logical field vocabulary they may filter on.
 *
 * Keeping one copy here fixes the staleness class where a hand-maintained
 * duplicate silently truncated the advertised roster.
 */

/**
 * Canonical field ordering for the polymorphic `nodes` table (73 entries).
 * The shared reference a community-fork adapter (AGE / Memgraph / Neo4j /
 * Neptune) consumes when it stores the universal base as typed columns.
 *
 * The in-tree `SqliteStore` (ADR 0019) stores only the universal base
 * (`id, kind, name, file_path, start_line, end_line`) as typed columns and
 * folds every remaining kind-specific field into a single canonical-JSON
 * `payload` column, so adding a kind-specific field needs NO schema change
 * there — it round-trips through `payload` automatically. The `[]`-vs-absent
 * and `{}`-vs-absent distinctions are preserved by `canonicalJson` over
 * `payload`, not by per-column encoding.
 *
 * Rules for a fork that DOES store a new field as a typed column:
 *   1. Append to the END of this list — reordering rewrites every prepared
 *      statement parameter slot and breaks already-persisted graphs.
 *   2. Append the writer in `nodeToColumns` (`@opencodehub/storage`).
 *   3. Append the reader in the adapter's row decoder.
 *   4. Update that adapter's CREATE TABLE DDL to keep the on-disk schema in
 *      lock step with this list.
 *
 * ORDER IS APPEND-ONLY AND LOAD-BEARING — never reorder.
 */
export const NODE_COLUMNS: readonly string[] = [
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
  // v1.2 extensions (append-only).
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
  // Repo.
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

/**
 * Logical column roster for the polymorphic `relations` (edges) table
 * (7 entries) as advertised to SQL-authoring agents.
 *
 * These are LOGICAL names. The physical SQLite DDL names the endpoint columns
 * `src`/`dst`, but the advertised/logical roster uses `from_id`/`to_id` — do
 * not "fix" these to `src`/`dst`; that would change the schema resource's
 * advertised output and break the honest logical vocabulary.
 */
export const RELATION_COLUMNS: readonly string[] = [
  "id",
  "from_id",
  "to_id",
  "type",
  "confidence",
  "reason",
  "step",
];
