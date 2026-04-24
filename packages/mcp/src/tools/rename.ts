/**
 * `rename` — graph-coordinated symbol rename.
 *
 * Dry-run is the default: callers must explicitly set `dry_run: false` to
 * apply edits. All file I/O is mediated by the analysis package's
 * `createNodeFs()` abstraction so we do not touch disk from this module.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callRunRename } from "../analysis-bridge.js";
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

const RenameInput = {
  symbol_name: z
    .string()
    .min(1)
    .describe("The symbol to rename. Combine with `file` if the name is ambiguous."),
  new_name: z
    .string()
    .min(1)
    .describe("The new identifier. Must be a valid identifier in the target language."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Preview-only when true (DEFAULT). Set to false explicitly to write changes to disk.",
    ),
  file: z
    .string()
    .optional()
    .describe("File path suffix to narrow the rename to a specific definition."),
  repo: z.string().optional().describe("Registered repo name."),
};

interface RenameArgs {
  readonly symbol_name: string;
  readonly new_name: string;
  readonly dry_run?: boolean | undefined;
  readonly file?: string | undefined;
  readonly repo?: string | undefined;
}

export async function runRename(ctx: ToolContext, args: RenameArgs): Promise<ToolResult> {
  const dryRun = args.dry_run ?? true;
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const q: {
        symbolName: string;
        newName: string;
        dryRun?: boolean;
        scope?: { filePath?: string };
      } = {
        symbolName: args.symbol_name,
        newName: args.new_name,
        dryRun,
      };
      if (args.file) q.scope = { filePath: args.file };
      const result = await callRunRename(store, q, resolved.repoPath);

      if (result.ambiguous) {
        return withNextSteps(
          `"${args.symbol_name}" is ambiguous — pass \`file\` to narrow the target.${
            result.hint ? `\n${result.hint}` : ""
          }`,
          {
            status: "rejected",
            ambiguous: true,
            files_affected: 0,
            total_edits: 0,
            graph_edits: 0,
            text_edits: 0,
            changes: [],
          },
          ["call `context` first to pick a concrete definition"],
          stalenessFromMeta(resolved.meta),
        );
      }

      const graphEdits = result.edits.filter((e) => e.source === "graph").length;
      const textEdits = result.edits.length - graphEdits;
      const filesAffected = new Set(result.edits.map((e) => e.filePath)).size;
      const status: "dry-run" | "applied" | "rejected" = result.applied ? "applied" : "dry-run";

      const header = `Rename ${args.symbol_name} → ${args.new_name} (${status})`;
      const lines: string[] = [header];
      lines.push(
        `Files affected: ${filesAffected} | edits: ${result.edits.length} | graph: ${graphEdits} | text: ${textEdits}`,
      );
      for (const edit of result.edits.slice(0, 50)) {
        lines.push(
          `  ${edit.source === "graph" ? "✓" : "?"} ${edit.filePath}:${edit.line}:${edit.column}  "${edit.before}" → "${edit.after}"  (conf ${edit.confidence.toFixed(2)})`,
        );
      }
      if (result.edits.length > 50) {
        lines.push(`  … ${result.edits.length - 50} more`);
      }
      if (result.skipped.length > 0) {
        lines.push(`Skipped files (${result.skipped.length}):`);
        for (const s of result.skipped.slice(0, 20)) {
          lines.push(`  ⚠ ${s.filePath}: ${s.reason}`);
        }
      }
      if (result.hint) lines.push(`Hint: ${result.hint}`);

      const next: string[] = [];
      if (dryRun && result.edits.length > 0) {
        next.push("if the preview looks right, re-call with dry_run=false to apply the edits");
      }
      if (textEdits > 0) {
        next.push(
          `review the ${textEdits} text-based edit(s) before applying — they are best-effort`,
        );
      }
      if (result.edits.length === 0) {
        next.push(
          "no edits planned — confirm the symbol exists via `context` and try again with `file`",
        );
      }

      return withNextSteps(
        lines.join("\n"),
        {
          status,
          files_affected: filesAffected,
          total_edits: result.edits.length,
          graph_edits: graphEdits,
          text_edits: textEdits,
          changes: result.edits,
          skipped: result.skipped,
        },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerRenameTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "rename",
    {
      title: "Coordinated symbol rename",
      description:
        "Produce a graph-coordinated rename plan. Graph-backed edits (tagged `graph`) are high-confidence; fall-back text-search edits (tagged `text`) should be reviewed before applying. DEFAULT is dry-run — the tool will not write to disk unless `dry_run: false` is passed explicitly.",
      inputSchema: RenameInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runRename(ctx, args)),
  );
}
