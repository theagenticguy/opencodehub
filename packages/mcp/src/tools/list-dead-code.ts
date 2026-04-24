/**
 * `list_dead_code` — enumerate dead and unreachable-export symbols.
 *
 * Thin wrapper over {@link classifyDeadness} from `@opencodehub/analysis`.
 * Reports:
 *   - `dead` symbols: non-exported, no inbound referrers.
 *   - `unreachableExports` (opt-in): exported symbols with no cross-module
 *     referrer.
 *   - `ghostCommunities`: Leiden communities whose every member is non-live.
 *
 * Read-only, closed-world, idempotent — consuming the classifier twice with
 * the same inputs returns an identical result.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { classifyDeadness, type DeadSymbol } from "@opencodehub/analysis";
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

const ListDeadCodeInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
  includeUnreachableExports: z
    .boolean()
    .optional()
    .describe(
      "When true, include exported symbols with no cross-module referrer in the `symbols` list. Default false.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Maximum number of symbols to return (default 100, max 10000)."),
  filePathPattern: z
    .string()
    .optional()
    .describe("Substring filter applied to each symbol's file path."),
};

interface ListDeadCodeArgs {
  readonly repo?: string | undefined;
  readonly includeUnreachableExports?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly filePathPattern?: string | undefined;
}

export async function runListDeadCode(
  ctx: ToolContext,
  args: ListDeadCodeArgs,
): Promise<ToolResult> {
  const limit = args.limit ?? 100;
  const includeUnreachable = args.includeUnreachableExports ?? false;
  const pattern = args.filePathPattern;

  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const result = await classifyDeadness(store);

      const filterByPath = (s: DeadSymbol): boolean =>
        pattern === undefined || s.filePath.includes(pattern);

      const dead = result.dead.filter(filterByPath);
      const unreachable = result.unreachableExports.filter(filterByPath);

      const combined: DeadSymbol[] = includeUnreachable ? [...dead, ...unreachable] : [...dead];
      const truncated = combined.slice(0, limit);

      const summary = {
        dead: result.dead.length,
        unreachableExports: result.unreachableExports.length,
        ghostCommunities: result.ghostCommunities.length,
      };

      const header = `Dead code in ${resolved.name}: ${summary.dead} dead · ${summary.unreachableExports} unreachable exports · ${summary.ghostCommunities} ghost communities.`;
      const lines: string[] = [header];
      if (truncated.length === 0) {
        lines.push("(no non-live symbols match the filter)");
      } else {
        lines.push(
          `Showing ${truncated.length} of ${combined.length}${
            pattern ? ` · filePath~${pattern}` : ""
          }:`,
        );
        for (const s of truncated) {
          lines.push(`  • [${s.deadness}] ${s.name} [${s.kind}] — ${s.filePath}:${s.startLine}`);
        }
      }
      if (result.ghostCommunities.length > 0) {
        lines.push(`Ghost communities (${result.ghostCommunities.length}):`);
        for (const c of result.ghostCommunities.slice(0, 20)) {
          lines.push(`  ⊿ ${c}`);
        }
      }

      const next: string[] = [];
      if (summary.dead > 0) {
        next.push("call `remove_dead_code` with dryRun=true to preview the deletion edit plan");
      }
      if (!includeUnreachable && summary.unreachableExports > 0) {
        next.push(
          "re-run with includeUnreachableExports=true to inspect exported-but-unreferenced symbols",
        );
      }
      if (summary.ghostCommunities > 0) {
        next.push(
          "use `context` on a ghost community member to confirm it is truly unreferenced before deletion",
        );
      }
      if (next.length === 0) {
        next.push("graph is clean — no dead code detected");
      }

      return withNextSteps(
        lines.join("\n"),
        {
          summary,
          symbols: truncated,
          ghostCommunities: [...result.ghostCommunities],
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

export function registerListDeadCodeTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_dead_code",
    {
      title: "List dead and unreachable-export symbols",
      description:
        "Classify every callable / type in the indexed graph as live, dead, or unreachable-export and return the non-live set. Also surfaces ghost communities — Leiden clusters whose every member is classified non-live.",
      inputSchema: ListDeadCodeInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runListDeadCode(ctx, args)),
  );
}
