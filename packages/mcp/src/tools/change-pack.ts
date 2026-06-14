/**
 * `change_pack` — deterministic, diff-scoped context pack for CI agents.
 *
 * Wraps `@opencodehub/analysis.runChangePack`, which composes the diff →
 * per-symbol upstream fan-out (RETAINED as an impacted subgraph, not collapsed
 * to a scalar), the 5-tier verdict, the affected tests, and a char-heuristic
 * cost-attribution estimate. Read-only over the graph; shells out to git for
 * the diff (fails open to an empty pack); calls no LLM and mutates no nodes.
 *
 * Output: the full {@link ChangePack} snake-cased under `structuredContent`
 * (see {@link toStructured}), plus a concise human summary in `content`. The
 * field VALUES are identical to the CLI's `--json` raw camelCase ChangePack;
 * only the key casing differs (the parity test normalizes casing).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runChangePack as analysisRunChangePack, type ChangePack } from "@opencodehub/analysis";
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

const ChangePackInput = {
  base: z.string().optional().describe("Base git ref (default 'main')."),
  head: z.string().optional().describe("Head git ref (default 'HEAD')."),
  depth: z.number().int().positive().optional().describe("Upstream traversal depth (default 4)."),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Traversal confidence floor (default 0.7; 1.0 = SCIP-precise edges only)."),
  budget: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Context budget in heuristic tokens (default 100000)."),
  includeTestsInSubgraph: z
    .boolean()
    .optional()
    .describe(
      "Retain test nodes in the impacted subgraph; default false = tests surface only in affected_tests.",
    ),
  ...repoArgShape,
};

interface ChangePackArgs {
  readonly base?: string | undefined;
  readonly head?: string | undefined;
  readonly depth?: number | undefined;
  readonly minConfidence?: number | undefined;
  readonly budget?: number | undefined;
  readonly includeTestsInSubgraph?: boolean | undefined;
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
}

/**
 * Snake-case the ChangePack for `structuredContent`. The field VALUES match
 * the analysis camelCase ChangePack one-for-one; only the keys are recased so
 * the wire payload follows the rest of the MCP surface's snake_case
 * convention. The parity test compares this (minus envelope keys) against the
 * CLI's raw `--json` ChangePack after normalizing casing.
 */
export function toStructured(pack: ChangePack): Record<string, unknown> {
  return {
    changed_files: pack.changedFiles,
    changed_symbols: pack.changedSymbols,
    impacted_subgraph: {
      nodes: pack.impactedSubgraph.nodes,
      edges: pack.impactedSubgraph.edges,
      node_count: pack.impactedSubgraph.nodeCount,
      edge_count: pack.impactedSubgraph.edgeCount,
      truncated: pack.impactedSubgraph.truncated,
    },
    verdict: pack.verdict,
    affected_tests: pack.affectedTests,
    cost_attribution: {
      estimate: pack.costAttribution.estimate,
      tokenizer_model: pack.costAttribution.tokenizerModel,
      change_pack_tokens: pack.costAttribution.changePackTokens,
      blind_baseline_tokens: pack.costAttribution.blindBaselineTokens,
      tokens_saved: pack.costAttribution.tokensSaved,
      tokens_saved_pct: pack.costAttribution.tokensSavedPct,
      affected_test_count: pack.costAttribution.affectedTestCount,
      total_test_count: pack.costAttribution.totalTestCount,
      ci_tests_skipped: pack.costAttribution.ciTestsSkipped,
    },
    change_pack_hash: pack.changePackHash,
  };
}

/** Concise human summary mirroring the verdict/detect_changes text style. */
function renderText(pack: ChangePack): string {
  const lines: string[] = [];
  lines.push(
    `Change-pack: ${pack.changedFiles.length} file(s), ${pack.changedSymbols.length} symbol(s) changed.`,
  );
  lines.push(
    `Impacted subgraph: ${pack.impactedSubgraph.nodeCount} node(s), ${pack.impactedSubgraph.edgeCount} edge(s)${
      pack.impactedSubgraph.truncated ? " (truncated)" : ""
    }.`,
  );
  lines.push(`Verdict: ${pack.verdict.verdict} (exit ${pack.verdict.exitCode}).`);
  lines.push(
    `Affected tests: ${pack.costAttribution.affectedTestCount} of ${pack.costAttribution.totalTestCount}; CI tests skippable: ${pack.costAttribution.ciTestsSkipped}.`,
  );
  lines.push(
    `Tokens saved (est.): ${pack.costAttribution.tokensSaved} (${pack.costAttribution.tokensSavedPct}% vs. blind baseline).`,
  );
  return lines.join("\n");
}

export async function runChangePack(ctx: ToolContext, args: ChangePackArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const pack = await analysisRunChangePack(store.graph, {
        repoPath: resolved.repoPath,
        ...(args.base !== undefined ? { base: args.base } : {}),
        ...(args.head !== undefined ? { head: args.head } : {}),
        ...(args.depth !== undefined ? { depth: args.depth } : {}),
        ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
        ...(args.budget !== undefined ? { budget: args.budget } : {}),
        ...(args.includeTestsInSubgraph !== undefined
          ? { includeTestsInSubgraph: args.includeTestsInSubgraph }
          : {}),
      });

      const next = [
        "call `verdict` for the full PR review gate (reasoning chain + recommended reviewers)",
        "call `impact` on a changed symbol to drill its individual blast radius",
      ];

      return withNextSteps(
        renderText(pack),
        toStructured(pack),
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerChangePackTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "change_pack",
    {
      title: "Diff-scoped change-pack",
      description:
        "Deterministic, diff-scoped context pack for a git range: the impacted upstream subgraph (retained, not collapsed), the 5-tier verdict, the affected tests, and a char-heuristic cost estimate (tokens saved vs. opening every impacted file blind). CI-oriented — read-only, no LLM, byte-deterministic with a content hash.",
      inputSchema: ChangePackInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (args) => fromToolResult(await runChangePack(ctx, args)),
  );
}
