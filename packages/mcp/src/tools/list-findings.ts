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
  repoArgShape,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const ListFindingsInput = {
  ...repoArgShape,
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
  readonly repo_uri?: string | undefined;
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
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      // listFindings narrows by severity / ruleId at the storage tier.
      // scanner / filePath substring are applied in TS post-finder.
      const findingsOpts: {
        severity?: readonly ("note" | "warning" | "error")[];
        ruleId?: string;
        limit?: number;
      } = { limit };
      if (
        args.severity !== undefined &&
        (args.severity === "note" || args.severity === "warning" || args.severity === "error")
      ) {
        findingsOpts.severity = [args.severity];
      }
      if (args.ruleId !== undefined) findingsOpts.ruleId = args.ruleId;
      const all = await store.graph.listFindings(findingsOpts);

      const filtered = all.filter((f) => {
        if (args.severity === "none" && f.severity !== "none") return false;
        if (args.scanner !== undefined && f.scannerId !== args.scanner) return false;
        if (args.filePath !== undefined && !f.filePath.includes(args.filePath)) return false;
        return true;
      });

      const rows: FindingRow[] = filtered.map((f) => {
        const base: FindingRow = {
          id: f.id,
          scanner: stringOr(f.scannerId, "unknown"),
          ruleId: stringOr(f.ruleId, ""),
          severity: stringOr(f.severity, "note"),
          message: stringOr(f.message, ""),
          filePath: stringOr(f.filePath, ""),
          properties: f.propertiesBag,
          ...(typeof f.startLine === "number" && Number.isFinite(f.startLine)
            ? { startLine: f.startLine }
            : {}),
          ...(typeof f.endLine === "number" && Number.isFinite(f.endLine)
            ? { endLine: f.endLine }
            : {}),
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
