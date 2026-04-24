/**
 * `list_findings` — enumerate Finding nodes for an indexed repo.
 *
 * Finding nodes are produced by `codehub ingest-sarif` (or `codehub scan`
 * via its built-in ingestion step). Every node carries `scanner_id`,
 * `rule_id`, `severity`, and `message` plus a flat `properties_bag`
 * JSON string for the scanner's custom properties.
 *
 * Filters (all optional):
 *   - `severity`  — restrict to one SARIF level.
 *   - `scanner`   — restrict to a single scanner id.
 *   - `ruleId`    — restrict to a single rule id.
 *   - `filePath`  — substring match against `file_path`.
 *   - `limit`     — row cap (default 500, max 10_000).
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const ListFindingsInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
  severity: z
    .enum(["error", "warning", "note", "none"])
    .optional()
    .describe("Restrict results to a single SARIF severity level."),
  scanner: z
    .string()
    .optional()
    .describe("Restrict results to a single scanner id (e.g. 'semgrep', 'osv-scanner')."),
  ruleId: z.string().optional().describe("Restrict results to a single rule id."),
  filePath: z
    .string()
    .optional()
    .describe("Substring filter on the source file path of the finding."),
  limit: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Maximum number of findings to return (default 500, max 10000)."),
};

interface FindingRow {
  readonly id: string;
  readonly scanner: string;
  readonly ruleId: string;
  readonly severity: string;
  readonly message: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly properties: Record<string, unknown>;
}

interface ListFindingsArgs {
  readonly repo?: string | undefined;
  readonly severity?: "error" | "warning" | "note" | "none" | undefined;
  readonly scanner?: string | undefined;
  readonly ruleId?: string | undefined;
  readonly filePath?: string | undefined;
  readonly limit?: number | undefined;
}

export async function runListFindings(
  ctx: ToolContext,
  args: ListFindingsArgs,
): Promise<ToolResult> {
  const limit = args.limit ?? 500;
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const clauses: string[] = ["kind = 'Finding'"];
      const params: (string | number)[] = [];
      if (args.severity !== undefined) {
        clauses.push("severity = ?");
        params.push(args.severity);
      }
      if (args.scanner !== undefined) {
        clauses.push("scanner_id = ?");
        params.push(args.scanner);
      }
      if (args.ruleId !== undefined) {
        clauses.push("rule_id = ?");
        params.push(args.ruleId);
      }
      if (args.filePath !== undefined) {
        clauses.push("file_path LIKE ?");
        params.push(`%${args.filePath}%`);
      }
      const sql = `SELECT id, scanner_id, rule_id, severity, message, file_path, start_line, end_line, properties_bag FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ${limit}`;
      const raw = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;

      const rows: FindingRow[] = raw.map((r) => {
        const startLine = r["start_line"];
        const endLine = r["end_line"];
        const base: FindingRow = {
          id: String(r["id"]),
          scanner: stringOr(r["scanner_id"], "unknown"),
          ruleId: stringOr(r["rule_id"], ""),
          severity: stringOr(r["severity"], "note"),
          message: stringOr(r["message"], ""),
          filePath: stringOr(r["file_path"], ""),
          properties: parseJsonObject(r["properties_bag"]),
          ...(typeof startLine === "number" && Number.isFinite(startLine) ? { startLine } : {}),
          ...(typeof endLine === "number" && Number.isFinite(endLine) ? { endLine } : {}),
        };
        return base;
      });

      const header = `Findings (${rows.length}) for ${resolved.name}${
        args.severity ? ` · severity=${args.severity}` : ""
      }${args.scanner ? ` · scanner=${args.scanner}` : ""}${
        args.ruleId ? ` · rule=${args.ruleId}` : ""
      }${args.filePath ? ` · filePath~${args.filePath}` : ""}:`;
      const body =
        rows.length === 0
          ? "(no findings matched — run `codehub scan` or `codehub ingest-sarif <log>` to populate Finding nodes)"
          : rows
              .map(
                (f) =>
                  `- [${f.severity}] ${f.scanner}:${f.ruleId} at ${f.filePath}${
                    f.startLine !== undefined ? `:${f.startLine}` : ""
                  }${f.message ? ` — ${f.message}` : ""}`,
              )
              .join("\n");

      const next =
        rows.length === 0
          ? [
              "run `codehub scan` in the target repo to generate findings",
              "call `list_repos` to confirm the repo is indexed",
            ]
          : [
              "call `context` with a finding's file path for caller/callee neighbours",
              "call `sql` with 'SELECT * FROM relations WHERE type = ''FOUND_IN''' for raw edges",
            ];

      return withNextSteps(
        `${header}\n${body}`,
        { findings: rows, total: rows.length },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerListFindingsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_findings",
    {
      title: "List SARIF findings",
      description:
        "Enumerate static-analysis findings stored as Finding nodes, filtered by severity, scanner, rule id, or file path substring. Findings are populated by `codehub ingest-sarif` or `codehub scan`.",
      inputSchema: ListFindingsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => fromToolResult(await runListFindings(ctx, args)),
  );
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function parseJsonObject(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v !== "string") return {};
  if (v.length === 0) return {};
  try {
    const parsed = JSON.parse(v) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
