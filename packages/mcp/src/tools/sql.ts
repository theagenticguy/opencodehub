/**
 * `sql` — raw read-only SQL over the DuckDB graph.
 *
 * The storage layer enforces safety via `assertReadOnlySql`; any write-
 * attempt (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ATTACH`, …)
 * raises `SqlGuardError` which we translate to an INVALID_INPUT envelope.
 * A default 5 s timeout caps runaway queries (DuckDB itself has no SQL
 * timeout — the adapter interrupts via a JS timer).
 *
 * The tool description embeds the node-kind and relation-type vocabulary
 * so agents can author correct queries without a separate schema probe.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NODE_KINDS, RELATION_TYPES } from "@opencodehub/core-types";
import { SqlGuardError } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const SqlInput = {
  sql: z
    .string()
    .min(1)
    .describe("Read-only SQL statement. INSERT/UPDATE/DELETE/DDL are rejected by the guard."),
  repo: z.string().optional().describe("Registered repo name."),
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

export function registerSqlTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "sql",
    {
      title: "Read-only SQL over the code graph",
      description: [
        "Execute a read-only SQL statement against the DuckDB-backed graph store. Results are returned as a markdown table plus raw row objects. Use this for one-off questions that the higher-level tools don't cover — e.g. 'find every exported function in src/auth/'.",
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
    async (args) => {
      const timeoutMs = args.timeout_ms ?? 5000;
      return withStore(ctx, args.repo, async (store, resolved) => {
        try {
          const rawRows = await store.query(args.sql, [], { timeoutMs });
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
    },
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
