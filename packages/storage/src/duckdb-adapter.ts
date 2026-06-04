/**
 * DuckDB-backed adapter for the temporal storage interface.
 *
 * This class implements {@link ITemporalStore} only. The graph tier is
 * served by `GraphDbStore` (`@ladybugdb/core`); the temporal tier owns
 * cochange statistics, structured symbol summaries, and the
 * `codehub query --sql` escape hatch.
 *
 * Lifecycle: `open` → `createSchema` → `bulkLoadCochanges` /
 * `bulkLoadSymbolSummaries` → `lookupCochangesForFile` /
 * `lookupSymbolSummary` / `exec` → `close`.
 *
 * Timeouts on `exec` are enforced by a JS-side interrupt timer rather
 * than a DuckDB SQL setting — DuckDB does not expose a per-statement
 * timeout.
 */

import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBPreparedStatement,
  FLOAT,
  LIST,
} from "@duckdb/node-api";
import type {
  CochangeLookupOptions,
  CochangeRow,
  EmbeddingRow,
  ITemporalStore,
  SqlParam,
  SymbolSummaryRow,
} from "./interface.js";
import { generateSchemaDDL } from "./schema-ddl.js";
import { assertReadOnlySql } from "./sql-guard.js";

export interface DuckDbStoreOptions {
  readonly readOnly?: boolean;
  /**
   * Retained for API symmetry with the prior multi-tier adapter; the
   * temporal-only adapter never reads embeddings, so the value is ignored.
   */
  readonly embeddingDim?: number;
  /** Default query timeout for `exec()` calls in ms. Default 5000. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COCHANGE_LOOKUP_LIMIT = 10;
const DEFAULT_COCHANGE_MIN_LIFT = 1.0;

/**
 * Concrete adapter that satisfies {@link ITemporalStore} over a single
 * DuckDB connection. Pairs with `GraphDbStore` for the graph tier via
 * `openStore`.
 */
export class DuckDbStore implements ITemporalStore {
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly defaultTimeoutMs: number;
  private instance: DuckDBInstance | undefined;
  private conn: DuckDBConnection | undefined;

  constructor(path: string, opts: DuckDbStoreOptions = {}) {
    this.path = path;
    this.readOnly = opts.readOnly === true;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async open(): Promise<void> {
    if (this.instance) return;
    const options: Record<string, string> = {
      access_mode: this.readOnly ? "READ_ONLY" : "READ_WRITE",
    };
    this.instance = await DuckDBInstance.create(this.path, options);
    this.conn = await this.instance.connect();
  }

  async close(): Promise<void> {
    this.conn?.closeSync();
    this.conn = undefined;
    this.instance?.closeSync();
    this.instance = undefined;
  }

  async createSchema(): Promise<void> {
    const c = this.requireConn();
    const stmts = generateSchemaDDL();
    for (const stmt of stmts) {
      await c.run(stmt);
    }
  }

  // --------------------------------------------------------------------------
  // Cochanges
  // --------------------------------------------------------------------------

  async bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void> {
    const c = this.requireConn();
    await c.run("BEGIN TRANSACTION");
    try {
      await c.run("DELETE FROM cochanges");
      if (rows.length === 0) {
        await c.run("COMMIT");
        return;
      }
      // Sort by (source_file, target_file) so insertion order is deterministic
      // across runs.
      const sorted = [...rows].sort((a, b) => {
        if (a.sourceFile !== b.sourceFile) {
          return a.sourceFile < b.sourceFile ? -1 : 1;
        }
        return a.targetFile < b.targetFile ? -1 : a.targetFile > b.targetFile ? 1 : 0;
      });
      const stmt = await c.prepare(
        `INSERT INTO cochanges (
          source_file, target_file, cocommit_count,
          total_commits_source, total_commits_target,
          last_cocommit_at, lift
        ) VALUES (?, ?, ?, ?, ?, CAST(? AS TIMESTAMP), ?)`,
      );
      try {
        for (const row of sorted) {
          stmt.clearBindings();
          bindParam(stmt, 1, row.sourceFile);
          bindParam(stmt, 2, row.targetFile);
          bindParam(stmt, 3, row.cocommitCount);
          bindParam(stmt, 4, row.totalCommitsSource);
          bindParam(stmt, 5, row.totalCommitsTarget);
          bindParam(stmt, 6, row.lastCocommitAt);
          bindParam(stmt, 7, row.lift);
          await stmt.run();
        }
      } finally {
        stmt.destroySync();
      }
      await c.run("COMMIT");
    } catch (err) {
      await c.run("ROLLBACK");
      throw err;
    }
  }

  async lookupCochangesForFile(
    file: string,
    opts: CochangeLookupOptions = {},
  ): Promise<readonly CochangeRow[]> {
    const c = this.requireConn();
    const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_COCHANGE_LOOKUP_LIMIT));
    const minLift = opts.minLift ?? DEFAULT_COCHANGE_MIN_LIFT;
    // Rows are keyed by ordered (source_file, target_file) pairs but the
    // signal is symmetric, so probe both directions. Sort by lift DESC so
    // the strongest associations surface first; break ties deterministically
    // on the pair key.
    const stmt = await c.prepare(
      `SELECT source_file, target_file, cocommit_count,
              total_commits_source, total_commits_target,
              last_cocommit_at, lift
         FROM cochanges
        WHERE (source_file = ? OR target_file = ?) AND lift >= ?
        ORDER BY lift DESC, source_file ASC, target_file ASC
        LIMIT ?`,
    );
    try {
      stmt.bindVarchar(1, file);
      stmt.bindVarchar(2, file);
      stmt.bindDouble(3, minLift);
      stmt.bindInteger(4, limit);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const out: CochangeRow[] = [];
      for (const r of raw) {
        out.push(cochangeRowFromRecord(r as Record<string, unknown>));
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  async lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined> {
    const c = this.requireConn();
    const stmt = await c.prepare(
      `SELECT source_file, target_file, cocommit_count,
              total_commits_source, total_commits_target,
              last_cocommit_at, lift
         FROM cochanges
        WHERE (source_file = ? AND target_file = ?)
           OR (source_file = ? AND target_file = ?)
        LIMIT 1`,
    );
    try {
      stmt.bindVarchar(1, fileA);
      stmt.bindVarchar(2, fileB);
      stmt.bindVarchar(3, fileB);
      stmt.bindVarchar(4, fileA);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const first = raw[0];
      if (!first) return undefined;
      return cochangeRowFromRecord(first as Record<string, unknown>);
    } finally {
      stmt.destroySync();
    }
  }

  // --------------------------------------------------------------------------
  // Symbol summaries
  // --------------------------------------------------------------------------

  async bulkLoadSymbolSummaries(rows: readonly SymbolSummaryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const c = this.requireConn();
    // Sort by the composite primary key so insertion order is deterministic
    // across runs.
    const sorted = [...rows].sort((a, b) => {
      if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
      if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
      if (a.promptVersion !== b.promptVersion) return a.promptVersion < b.promptVersion ? -1 : 1;
      return 0;
    });

    await c.run("BEGIN TRANSACTION");
    try {
      // Pre-delete matching composite keys so the INSERT is effectively an
      // upsert. Using DELETE+INSERT (rather than ON CONFLICT) keeps the
      // statement small and sidesteps DuckDB issue 8147 when the same key
      // appears multiple times in a single batch after dedupe.
      const delStmt = await c.prepare(
        "DELETE FROM symbol_summaries WHERE node_id = ? AND content_hash = ? AND prompt_version = ?",
      );
      try {
        for (const r of sorted) {
          delStmt.clearBindings();
          delStmt.bindVarchar(1, r.nodeId);
          delStmt.bindVarchar(2, r.contentHash);
          delStmt.bindVarchar(3, r.promptVersion);
          await delStmt.run();
        }
      } finally {
        delStmt.destroySync();
      }

      const insStmt = await c.prepare(
        `INSERT INTO symbol_summaries (
          node_id, content_hash, prompt_version, model_id,
          summary_text, signature_summary, returns_type_summary,
          structured_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS TIMESTAMP))`,
      );
      try {
        for (const r of sorted) {
          insStmt.clearBindings();
          bindParam(insStmt, 1, r.nodeId);
          bindParam(insStmt, 2, r.contentHash);
          bindParam(insStmt, 3, r.promptVersion);
          bindParam(insStmt, 4, r.modelId);
          bindParam(insStmt, 5, r.summaryText);
          bindParam(insStmt, 6, r.signatureSummary ?? null);
          bindParam(insStmt, 7, r.returnsTypeSummary ?? null);
          bindParam(insStmt, 8, r.structuredJson ?? null);
          bindParam(insStmt, 9, r.createdAt);
          await insStmt.run();
        }
      } finally {
        insStmt.destroySync();
      }
      await c.run("COMMIT");
    } catch (err) {
      await c.run("ROLLBACK");
      throw err;
    }
  }

  async lookupSymbolSummary(
    nodeId: string,
    contentHash: string,
    promptVersion: string,
  ): Promise<SymbolSummaryRow | undefined> {
    const c = this.requireConn();
    const stmt = await c.prepare(
      `SELECT node_id, content_hash, prompt_version, model_id,
              summary_text, signature_summary, returns_type_summary,
              structured_json, created_at
         FROM symbol_summaries
        WHERE node_id = ? AND content_hash = ? AND prompt_version = ?
        LIMIT 1`,
    );
    try {
      stmt.bindVarchar(1, nodeId);
      stmt.bindVarchar(2, contentHash);
      stmt.bindVarchar(3, promptVersion);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const first = raw[0];
      if (!first) return undefined;
      return summaryRowFromRecord(first as Record<string, unknown>);
    } finally {
      stmt.destroySync();
    }
  }

  async lookupSymbolSummariesByNode(
    nodeIds: readonly string[],
  ): Promise<readonly SymbolSummaryRow[]> {
    if (nodeIds.length === 0) return [];
    const c = this.requireConn();
    const placeholders = nodeIds.map(() => "?").join(",");
    const stmt = await c.prepare(
      `SELECT node_id, content_hash, prompt_version, model_id,
              summary_text, signature_summary, returns_type_summary,
              structured_json, created_at
         FROM symbol_summaries
        WHERE node_id IN (${placeholders})
        ORDER BY node_id ASC, prompt_version ASC, content_hash ASC`,
    );
    try {
      let idx = 1;
      for (const id of nodeIds) stmt.bindVarchar(idx++, id);
      const reader = await stmt.runAndReadAll();
      const raw = reader.getRowObjects();
      const out: SymbolSummaryRow[] = [];
      for (const r of raw) {
        out.push(summaryRowFromRecord(r as Record<string, unknown>));
      }
      return out;
    } finally {
      stmt.destroySync();
    }
  }

  async countSymbolSummaries(): Promise<number> {
    try {
      const c = this.requireConn();
      const stmt = await c.prepare("SELECT COUNT(DISTINCT node_id) AS n FROM symbol_summaries");
      try {
        const reader = await stmt.runAndReadAll();
        const first = reader.getRowObjects()[0] as Record<string, unknown> | undefined;
        const n = first?.["n"];
        return typeof n === "bigint" ? Number(n) : typeof n === "number" ? n : 0;
      } finally {
        stmt.destroySync();
      }
    } catch {
      // Missing table / degraded store → report 0 rather than throwing, so
      // `codehub status` degrades gracefully.
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // exec — read-only SQL escape hatch (codehub query --sql, MCP sql tool)
  // --------------------------------------------------------------------------

  async exec(
    sql: string,
    params: readonly SqlParam[] = [],
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    assertReadOnlySql(sql);
    const c = this.requireConn();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return this.withTimeout(timeoutMs, async () => {
      const stmt = await c.prepare(sql);
      try {
        for (let i = 0; i < params.length; i += 1) {
          bindParam(stmt, i + 1, params[i] ?? null);
        }
        const reader = await stmt.runAndReadAll();
        return normalizeRows(reader.getRowObjects());
      } finally {
        stmt.destroySync();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Embedding-Parquet export — pack/embeddings-sidecar.ts surface
  //
  // Embeddings live in `graph.lbug`. The sidecar streams rows out of lbug,
  // stages them in a per-call DuckDB temp table on `temporal.duckdb`, then
  // runs `COPY (...) TO '<path>' (FORMAT PARQUET, COMPRESSION ZSTD)` to
  // produce the byte-identical sidecar. The temp table is connection-local
  // and dropped before the call returns.
  // --------------------------------------------------------------------------

  async exportEmbeddingsToParquet(
    rows: AsyncIterable<EmbeddingRow>,
    absOutPath: string,
  ): Promise<{ readonly rowCount: number; readonly duckdbVersion: string }> {
    const c = this.requireConn();
    const duckdbVersion = await this.fetchDuckdbVersion();

    if (!isSafeAbsolutePath(absOutPath)) {
      throw new Error(
        "exportEmbeddingsToParquet: outPath must be an absolute path with safe characters " +
          "(alphanumerics, slash, underscore, dash, dot)",
      );
    }

    // Pre-staging: create a transient table sized to the largest VECTOR width
    // we'll see. DuckDB temp tables are connection-scoped — a stale handle
    // from a prior call would surface as a "table already exists" error, so
    // drop defensively before recreating.
    await c.run("DROP TABLE IF EXISTS embeddings_export");
    await c.run(
      "CREATE TEMP TABLE embeddings_export (" +
        "node_id VARCHAR NOT NULL, " +
        "granularity VARCHAR NOT NULL, " +
        "chunk_index INTEGER NOT NULL, " +
        "vector FLOAT[] NOT NULL" +
        ")",
    );

    let rowCount = 0;
    try {
      const insertStmt = await c.prepare(
        "INSERT INTO embeddings_export (node_id, granularity, chunk_index, vector) VALUES (?, ?, ?, ?)",
      );
      try {
        for await (const row of rows) {
          insertStmt.bindVarchar(1, row.nodeId);
          insertStmt.bindVarchar(2, row.granularity ?? "symbol");
          insertStmt.bindInteger(3, row.chunkIndex);
          insertStmt.bindList(4, Array.from(row.vector), LIST(FLOAT));
          await insertStmt.run();
          rowCount += 1;
        }
      } finally {
        // No public destroy on prepared statements in the current binding;
        // they're cleaned up when the connection closes.
      }

      if (rowCount === 0) {
        return { rowCount: 0, duckdbVersion };
      }

      // COPY does not accept bound parameters for the destination. The path
      // is validated above so single-quote injection is impossible.
      const sql =
        `COPY (SELECT node_id, granularity, chunk_index, vector ` +
        `FROM embeddings_export ORDER BY node_id ASC, granularity ASC, chunk_index ASC) ` +
        `TO '${absOutPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`;
      await c.run(sql);
      return { rowCount, duckdbVersion };
    } finally {
      await c.run("DROP TABLE IF EXISTS embeddings_export").catch(() => {});
    }
  }

  /**
   * Resolve the live DuckDB engine version via `SELECT version()`. The
   * result is the string DuckDB embeds in the parquet `created_by`
   * metadata, so the pack manifest's `pins.duckdbVersion` stays bound to
   * the writer version that produced the sidecar.
   */
  private async fetchDuckdbVersion(): Promise<string> {
    const c = this.requireConn();
    try {
      const reader = await c.runAndReadAll("SELECT version() AS v");
      const rows = reader.getRowObjects();
      const v = rows[0] ? (rows[0] as { v?: unknown }).v : undefined;
      return typeof v === "string" && v.length > 0 ? v : "unknown";
    } catch {
      return "unknown";
    }
  }

  // --------------------------------------------------------------------------
  // healthCheck
  // --------------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const c = this.requireConn();
      const reader = await c.runAndReadAll("SELECT 1 AS ok");
      const rows = reader.getRowObjects();
      const first = rows[0];
      const ok = first ? Number((first as { ok: unknown }).ok) === 1 : false;
      return ok ? { ok: true } : { ok: false, message: "SELECT 1 returned unexpected shape" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private requireConn(): DuckDBConnection {
    if (!this.conn) {
      throw new Error("DuckDbStore is not open — call open() first");
    }
    return this.conn;
  }

  /**
   * Interrupt the current statement if it exceeds the timeout. DuckDB has no
   * SQL-level statement timeout, so we schedule a JS timer that calls
   * `connection.interrupt()` and let the prepared statement throw.
   */
  private async withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    if (ms <= 0) return fn();
    const c = this.requireConn();
    let interrupted = false;
    const handle = setTimeout(() => {
      interrupted = true;
      try {
        c.interrupt();
      } catch {
        /* ignore — connection may already be done */
      }
    }, ms);
    try {
      return await fn();
    } catch (err) {
      if (interrupted) {
        throw new Error(`Query exceeded timeout of ${ms}ms`);
      }
      throw err;
    } finally {
      clearTimeout(handle);
    }
  }
}

// ----------------------------------------------------------------------------
// Free helpers
// ----------------------------------------------------------------------------

function bindParam(stmt: DuckDBPreparedStatement, index: number, value: SqlParam | null): void {
  if (value === null || value === undefined) {
    stmt.bindNull(index);
    return;
  }
  switch (typeof value) {
    case "boolean":
      stmt.bindBoolean(index, value);
      return;
    case "number":
      if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
        stmt.bindInteger(index, value);
      } else {
        stmt.bindDouble(index, value);
      }
      return;
    case "bigint":
      stmt.bindBigInt(index, value);
      return;
    case "string":
      stmt.bindVarchar(index, value);
      return;
    default:
      throw new Error(`Unsupported SQL parameter type at index ${index}`);
  }
}

/**
 * DuckDB's getRowObjects returns values that are mostly JS primitives, but
 * some column types come back as class instances (e.g. `DuckDBListValue`,
 * `DuckDBArrayValue`) that carry an `items` array. Normalize every row to
 * plain JS values so downstream tests and hashing behave predictably.
 */
function normalizeRows(rows: readonly unknown[]): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const src = r as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      cleaned[k] = normalizeValue(v);
    }
    out.push(cleaned);
  }
  return out;
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x));
  if (typeof v === "object") {
    const obj = v as { items?: unknown };
    if (Array.isArray(obj.items)) {
      return obj.items.map((x) => normalizeValue(x));
    }
  }
  return v;
}

/**
 * Convert a DuckDB row from the `cochanges` table back into a {@link CochangeRow}.
 * The timestamp column arrives as either a DuckDB value object carrying a
 * `micros` BigInt (when returned over the native bindings) or a string; both
 * paths resolve to an ISO-8601 UTC string.
 */
function cochangeRowFromRecord(row: Record<string, unknown>): CochangeRow {
  const last = row["last_cocommit_at"];
  let lastCocommitAt: string;
  if (typeof last === "string") {
    lastCocommitAt = last;
  } else if (last && typeof last === "object") {
    const anyRow = last as { micros?: bigint; toISOString?: () => string };
    if (typeof anyRow.toISOString === "function") {
      lastCocommitAt = anyRow.toISOString();
    } else if (typeof anyRow.micros === "bigint") {
      lastCocommitAt = new Date(Number(anyRow.micros / 1000n)).toISOString();
    } else {
      lastCocommitAt = String(last);
    }
  } else {
    lastCocommitAt = String(last ?? "");
  }
  return {
    sourceFile: String(row["source_file"] ?? ""),
    targetFile: String(row["target_file"] ?? ""),
    cocommitCount: Number(row["cocommit_count"] ?? 0),
    totalCommitsSource: Number(row["total_commits_source"] ?? 0),
    totalCommitsTarget: Number(row["total_commits_target"] ?? 0),
    lastCocommitAt,
    lift: Number(row["lift"] ?? 0),
  };
}

/**
 * Convert a DuckDB row from the `symbol_summaries` table back into a
 * {@link SymbolSummaryRow}.
 */
function summaryRowFromRecord(row: Record<string, unknown>): SymbolSummaryRow {
  const created = row["created_at"];
  let createdAt: string;
  if (typeof created === "string") {
    createdAt = created;
  } else if (created && typeof created === "object") {
    const anyRow = created as { micros?: bigint; toISOString?: () => string };
    if (typeof anyRow.toISOString === "function") {
      createdAt = anyRow.toISOString();
    } else if (typeof anyRow.micros === "bigint") {
      createdAt = new Date(Number(anyRow.micros / 1000n)).toISOString();
    } else {
      createdAt = String(created);
    }
  } else {
    createdAt = String(created ?? "");
  }
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
    createdAt,
  };
}

/**
 * Conservative absolute-path validator used by `exportEmbeddingsParquet`
 * to inline a destination path into a `COPY ... TO '<path>' ...` SQL
 * statement. DuckDB's prepared-statement parser does not bind COPY
 * destinations, so the path is concatenated; allow only absolute paths over
 * a safe character class so single-quote injection is structurally
 * impossible.
 *
 * Accepts both POSIX absolute paths (`/repo/.codehub/…`) and Windows absolute
 * paths (`C:\repo\.codehub\…`): a drive-letter prefix and backslash separator
 * are permitted, but the character class still excludes quotes, spaces, and
 * shell/SQL metacharacters, so the injection guarantee holds on every platform.
 */
function isSafeAbsolutePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  const isPosixAbs = p.startsWith("/");
  const isWindowsAbs = /^[A-Za-z]:[/\\]/.test(p);
  if (!isPosixAbs && !isWindowsAbs) return false;
  // Safe class: alphanumerics, both separators, drive colon, underscore, dash,
  // dot. No quotes/spaces/metacharacters → single-quote injection impossible.
  return /^[A-Za-z0-9/\\:_\-.]+$/.test(p);
}

/**
 * Classify a SPDX-ish license string into one of the five
 * license-tier buckets. Used by graph-side `listDependencies` finders;
 * kept here as a free helper for cross-adapter symmetry.
 */
export function classifyLicenseTier(
  license: string | undefined,
): "permissive" | "weak-copyleft" | "strong-copyleft" | "proprietary" | "unknown" {
  if (!license || license.trim().length === 0) return "unknown";
  const lower = license.trim().toLowerCase();
  // Strong copyleft — GPL/AGPL family.
  if (/(^|\b|-)agpl(-|$)/i.test(lower) || /(^|\b|-)gpl(-|$)/i.test(lower)) {
    return "strong-copyleft";
  }
  // Weak copyleft — LGPL, MPL, EPL, CDDL, CC-BY-SA.
  if (
    /(^|\b|-)lgpl(-|$)/i.test(lower) ||
    /(^|\b)mpl(-|$)/i.test(lower) ||
    /(^|\b)epl(-|$)/i.test(lower) ||
    /(^|\b)cddl(-|$)/i.test(lower) ||
    /(^|\b)cc-by-sa(-|$)/i.test(lower)
  ) {
    return "weak-copyleft";
  }
  // Permissive — MIT/Apache/BSD/ISC/0BSD/Unlicense/CC0/Zlib.
  if (
    /(^|\b)mit(\b|-|$)/.test(lower) ||
    /(^|\b)apache(-|$)/i.test(lower) ||
    /(^|\b)bsd(-|$)/i.test(lower) ||
    /(^|\b)isc(\b|-|$)/.test(lower) ||
    /(^|\b)0bsd(\b|$)/.test(lower) ||
    /(^|\b)unlicense(\b|$)/.test(lower) ||
    /(^|\b)cc0(\b|-|$)/.test(lower) ||
    /(^|\b)zlib(\b|$)/.test(lower)
  ) {
    return "permissive";
  }
  // Proprietary markers.
  if (/(^|\b)(proprietary|commercial|see license)(\b|$)/i.test(lower)) {
    return "proprietary";
  }
  return "unknown";
}
