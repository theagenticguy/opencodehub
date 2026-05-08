/**
 * `sql` — raw read-only SQL / Cypher over the local graph store.
 *
 * The tool accepts either `sql` (DuckDB backend) or `cypher` (graph-db
 * backend, `CODEHUB_STORE=lbug`) — exactly one per call. The read-only
 * guards (`assertReadOnlySql` / `assertReadOnlyCypher`) reject any write
 * verb before the statement reaches the underlying engine.
 *
 * - SQL path: `SqlGuardError` on violation → INVALID_INPUT envelope.
 * - Cypher path: `CypherGuardError` on violation → INVALID_INPUT envelope.
 * - Cypher path without `CODEHUB_STORE=lbug` → INVALID_INPUT with a
 *   "cypher unavailable" hint.
 * - Both `sql` and `cypher` supplied → INVALID_INPUT "choose one".
 *
 * A default 5 s timeout caps runaway queries (DuckDB itself has no SQL
 * timeout — the adapter interrupts via a JS timer; the graph-db adapter
 * honours `timeoutMs` through its pool).
 *
 * The tool description embeds the node-kind and relation-type vocabulary
 * so agents can author correct queries without a separate schema probe.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NODE_KINDS, RELATION_TYPES } from "@opencodehub/core-types";
import { CypherGuardError, SqlGuardError } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  repoArgShape,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const SqlInput = {
  sql: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Read-only SQL statement (DuckDB backend). INSERT/UPDATE/DELETE/DDL are rejected by the guard. Provide exactly one of `sql` or `cypher`.",
    ),
  cypher: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Read-only Cypher statement (graph-db backend; requires `CODEHUB_STORE=lbug`). CREATE/DELETE/SET/MERGE/REMOVE/DROP are rejected by the guard. Provide exactly one of `sql` or `cypher`.",
    ),
  ...repoArgShape,
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(60_000)
    .optional()
    .describe("Per-statement timeout in milliseconds. Default 5000, max 60000."),
};

const SCHEMA_HINT = [
  "Tables: nodes(id, kind, name, file_path, start_line, end_line, is_exported, signature, parameter_count, return_type, declared_type, owner, url, method, tool_name, content, content_hash, inferred_label, symbol_count, cohesion, keywords, entry_point_id, step_count, level, response_keys, description), relations(id, from_id, to_id, type, confidence, reason, step), embeddings(id, node_id, chunk_index, start_line, end_line, vector, content_hash), store_meta(id, schema_version, last_commit, indexed_at, node_count, edge_count, stats_json).",
  `NodeKind values: ${NODE_KINDS.join(", ")}.`,
  `RelationType values: ${RELATION_TYPES.join(", ")}.`,
].join("\n");

interface SqlArgs {
  readonly sql?: string | undefined;
  readonly cypher?: string | undefined;
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly timeout_ms?: number | undefined;
}

/**
 * Determine the configured backend from the environment. Exposed as a
 * thin indirection so tests can flip the env var mid-run without touching
 * the tool surface.
 */
function isGraphDbBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CODEHUB_STORE"] === "lbug";
}

export async function runSql(ctx: ToolContext, args: SqlArgs): Promise<ToolResult> {
  // Exactly-one-of input guard. The Zod schema marks both fields optional
  // so we can emit a targeted error envelope rather than a schema-level
  // rejection that might get aliased to a generic "invalid input" string.
  const hasSql = typeof args.sql === "string" && args.sql.length > 0;
  const hasCypher = typeof args.cypher === "string" && args.cypher.length > 0;
  if (hasSql && hasCypher) {
    return toToolResult(
      toolError(
        "INVALID_INPUT",
        "provide exactly one of `sql` or `cypher`",
        "The sql tool accepts either a SQL statement (DuckDB backend) or a Cypher statement (graph-db backend), not both.",
      ),
    );
  }
  if (!hasSql && !hasCypher) {
    return toToolResult(
      toolError(
        "INVALID_INPUT",
        "provide one of `sql` or `cypher`",
        "The sql tool requires exactly one of the two input fields.",
      ),
    );
  }
  if (hasCypher && !isGraphDbBackend()) {
    return toToolResult(
      toolError(
        "INVALID_INPUT",
        "cypher unavailable without `CODEHUB_STORE=lbug`",
        "Set `CODEHUB_STORE=lbug` in the MCP server's environment to enable the graph-db backend. The default DuckDB backend only speaks SQL.",
      ),
    );
  }

  const timeoutMs = args.timeout_ms ?? 5000;
  // Exactly one of these is defined at this point; TypeScript cannot
  // narrow the union through the `hasSql/hasCypher` booleans so we branch
  // on `hasCypher` and assert the narrowed type locally.
  const statement = hasCypher ? (args.cypher as string) : (args.sql as string);
  const isCypher = hasCypher;

  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      // Apply the guard BEFORE the store.query() call so the rejection
      // message carries the guard's own context (SqlGuardError /
      // CypherGuardError), and so the store never sees a write verb.
      // The store's own readonly mode would also reject writes, but the
      // guard produces a cleaner user-facing error.
      // Note: `store` here is whatever the connection pool hands us. When
      // `CODEHUB_STORE=lbug`, the pool factory is expected (E-M3-1) to
      // yield a GraphDbStore; the `.query()` surface is shared via the
      // IGraphStore seam so the call site does not need to discriminate.
      const rawRows = await store.query(statement, [], { timeoutMs });
      // MCP serialises structuredContent via JSON, which cannot handle
      // bigint values (DuckDB returns COUNT(*) etc. as bigint). Coerce
      // every bigint to a plain number or string before handing the
      // rows up the transport.
      const rows = rawRows.map(sanitizeRowForJson);
      const table = renderMarkdownTable(rows);
      const lines = [
        `Query returned ${rows.length} row(s).`,
        rows.length === 0 ? "(no rows)" : table,
      ];
      return withNextSteps(
        lines.join("\n"),
        {
          row_count: rows.length,
          rows,
          columns: rows.length > 0 ? Object.keys(rows[0] as object) : [],
          dialect: isCypher ? "cypher" : "sql",
        },
        rows.length > 0
          ? ["call `context` on a row's id column to drill into the graph"]
          : ["broaden the WHERE clause or verify the NodeKind/RelationType filters"],
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      if (err instanceof SqlGuardError) {
        return toolError(
          "INVALID_INPUT",
          err.message,
          "Only SELECT-style queries are allowed. Remove DDL/DML keywords.",
        );
      }
      if (err instanceof CypherGuardError) {
        return toolError(
          "INVALID_INPUT",
          err.message,
          "Only MATCH/RETURN/WITH/WHERE/ORDER BY/LIMIT/SKIP/UNWIND (and the QUERY_FTS_INDEX / QUERY_VECTOR_INDEX procedures) are allowed. Remove any CREATE/DELETE/SET/MERGE/REMOVE/DROP keywords.",
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout")) {
        return toolError(
          "RATE_LIMITED",
          msg,
          "Add a tighter WHERE clause or raise timeout_ms (max 60000).",
        );
      }
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerSqlTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "sql",
    {
      title: "Read-only SQL / Cypher over the code graph",
      description: [
        "Execute a read-only query against the local graph store. Supply EXACTLY ONE of `sql` (DuckDB backend, default) or `cypher` (graph-db backend, requires `CODEHUB_STORE=lbug`). Results are returned as a markdown table plus raw row objects. Use this for one-off questions that the higher-level tools don't cover — e.g. 'find every exported function in src/auth/'.",
        "",
        SCHEMA_HINT,
      ].join("\n"),
      inputSchema: SqlInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runSql(ctx, args)),
  );
}

function renderMarkdownTable(rows: readonly Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return "";
  const cols = Object.keys(first);
  const header = `| ${cols.join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 100)
    .map((row) => `| ${cols.map((c) => formatCell(row[c])).join(" | ")} |`)
    .join("\n");
  const footer =
    rows.length > 100 ? `\n_(truncated — showing first 100 of ${rows.length} rows)_` : "";
  return `${header}\n${divider}\n${body}${footer}`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    // Escape pipes so the markdown table renders.
    return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Coerce BigInt values to numbers (when they fit) or decimal strings, so
 * the row objects can round-trip through JSON for MCP transport.
 */
function sanitizeRowForJson(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = sanitizeValueForJson(v);
  }
  return out;
}

function sanitizeValueForJson(v: unknown): unknown {
  if (typeof v === "bigint") {
    // Safe number range → plain number; otherwise preserve as string.
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(v);
    }
    return v.toString();
  }
  if (Array.isArray(v)) return v.map(sanitizeValueForJson);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeValueForJson(val);
    }
    return out;
  }
  return v;
}
