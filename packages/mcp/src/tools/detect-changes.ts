/**
 * `detect_changes` — map a git diff to affected graph symbols & processes.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callRunDetectChanges } from "../analysis-bridge.js";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const DetectChangesInput = {
  scope: z
    .enum(["unstaged", "staged", "all", "compare"])
    .describe(
      "unstaged = working-tree diff, staged = index diff, all = union, compare = diff vs compareRef.",
    ),
  compareRef: z
    .string()
    .optional()
    .describe("Git ref to compare against (only used when scope='compare')."),
  repo: z.string().optional().describe("Registered repo name."),
};

export function registerDetectChangesTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "detect_changes",
    {
      title: "Map git diff to indexed symbols",
      description:
        "Parse the repo's git diff for the requested scope (unstaged, staged, all, or compared to a ref) and map every changed line back to indexed symbols. Lists the affected processes so agents can spot flows impacted by a commit before pushing.",
      inputSchema: DetectChangesInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      return withStore(ctx, args.repo, async (store, resolved) => {
        try {
          const q: {
            scope: "unstaged" | "staged" | "all" | "compare";
            repoPath: string;
            compareRef?: string;
          } = { scope: args.scope, repoPath: resolved.repoPath };
          if (args.compareRef !== undefined) q.compareRef = args.compareRef;
          const result = await callRunDetectChanges(store, q);

          const lines: string[] = [];
          lines.push(
            `${result.summary.fileCount} file(s), ${result.summary.symbolCount} symbol(s), ${result.summary.processCount} process(es) affected. Risk: ${result.summary.risk}.`,
          );
          if (result.changedFiles.length > 0) {
            lines.push(`Changed files:`);
            for (const f of result.changedFiles.slice(0, 30)) lines.push(`  • ${f}`);
          }
          if (result.affectedSymbols.length > 0) {
            lines.push(`Affected symbols (${result.affectedSymbols.length}):`);
            for (const s of result.affectedSymbols.slice(0, 50)) {
              lines.push(`  • ${s.name} [${s.kind}] — ${s.filePath}`);
            }
          }
          if (result.affectedProcesses.length > 0) {
            lines.push(`Affected processes (${result.affectedProcesses.length}):`);
            for (const p of result.affectedProcesses) {
              lines.push(`  ⊿ ${p.name}`);
            }
          }

          const next =
            result.affectedSymbols.length > 0
              ? [
                  "call `impact` on each affected symbol for per-change risk",
                  "call `query` with the feature name to confirm test coverage",
                ]
              : ["no indexed symbols touched — change may be to docs or tests only"];

          return withNextSteps(
            lines.join("\n"),
            {
              summary: result.summary,
              changed_files: result.changedFiles,
              affected_symbols: result.affectedSymbols,
              affected_processes: result.affectedProcesses,
            },
            next,
            stalenessFromMeta(resolved.meta),
          );
        } catch (err) {
          return toolErrorFromUnknown(err);
        }
      });
    },
  );
}
