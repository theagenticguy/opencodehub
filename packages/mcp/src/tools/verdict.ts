/**
 * `verdict` — 5-tier verdict composition MCP tool.
 *
 * Inputs: base ref (default "main"), head ref (default "HEAD"), optional
 * repo and config overrides. Annotations: readOnly (we do shell out to
 * git for the diff; that remains read-only), closedWorld (all data comes
 * from the indexed graph), NOT idempotent (git state can change between
 * calls).
 *
 * Output: the full {@link VerdictResponse} under `structuredContent`, plus
 * the rendered markdown comment in `content`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computeVerdict } from "@opencodehub/analysis";
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

const VerdictInput = {
  repo: z.string().optional().describe("Registered repo name."),
  base: z.string().optional().describe("Base git ref (default 'main')."),
  head: z.string().optional().describe("Head git ref (default 'HEAD')."),
  config: z
    .object({
      blockThreshold: z.number().int().nonnegative().optional(),
      escalationThreshold: z.number().int().nonnegative().optional(),
      warningThreshold: z.number().int().nonnegative().optional(),
      communityBoundaryThreshold: z.number().int().nonnegative().optional(),
      communityBoundaryEscalation: z.boolean().optional(),
      fixFollowFeatThreshold: z.number().min(0).max(1).optional(),
    })
    .optional()
    .describe(
      "Override the verdict thresholds. Values not supplied fall back to .codehub/config.toml or the PRD defaults.",
    ),
};

interface VerdictConfigArgs {
  readonly blockThreshold?: number | undefined;
  readonly escalationThreshold?: number | undefined;
  readonly warningThreshold?: number | undefined;
  readonly communityBoundaryThreshold?: number | undefined;
  readonly communityBoundaryEscalation?: boolean | undefined;
  readonly fixFollowFeatThreshold?: number | undefined;
}

interface VerdictArgs {
  readonly repo?: string | undefined;
  readonly base?: string | undefined;
  readonly head?: string | undefined;
  readonly config?: VerdictConfigArgs | undefined;
}

export async function runVerdict(ctx: ToolContext, args: VerdictArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const config: Record<string, number | boolean> = {};
      if (args.config) {
        if (args.config.blockThreshold !== undefined)
          config["blockThreshold"] = args.config.blockThreshold;
        if (args.config.escalationThreshold !== undefined)
          config["escalationThreshold"] = args.config.escalationThreshold;
        if (args.config.warningThreshold !== undefined)
          config["warningThreshold"] = args.config.warningThreshold;
        if (args.config.communityBoundaryThreshold !== undefined)
          config["communityBoundaryThreshold"] = args.config.communityBoundaryThreshold;
        if (args.config.communityBoundaryEscalation !== undefined)
          config["communityBoundaryEscalation"] = args.config.communityBoundaryEscalation;
        if (args.config.fixFollowFeatThreshold !== undefined)
          config["fixFollowFeatThreshold"] = args.config.fixFollowFeatThreshold;
      }
      const verdict = await computeVerdict(store, {
        repoPath: resolved.repoPath,
        ...(args.base !== undefined ? { base: args.base } : {}),
        ...(args.head !== undefined ? { head: args.head } : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });

      const next: string[] = [];
      if (verdict.verdict === "block" || verdict.verdict === "expert_review") {
        next.push(
          "call `impact` on each affected symbol to identify reducible scope",
          "call `owners` on the touched files to loop in the top contributor",
        );
      } else if (verdict.verdict === "dual_review") {
        next.push(
          "call `detect_changes` to confirm the full set of affected processes",
          "call `list_findings` filtered by the changed files to spot latent warnings",
        );
      } else {
        next.push(
          "call `list_findings` to confirm the scanner run is clean",
          "commit with the suggested reviewer(s) to de-escalate",
        );
      }

      return withNextSteps(
        verdict.reviewCommentMarkdown,
        {
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          exit_code: verdict.exitCode,
          blast_radius: verdict.blastRadius,
          changed_file_count: verdict.changedFileCount,
          affected_symbol_count: verdict.affectedSymbolCount,
          communities_touched: verdict.communitiesTouched,
          decision_boundary: verdict.decisionBoundary,
          reasoning_chain: verdict.reasoningChain,
          recommended_reviewers: verdict.recommendedReviewers,
          github_labels: verdict.githubLabels,
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

export function registerVerdictTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "verdict",
    {
      title: "5-tier PR verdict",
      description:
        "Composite diff verdict: auto_merge | single_review | dual_review | expert_review | block. Aggregates blast radius, community boundaries, findings, orphan grade, fix-follow-feat density, and ownership into a single decision with confidence, reasoning chain, decision-boundary distance, recommended reviewers, GitHub labels, and a PR-comment markdown string. Exit codes: 0/1/2 mapped per PRD.",
      inputSchema: VerdictInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (args) => fromToolResult(await runVerdict(ctx, args)),
  );
}
