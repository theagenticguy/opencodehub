/**
 * `sql` — raw read-only SQL over the local single-file store.
 *
 * Post-ADR 0019 the whole index is one `store.sqlite` (node:sqlite, WAL),
 * so `nodes`, `edges`, `embeddings`, `store_meta`, and `cochanges` are all
 * real SQL tables in the same file. The `sql`
 * arg runs read-only SQL over them via `store.temporal.exec()`. The
 * read-only guard (`assertReadOnlySql`) rejects any write verb before the
 * statement reaches the engine.
 *
 * The `cypher` arg is retained on the input surface for the community-fork
 * escape hatch (an AGE / Memgraph / Neo4j adapter that implements the
 * optional `execCypher` hatch). The in-tree `SqliteStore` does NOT
 * implement `execCypher` — a `cypher:` call against the default backend
 * returns a clear "use `sql:` instead" envelope.
 *
 * - SQL path: `SqlGuardError` on violation → INVALID_INPUT envelope.
 * - Cypher path: `CypherGuardError` on violation → INVALID_INPUT envelope.
 * - Both `sql` and `cypher` supplied → INVALID_INPUT "choose one".
 *
 * A default 5 s timeout caps runaway queries — the adapter interrupts via
 * SQLite's `busy_timeout` PRAGMA plus a JS timer.
 *
 * The tool description embeds a schema hint so agents author correct
 * queries without a separate schema probe: it lists every SQL table in
 * `store.sqlite` and the JSON1 `payload->>'$.field'` extract idiom for
 * kind-specific node fields.
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
      "Read-only SQL statement against the single-file `store.sqlite` index — query `nodes`, `edges`, `embeddings`, `store_meta`, or `cochanges` directly. INSERT/UPDATE/DELETE/DDL are rejected by the guard. Provide exactly one of `sql` or `cypher`.",
    ),
  cypher: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Read-only Cypher statement, for a community-fork graph adapter that implements the optional `execCypher` hatch. The default SQLite backend does NOT support Cypher — use `sql:` instead. Provide exactly one of `sql` or `cypher`.",
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
  "SQL mode (`sql:`) — the whole index is one `store.sqlite`; these tables are all directly SQL-queryable:",
  "  nodes(id, kind, name, file_path, start_line, end_line, payload)  -- payload is canonical JSON; reach kind-specific fields via JSON1, e.g. payload->>'$.severity'",
  "  edges(id, src, dst, type, confidence, step, reason)  -- the call/reference graph; join src/dst back to nodes.id",
  "  embeddings(node_id, granularity, chunk_index, dim, vector, content_hash)",
  "  cochanges(source_file, target_file, cocommit_count, total_commits_source, total_commits_target, last_cocommit_at, lift)",
  "  store_meta(id, schema_version, indexed_at, node_count, edge_count, ...)",
  `  nodes.kind values: ${NODE_KINDS.join(", ")}.`,
  `  edges.type values: ${RELATION_TYPES.join(", ")}.`,
  "  Example: SELECT id, name FROM nodes WHERE kind = 'Function' AND file_path LIKE 'src/auth/%';",
  "Cypher mode (`cypher:`) — only for a community-fork graph adapter with the optional execCypher hatch. The default SQLite backend rejects it; use `sql:` instead.",
].join("\n");

interface SqlArgs {
  readonly sql?: string | undefined;
  readonly cypher?: string | undefined;
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly timeout_ms?: number | undefined;
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
        "The sql tool accepts either a SQL statement (against `store.sqlite`) or a Cypher statement (community-fork graph adapters only), not both.",
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

  const timeoutMs = args.timeout_ms ?? 5000;
  // Exactly one of these is defined at this point; TypeScript cannot
  // narrow the union through the `hasSql/hasCypher` booleans so we branch
  // on `hasCypher` and assert the narrowed type locally.
  const statement = hasCypher ? (args.cypher as string) : (args.sql as string);
  const isCypher = hasCypher;

  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      // Apply the guard BEFORE the store call so the rejection message
      // carries the guard's own context (SqlGuardError / CypherGuardError),
      // and so the store never sees a write verb. The store's own readonly
      // mode would also reject writes, but the guard produces a cleaner
      // user-facing error.
      //
      // Routing: SQL → `temporal.exec()` (the `--sql` escape hatch on
      // ITemporalStore); Cypher → `graph.execCypher` (the graph-only
      // adapter's escape hatch). Tools that don't have the
      // corresponding capability surface a clear error envelope.
      let rawRows: readonly Record<string, unknown>[];
      if (isCypher) {
        const exec = store.graph.execCypher;
        if (typeof exec !== "function") {
          return toolError(
            "INVALID_INPUT",
            "cypher unavailable: the default SQLite backend does not support Cypher",
            "The single-file `store.sqlite` backend (ADR 0019) exposes the graph as SQL tables, not Cypher. Re-issue your query with the `sql:` arg — e.g. `SELECT * FROM nodes WHERE kind = 'Function'`. The `cypher:` arg only works against a community-fork graph adapter that implements `execCypher`.",
          );
        }
        rawRows = await exec.call(store.graph, statement);
      } else {
        rawRows = await store.temporal.exec(statement, [], { timeoutMs });
      }
      // MCP serialises structuredContent via JSON, which cannot handle
      // bigint values (SQLite returns COUNT(*) etc. as bigint). Coerce
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
        "Execute a read-only query against the local single-file `store.sqlite` index. Supply `sql` to query the graph and temporal tables directly (`nodes`, `edges`, `embeddings`, `cochanges`, `store_meta`); `cypher` is reserved for community-fork graph adapters. Results are returned as a markdown table plus raw row objects. Use this for one-off questions the higher-level tools don't cover — e.g. 'find every exported function in src/auth/'.",
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
    // Escape pipes so the markdown table renders. Escape `\` first so a
    // pre-existing `\` in the value cannot pair with the appended `\|` to
    // form `\\|` (which renders as `\` + literal pipe instead of an
    // escaped pipe — js/incomplete-sanitization).
    return v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
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
