/**
 * Shared column-encoder helpers for the polymorphic CodeNode table.
 *
 * `GraphDbStore` (`./graphdb-adapter.ts`, lbug) is the in-tree
 * {@link IGraphStore} writer: it emits a 73-column row per node where every
 * column matches the canonical {@link NODE_COLUMNS} order. These are the
 * canonical encode helpers for that contract, kept here (rather than inline
 * in the adapter) so a community `IGraphStore` adapter (AGE / Memgraph /
 * Neo4j / Neptune) can consume the identical implementation and stay
 * byte-identical under `graphHash`. (`DuckDbStore` is
 * {@link ITemporalStore}-only post-ADR-0016 and does NOT write CodeNode
 * rows; before the rip-out both adapters shared these helpers.)
 *
 * The module is `internal-only` — it is NOT re-exported from
 * `packages/storage/src/index.ts`. Adapters import directly from
 * `./column-encode.js`.
 *
 * Three sentinel rules also live here, promoted from
 * `graph-hash-parity.test.ts`:
 *
 *   - {@link stepZeroSentinel}: the DuckDB `relations.step` column is
 *     `INTEGER NOT NULL DEFAULT 0`; the graph-db column is nullable `INT32`.
 *     Both backends agree on dropping `step` when the stored value reads back
 *     as zero/null so the round-trip is byte-identical.
 *   - {@link coerceLanguageStats}: `RepoNode.languageStats = {}` is coerced
 *     to SQL NULL on write and re-added as `{}` on read so the canonical-JSON
 *     hash is stable across "absent" vs "explicitly empty".
 *   - {@link applyRepoNullables}: `RepoNode.originUrl/defaultBranch/group`
 *     are `string | null` on the interface, never `string | undefined`. When
 *     reading a Repo row whose column is NULL, re-attach the field as
 *     explicit `null` so canonical-JSON parity holds.
 *
 * Plus the deadness normalization {@link normalizeDeadness}:
 *   - `unreachable-export → unreachable_export` on write, reverse on read
 *     (the write side is exported here; the read side stays in each adapter
 *     because it's symmetric with the per-adapter row decoder).
 *
 * **`stringArrayOrNull` round-trip note** — an explicit empty `[]` and an
 * absent field are kept distinct on the wire. {@link stringArrayOrNull}
 * returns a typed 0-length array for an empty-array input and `null` for a
 * non-array input. The lbug graph adapter preserves the distinction with a
 * version-agnostic marker scheme (`encodeNodeCol` + `setStringArrayFieldGd`
 * in graphdb-adapter.ts):
 *   - an explicit empty array is written as a single-element marker and
 *     decoded back to `[]` on read;
 *   - an absent field is written as a bare `[]`, which decodes as absent —
 *     whether lbug stored it as SQL NULL (≤ v0.16.1, where a 0-length
 *     `STRING[]` collapsed to NULL on write) or as a typed empty `STRING[]`
 *     (≥ v0.17.0, PR #471, where empty lists round-trip).
 * A SQL-backed community adapter with a native array column (e.g. DuckDB
 * `TEXT[]`) can instead store the 0-length literal directly; either scheme
 * satisfies the contract. Net effect: `{keywords: []}` round-trips
 * byte-identically to itself instead of collapsing to `{}` (canonical-JSON /
 * graphHash distinction preserved on every backend). Enforced end-to-end by
 * `graph-hash-parity.test.ts`.
 *
 * **`frameworks_json` unification** — before the hoist, the DuckDB
 * adapter wrote the v2.0 polymorphic shape via `frameworksJsonOrNull`
 * while the graph-db adapter wrote the legacy flat shape via
 * `jsonArrayOrNull`. Both adapters' readers already support both shapes
 * (`applyFrameworksJsonReadback`, `applyFrameworksJsonReadbackGd`). The
 * unified writer here calls {@link frameworksJsonOrNull} for both adapters,
 * which emits the legacy flat array whenever `frameworksDetected` is absent
 * / empty (every existing fixture and every legacy graph), and the v2.0
 * `{flat, detected}` envelope only when callers populate
 * `frameworksDetected`. The parity test stays green; production graphs that
 * never carried `frameworksDetected` round-trip byte-identically.
 */

import { canonicalJson, type GraphNode } from "@opencodehub/core-types";

/**
 * Canonical column ordering for the polymorphic `nodes` / `CodeNode` table.
 * Both DuckDB and the graph-db backends consume this list — the type-name
 * mapping (`TEXT[]` vs `STRING[]`, etc.) lives in each adapter's CREATE
 * TABLE DDL, but the column ORDER is canonical and shared.
 *
 * Rules for adding a column (must hold across both adapters):
 *   1. Append to the END of this list — reordering rewrites every prepared
 *      statement parameter slot and breaks already-persisted graphs.
 *   2. Append the writer in {@link nodeToColumns}.
 *   3. Append the reader in each adapter's row decoder (`rowToGraphNode`
 *      for DuckDB, `applyNodeColumns` + `ROUND_TRIP_COLUMN_MAP` for
 *      graph-db).
 *   4. Update the CREATE TABLE DDL in `schema-ddl.ts` (DuckDB) and
 *      `graphdb-schema.ts` (graph-db) to keep the on-disk schema in lock
 *      step with this list.
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
 * Encode a GraphNode into a `column → value` map indexed by the canonical
 * {@link NODE_COLUMNS} keys. Each adapter consumes this map and projects to
 * its own native binding (DuckDB row tuple / graph-db parameter list).
 *
 * Field/column aliasing:
 *   - `OperationNode.method` → `http_method` column (not `method`, which is
 *     reserved for `RouteNode`).
 *   - `OperationNode.path`   → `http_path`.
 *   The Operation write-through still preserves read-back determinism
 *   because each adapter's row decoder maps `http_method`/`http_path` back
 *   to `method`/`path` when `kind === "Operation"`.
 *
 * Defensive bracket-access on the source node lets unknown / future
 * NodeKinds fall through to NULL-valued columns without throwing.
 */
export function nodeToColumns(node: GraphNode): Record<string, unknown> {
  const n = node as GraphNode & Record<string, unknown>;
  const isOperation = node.kind === "Operation";
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    file_path: node.filePath,
    start_line: numberOrNull(n["startLine"]),
    end_line: numberOrNull(n["endLine"]),
    is_exported: booleanOrNull(n["isExported"]),
    signature: stringOrNull(n["signature"]),
    parameter_count: numberOrNull(n["parameterCount"]),
    return_type: stringOrNull(n["returnType"]),
    declared_type: stringOrNull(n["declaredType"]),
    owner: stringOrNull(n["owner"]),
    url: stringOrNull(n["url"]),
    // Route.method → method; Operation.method goes to http_method instead.
    method: isOperation ? null : stringOrNull(n["method"]),
    tool_name: stringOrNull(n["toolName"]),
    content: stringOrNull(n["content"]),
    content_hash: stringOrNull(n["contentHash"]),
    inferred_label: stringOrNull(n["inferredLabel"]),
    symbol_count: numberOrNull(n["symbolCount"]),
    cohesion: numberOrNull(n["cohesion"]),
    keywords: stringArrayOrNull(n["keywords"]),
    entry_point_id: stringOrNull(n["entryPointId"]),
    step_count: numberOrNull(n["stepCount"]),
    level: numberOrNull(n["level"]),
    response_keys: stringArrayOrNull(n["responseKeys"]),
    description: stringOrNull(n["description"]),
    // Finding
    severity: stringOrNull(n["severity"]),
    rule_id: stringOrNull(n["ruleId"]),
    scanner_id: stringOrNull(n["scannerId"]),
    message: stringOrNull(n["message"]),
    properties_bag: jsonObjectOrNull(n["propertiesBag"]),
    // Dependency
    version: stringOrNull(n["version"]),
    license: stringOrNull(n["license"]),
    lockfile_source: stringOrNull(n["lockfileSource"]),
    ecosystem: stringOrNull(n["ecosystem"]),
    // Operation — OperationNode uses .method / .path on the type.
    http_method: isOperation ? stringOrNull(n["method"]) : null,
    http_path: isOperation ? stringOrNull(n["path"]) : null,
    summary: stringOrNull(n["summary"]),
    operation_id: stringOrNull(n["operationId"]),
    // Contributor
    email_hash: stringOrNull(n["emailHash"]),
    email_plain: stringOrNull(n["emailPlain"]),
    // ProjectProfile (JSON-encoded array fields)
    languages_json: jsonArrayOrNull(n["languages"]),
    // `frameworks_json` is the polymorphic column — see file-level
    // "frameworks_json unification note" for the rationale.
    frameworks_json: frameworksJsonOrNull(n["frameworks"], n["frameworksDetected"]),
    iac_types_json: jsonArrayOrNull(n["iacTypes"]),
    api_contracts_json: jsonArrayOrNull(n["apiContracts"]),
    manifests_json: jsonArrayOrNull(n["manifests"]),
    src_dirs_json: jsonArrayOrNull(n["srcDirs"]),
    // File ownership (H.5) + Community ownership (H.4)
    orphan_grade: stringOrNull(n["orphanGrade"]),
    is_orphan: booleanOrNull(n["isOrphan"]),
    truck_factor: numberOrNull(n["truckFactor"]),
    ownership_drift_30d: numberOrNull(n["ownershipDrift30d"]),
    ownership_drift_90d: numberOrNull(n["ownershipDrift90d"]),
    ownership_drift_365d: numberOrNull(n["ownershipDrift365d"]),
    // v1.2 extensions.
    deadness: stringOrNull(normalizeDeadness(n["deadness"])),
    coverage_percent: numberOrNull(n["coveragePercent"]),
    covered_lines_json: coveredLinesOrNull(n["coveredLines"], n["coveredLinesJson"]),
    cyclomatic_complexity: numberOrNull(n["cyclomaticComplexity"]),
    nesting_depth: numberOrNull(n["nestingDepth"]),
    nloc: numberOrNull(n["nloc"]),
    halstead_volume: numberOrNull(n["halsteadVolume"]),
    input_schema_json: stringOrNull(n["inputSchemaJson"]),
    partial_fingerprint: stringOrNull(n["partialFingerprint"]),
    baseline_state: stringOrNull(n["baselineState"]),
    suppressed_json: stringOrNull(n["suppressedJson"]),
    // Repo. Each column is populated only when `node.kind === "Repo"`
    // and stays NULL for every other kind.
    // `originUrl` / `defaultBranch` / `group` are nullable on the interface
    // — `repoStringOrNull` collapses null and missing alike to SQL NULL.
    origin_url: repoStringOrNull(n, "originUrl"),
    repo_uri: stringOrNull(n["repoUri"]),
    default_branch: repoStringOrNull(n, "defaultBranch"),
    commit_sha: stringOrNull(n["commitSha"]),
    index_time: stringOrNull(n["indexTime"]),
    repo_group: repoStringOrNull(n, "group"),
    visibility: stringOrNull(n["visibility"]),
    indexer: stringOrNull(n["indexer"]),
    // languageStats is a Record<string, number>. canonicalJson sorts keys so
    // bytes match the byte-stable serialization used in graphHash.
    language_stats_json: languageStatsJsonOrNull(n["languageStats"]),
  };
}

/**
 * Dedupe by the caller-provided id extractor, keeping the LAST occurrence.
 *
 * Protects against DuckDB UPSERT issue 8147 (two rows with the same primary
 * key in one INSERT cannot both fire ON CONFLICT). The caller-driven id
 * function also lets us reuse this for nodes (id) and edges (id).
 */
export function dedupeLastById<T>(items: readonly T[], idOf: (t: T) => string): readonly T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    seen.set(idOf(item), item);
  }
  return Array.from(seen.values());
}

/**
 * Coerce a numeric value to `number` or `null`. NaN / Infinity / non-number
 * inputs collapse to `null` so downstream binders don't blow up on a
 * non-finite parameter.
 */
export function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Coerce to a non-empty string or `null`. Empty strings collapse to NULL —
 * the storage layer treats "" and absent as equivalent.
 */
export function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Coerce to `boolean` or `null`. */
export function booleanOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Coerce to a `readonly string[]` or `null`.
 *
 * - Non-array inputs (`undefined`, `null`, wrong type) → `null` (= column
 *   stays SQL NULL, reader drops the field, canonical-JSON omits the key).
 * - Array inputs round-trip as a typed array — including `[]` (0-length).
 *   Non-string elements are filtered silently.
 *
 * **Preserve `[]` distinct from absent.** Returning a typed `[]` on an
 * empty-array input (rather than `null`) carries the "explicit empty"
 * signal into each adapter's writer. DuckDB `TEXT[]` stores a 0-length
 * literal natively; lbug `STRING[]` cannot (it collapses `[]` to NULL on
 * write), so the graph-db adapter substitutes an empty-array marker on the
 * way in and decodes it back on the way out — see `encodeNodeCol` +
 * `setStringArrayFieldGd` in `graphdb-adapter.ts`. The symmetric reader
 * change in `duckdb-adapter.ts:setStringArrayField` and
 * `analyze.ts:stringArrayField` re-attaches `[]` instead of dropping the
 * field when the read-back array has length zero. Combined, this preserves
 * the canonical-JSON shape difference between `{keywords: []}` and `{}`
 * (graphHash content-shape change — see the empty-keywords fixture in
 * `graph-hash-parity.test.ts`).
 */
export function stringArrayOrNull(v: unknown): readonly string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/**
 * Serialize an array of primitives or arbitrary JSON-safe records to a JSON
 * string. Returns `null` for any input that is not an array. Object values
 * are serialized verbatim via `JSON.stringify`. Pre-canonicalized strings
 * pass through unchanged so callers can pre-encode.
 */
export function jsonArrayOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return null;
  return JSON.stringify(v);
}

/**
 * Serialize a `Record<string, unknown>` (or pre-encoded JSON string) into a
 * JSON string for storage in a polymorphic TEXT column. Returns `null` for
 * null / undefined / non-object / array inputs.
 */
export function jsonObjectOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return JSON.stringify(v);
}

/**
 * Resolve the value for the `covered_lines_json` column. File nodes carry a
 * `coveredLines: readonly number[]` field (flattened via canonical JSON);
 * callables carry an already-serialized `coveredLinesJson` string. Prefer
 * the string when present so we don't re-stringify work the caller already
 * did.
 */
export function coveredLinesOrNull(
  coveredLines: unknown,
  coveredLinesJson: unknown,
): string | null {
  if (typeof coveredLinesJson === "string" && coveredLinesJson.length > 0) {
    return coveredLinesJson;
  }
  return jsonArrayOrNull(coveredLines);
}

/**
 * Resolve a `RepoNode` field whose interface-level type is `string | null`.
 *
 * `stringOrNull` already collapses null and empty strings alike to SQL
 * NULL. `repoStringOrNull` is named the same way at the call site so future
 * editors recognise that the explicit-null preservation is a Repo-specific
 * concern handled on the read side via {@link applyRepoNullables}.
 */
export function repoStringOrNull(n: Record<string, unknown>, key: string): string | null {
  const v = n[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/**
 * Serialize `RepoNode.languageStats` (`Record<string, number>`) to
 * byte-stable canonical JSON (sorted keys — matches graphHash). Returns
 * `null` for non-object / empty inputs so the column stays NULL for non-Repo
 * rows AND for Repo rows whose stats are explicitly empty (the empty-stats
 * sentinel — readers re-add `{}` via {@link coerceLanguageStats}).
 */
export function languageStatsJsonOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  if (Object.keys(v as object).length === 0) return null;
  return canonicalJson(v);
}

/**
 * Translate the hyphenated `unreachable-export` produced by the dead-code
 * analysis helper into the underscored form the `deadness` column stores.
 * Every other value (`live` / `dead`) already matches the schema enum.
 *
 * Each adapter carries the inverse `denormalizeDeadness` privately because
 * it's symmetric with the row decoder.
 */
export function normalizeDeadness(v: unknown): unknown {
  if (v === "unreachable-export") return "unreachable_export";
  return v;
}

/**
 * Serialize the polymorphic `frameworks_json` column.
 *
 * Two on-disk shapes coexist:
 *   - Legacy v1.0 graphs (before P05) wrote a flat `string[]` via
 *     `jsonArrayOrNull`. Reader code accepts that shape unchanged.
 *   - v2.0 graphs (after P05) write `{ flat: string[], detected: FrameworkDetection[] }`.
 *
 * The encoding is JSON in both cases. When the node carries no structured
 * detections (`frameworksDetected` absent or empty) we emit the legacy
 * flat-array shape so existing read paths continue to work without a
 * version bump. The read side in `packages/mcp/src/tools/project-profile.ts`
 * sniffs the shape.
 *
 * Both adapters call this function. The graph-db writer previously
 * emitted only the legacy flat shape; with the unification it gains the
 * v2.0 envelope when callers populate `frameworksDetected`. The legacy
 * path is byte-identical to the old graph-db output, so existing graphs
 * keep round-tripping unchanged.
 *
 * When both `flat` is absent / non-array AND `detected` is empty,
 * return `null` so the column stays NULL for nodes that never declared
 * a `frameworks` field (every node kind except ProjectProfile, in
 * practice). Previously this branch returned `"[]"` for every node,
 * which polluted the polymorphic column and — once the public-interface
 * parity harness landed — broke graphHash byte-identity (the rebuilder
 * would re-attach `frameworks: []` on every rebuilt node). Callers that
 * intentionally write an explicit empty array (a ProjectProfile node
 * with `frameworks: []` and no detections) still emit `"[]"` because
 * `flat` is a real array.
 */
export function frameworksJsonOrNull(flat: unknown, detected: unknown): string | null {
  const flatIsArray = Array.isArray(flat);
  const detectedArr = Array.isArray(detected) ? detected : [];
  if (!flatIsArray && detectedArr.length === 0) return null;
  const flatArr = flatIsArray
    ? (flat as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (detectedArr.length === 0) {
    // Preserve the legacy wire shape when there is nothing structured to emit.
    return JSON.stringify(flatArr);
  }
  return JSON.stringify({ flat: flatArr, detected: detectedArr });
}

// ---------------------------------------------------------------------------
// Sentinels — promoted from `graph-hash-parity.test.ts`. They were inline
// helpers in the test file; promoting them makes them invariants every
// adapter (and the parity harness) shares.
// ---------------------------------------------------------------------------

/**
 * Step-zero sentinel. The DuckDB `relations.step` column is
 * `INTEGER NOT NULL DEFAULT 0`; the graph-db column is nullable `INT32`.
 * Both backends therefore disagree on read-back when the source edge
 * carries an explicit `step: 0` (DuckDB returns `0`, graph-db returns
 * `null`). The convention is "drop step when it reads back as zero/null"
 * — this helper formalises that on the read side so canonical-JSON parity
 * holds across backends.
 *
 * Returns `undefined` for `0` / `null` / `undefined` (drop the field on
 * the rebuilt node). Returns the verbatim number for every other input.
 * Non-finite numbers also collapse to `undefined` so a corrupt row never
 * leaks NaN into the rebuilt graph.
 */
export function stepZeroSentinel(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value === 0) return undefined;
  return value;
}

/**
 * Coerce the read-back value for `RepoNode.languageStats`.
 *
 * The writer ({@link languageStatsJsonOrNull}) collapses `{}` to SQL NULL.
 * On read the reconstructed node must carry an empty `{}` so the canonical
 * JSON hash is stable across "absent" vs "explicitly empty". This helper
 * implements the symmetric coercion: parse the JSON when the column is a
 * non-empty string; otherwise emit `{}`. Non-object / array payloads also
 * collapse to `{}` so a corrupt row never poisons the rebuilt graph.
 */
export function coerceLanguageStats(raw: unknown): Record<string, number> {
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        }
        return out;
      }
    } catch {
      /* fall through to empty record */
    }
  }
  return {};
}

/**
 * Re-attach `RepoNode` nullable string fields (`originUrl`, `defaultBranch`,
 * `group`) on the rebuilt record when the underlying column is NULL.
 *
 * `RepoNode` declares those three fields as `string | null` (not
 * `string | undefined`), so the rebuilt node must carry an explicit `null`
 * rather than leaving the key off — otherwise the canonical-JSON hash
 * diverges from the original fixture.
 *
 * Also handles `languageStats`: when the JSON column is a non-empty string,
 * parse it via {@link coerceLanguageStats}; otherwise emit `{}` so the empty
 * sentinel round-trips correctly.
 *
 * `rec` is the raw row (column-name keyed); `base` is the rebuilt node
 * accumulator (camelCase keyed). No-op for non-Repo rows.
 */
export function applyRepoNullables(
  rec: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (base["kind"] !== "Repo") return;
  for (const [col, key] of [
    ["origin_url", "originUrl"],
    ["default_branch", "defaultBranch"],
    ["repo_group", "group"],
  ] as const) {
    const v = rec[col];
    if (v === null || v === undefined) base[key] = null;
  }
  base["languageStats"] = coerceLanguageStats(rec["language_stats_json"]);
}
