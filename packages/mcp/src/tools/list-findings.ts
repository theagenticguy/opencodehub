/**
 * `list_findings` — enumerate Finding nodes for an indexed repo.
 *
 * Finding nodes are produced by `codehub ingest-sarif` (or `codehub scan`
 * via its built-in ingestion step). Every node carries `scanner_id`,
 * `rule_id`, `severity`, and `message` plus a flat `properties_bag`
 * JSON string for the scanner's custom properties.
 *
 * The shared reader/filter/projection lives in `@opencodehub/core-ops`
 * `findingsCapability` — this tool is the thin MCP adapter: resolve + open the
 * store via `withStore`, run the capability, and render its `FindingsOutput`
 * into the MCP text body + `next_steps` + staleness envelope.
 *
 * Filters (all optional):
 *   - `severity`  — restrict to one SARIF level.
 *   - `scanner`   — restrict to a single scanner id.
 *   - `ruleId`    — restrict to a single rule id.
 *   - `filePath`  — substring match against `file_path`.
 *   - `limit`     — row cap (default 500, max 10_000).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type FindingsInput, findingsCapability } from "@opencodehub/core-ops";
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
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const input: FindingsInput = {
        ...(args.severity !== undefined ? { severity: args.severity } : {}),
        ...(args.scanner !== undefined ? { scanner: args.scanner } : {}),
        ...(args.ruleId !== undefined ? { ruleId: args.ruleId } : {}),
        ...(args.filePath !== undefined ? { filePath: args.filePath } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      };
      const out = await findingsCapability.execute(input, {
        store,
        repoName: resolved.name,
      });

      const header = `Findings (${out.total}) for ${out.repoName}${
        args.severity ? ` · severity=${args.severity}` : ""
      }${args.scanner ? ` · scanner=${args.scanner}` : ""}${
        args.ruleId ? ` · rule=${args.ruleId}` : ""
      }${args.filePath ? ` · filePath~${args.filePath}` : ""}:`;
      const body =
        out.total === 0
          ? "(no findings matched — run `codehub scan` or `codehub ingest-sarif <log>` to populate Finding nodes)"
          : out.findings
              .map(
                (f) =>
                  `- [${f.severity}] ${f.scanner}:${f.ruleId} at ${f.filePath}${
                    f.startLine !== undefined ? `:${f.startLine}` : ""
                  }${f.message ? ` — ${f.message}` : ""}`,
              )
              .join("\n");

      const next =
        out.total === 0
          ? [
              "run `codehub scan` in the target repo to generate findings",
              "call `list_repos` to confirm the repo is indexed",
            ]
          : [
              "call `context` with a finding's file path for caller/callee neighbours",
              "call `sql` with cypher 'MATCH ()-[r:FOUND_IN]->() RETURN r' for raw edges",
            ];

      return withNextSteps(
        `${header}\n${body}`,
        { findings: out.findings, total: out.total },
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
