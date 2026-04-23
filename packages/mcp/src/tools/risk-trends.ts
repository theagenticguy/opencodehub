/**
 * `risk_trends` — classify risk trajectory per community.
 *
 * Reads the snapshot history written by the risk-snapshot phase
 * (`.codehub/history/risk_*.json`) and returns per-community trend +
 * 30-day projected risk plus an overall aggregate.
 *
 * Pure read; idempotent; closed-world.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computeRiskTrends, loadSnapshots } from "@opencodehub/analysis";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const RiskTrendsInput = {
  repo: z.string().optional().describe("Registered repo name."),
};

export function registerRiskTrendsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "risk_trends",
    {
      title: "Per-community risk trend + 30-day projection",
      description:
        "Classify each community's recent risk arc over persisted snapshots. Returns { trend: accelerating_risk | degrading | improving | stable, projectedRisk30d, currentRisk } per community plus an overall trend. Snapshots are populated by `codehub analyze`; if the history is empty this tool returns overallTrend='stable' and an empty map.",
      inputSchema: RiskTrendsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      return withStore(ctx, args.repo, async (_store, resolved) => {
        try {
          const snapshots = await loadSnapshots(resolved.repoPath);
          const trends = computeRiskTrends(snapshots);
          const lines: string[] = [];
          lines.push(
            `Risk trends for ${resolved.name}: overall=${trends.overallTrend} (${trends.snapshotCount} snapshots).`,
          );
          const ids = Object.keys(trends.communities).sort();
          if (ids.length === 0) {
            lines.push(
              "(no community trends yet — run `codehub analyze` a few times to build history)",
            );
          } else {
            for (const id of ids.slice(0, 30)) {
              const entry = trends.communities[id];
              if (entry === undefined) continue;
              lines.push(
                `- ${id}: ${entry.trend} (current=${entry.currentRisk.toFixed(3)}, 30d=${entry.projectedRisk30d.toFixed(3)})`,
              );
            }
            if (ids.length > 30) lines.push(`… ${ids.length - 30} more communities`);
          }

          const next =
            trends.snapshotCount === 0
              ? [
                  "run `codehub analyze` to persist the first snapshot",
                  "call `risk_trends` again after multiple analyze runs to see trend lines",
                ]
              : [
                  "call `detect_changes` to see whether the latest changes correlate with rising risk",
                  "call `verdict` to check PR-level implications of the current trajectory",
                ];

          return withNextSteps(
            lines.join("\n"),
            {
              overall_trend: trends.overallTrend,
              snapshot_count: trends.snapshotCount,
              communities: trends.communities,
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
