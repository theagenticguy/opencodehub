/**
 * `impact` — blast-radius analysis for a symbol.
 *
 * Delegates to `@opencodehub/analysis.runImpact`. When the analysis
 * layer reports `ambiguous: true` we surface the candidate list so the
 * caller can re-call with a fully qualified node id — mirroring the
 * same EC-04 disambiguation pattern used by `context`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callRunImpact } from "../analysis-bridge.js";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const ImpactInput = {
  target: z
    .string()
    .min(1)
    .describe("Node id OR symbol name of the change target. Node id gives an exact match."),
  direction: z
    .enum(["upstream", "downstream", "both"])
    .optional()
    .describe(
      "upstream = dependents (who breaks if this changes), downstream = dependencies, both = transitive both ways. Default: upstream.",
    ),
  maxDepth: z.number().int().min(1).max(6).optional().describe("Traversal depth cap. Default 3."),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop edges below this confidence. Default 0.3."),
  relationTypes: z
    .array(z.string())
    .optional()
    .describe("Limit to specific RelationType values (default: CALLS + override/impl edges)."),
  repo: z.string().optional().describe("Registered repo name."),
};

export function registerImpactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "impact",
    {
      title: "Change-impact blast radius",
      description:
        "Walk the graph from a target symbol and group dependents by traversal depth. Depth-1 nodes will definitely break if the target's contract changes; depth-2 very likely; depth-3+ transitive. Returns a risk band (LOW/MEDIUM/HIGH/CRITICAL) derived from direct-dependent count.",
      inputSchema: ImpactInput,
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
            target: string;
            direction: "upstream" | "downstream" | "both";
            maxDepth?: number;
            minConfidence?: number;
            relationTypes?: readonly string[];
          } = {
            target: args.target,
            direction: args.direction ?? "upstream",
          };
          if (args.maxDepth !== undefined) q.maxDepth = args.maxDepth;
          if (args.minConfidence !== undefined) q.minConfidence = args.minConfidence;
          if (args.relationTypes && args.relationTypes.length > 0) {
            q.relationTypes = args.relationTypes;
          }
          const result = await callRunImpact(store, q);

          if (result.ambiguous) {
            const cands = result.targetCandidates.slice(0, 10);
            const list = cands
              .map((c, i) => `${i + 1}. [${c.kind}] ${c.name} — ${c.filePath}  (${c.id})`)
              .join("\n");
            return withNextSteps(
              `"${args.target}" matched ${result.targetCandidates.length} candidate(s). Re-call with a specific node id.\n${list}`,
              {
                target: args.target,
                ambiguous: true,
                candidates: result.targetCandidates,
                byDepth: [],
                risk: result.risk,
              },
              ["call `impact` again with one of the listed node ids"],
              stalenessFromMeta(resolved.meta),
            );
          }

          const chosen = result.chosenTarget;
          const chosenLabel = chosen ? `${chosen.name} [${chosen.kind}]` : args.target;
          const lines: string[] = [];
          lines.push(`Impact for ${chosenLabel} (${q.direction}, depth≤${q.maxDepth ?? 3})`);
          lines.push(`Risk: ${result.risk} (${result.totalAffected} total affected)`);
          for (const bucket of result.byDepth) {
            lines.push(`d=${bucket.depth} (${bucket.nodes.length}):`);
            for (const n of bucket.nodes.slice(0, 20)) {
              lines.push(
                `  • ${n.name} [${n.kind}] via ${n.viaRelation} — ${n.filePath || "(no file)"}`,
              );
            }
            if (bucket.nodes.length > 20) {
              lines.push(`  … ${bucket.nodes.length - 20} more`);
            }
          }
          if (result.hint) lines.push(`Hint: ${result.hint}`);

          const next: string[] = [];
          const d1 = result.byDepth.find((b) => b.depth === 1)?.nodes.length ?? 0;
          if (d1 > 0) {
            next.push("review d1 nodes first — they will definitely break");
            next.push("call `context` on each d1 node to craft targeted tests");
          } else {
            next.push("no direct dependents — this change looks safe");
          }

          return withNextSteps(
            lines.join("\n"),
            {
              target: chosen ?? null,
              risk: result.risk,
              total_affected: result.totalAffected,
              byDepth: result.byDepth,
              ambiguous: false,
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
