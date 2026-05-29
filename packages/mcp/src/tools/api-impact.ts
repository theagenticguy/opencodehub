/**
 * `api_impact` — score the blast radius of changing a Route's contract.
 *
 * For every Route matching the filter (`route` substring, or `file`
 * substring against Route.filePath) we compute:
 *   - consumers           = files with outgoing FETCHES → this Route.
 *   - middleware          = handlers reached via HANDLES_ROUTE (typically
 *                           File ids; Operation ids when the OpenAPI
 *                           phase linked a spec).
 *   - mismatches          = consumer files whose accessed keys are not a
 *                           subset of Route.responseKeys (delegated to
 *                           `classifyShape` from shape-check).
 *   - affectedProcesses   = Process nodes whose PROCESS_STEP edges walk
 *                           through any of the consumer symbols.
 *
 * Risk banding (deterministic):
 *   LOW      — 0 consumers and 0 mismatches.
 *   MEDIUM   — 1-4 consumers, 0 mismatches.
 *   HIGH     — 5-19 consumers OR any mismatch.
 *   CRITICAL — ≥ 20 consumers.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ApiImpactRow, listApiImpact, type RiskLevel, worseRisk } from "@opencodehub/analysis";
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

const ApiImpactInput = {
  ...repoArgShape,
  route: z.string().optional().describe("Substring match against Route.url."),
  file: z.string().optional().describe("Substring match against Route.filePath."),
};

// `Risk` was the original MCP-side name for the risk union; it now aliases the
// shared `RiskLevel` exported by @opencodehub/analysis. Re-exported for
// backward compatibility along with the row type.
export type Risk = RiskLevel;
export type { ApiImpactRow };

interface ApiImpactArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly route?: string | undefined;
  readonly file?: string | undefined;
}

export async function runApiImpact(ctx: ToolContext, args: ApiImpactArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const rows = await listApiImpact(store.graph, {
        ...(args.route !== undefined ? { route: args.route } : {}),
        ...(args.file !== undefined ? { file: args.file } : {}),
      });

      const header = `api_impact — ${rows.length} route(s) for ${resolved.name}${
        args.route ? ` · url~${args.route}` : ""
      }${args.file ? ` · filePath~${args.file}` : ""}:`;
      const body =
        rows.length === 0
          ? "(no routes matched — check the filter or re-index with `codehub analyze`)"
          : rows
              .map(
                (r) =>
                  `- [${r.risk}] ${r.route.method} ${r.route.url} consumers=${r.consumers.length} mismatches=${r.mismatches.length} processes=${r.affectedProcesses.length}`,
              )
              .join("\n");

      const highest = rows.reduce<Risk>((acc, r) => worseRisk(acc, r.risk), "LOW");
      const next =
        rows.length === 0
          ? ["call `route_map` to list available routes"]
          : highest === "CRITICAL" || highest === "HIGH"
            ? [
                `call \`shape_check\` with route="${rows[0]?.route.url ?? ""}" to see per-consumer mismatches`,
                `call \`context\` on a consumer file to plan migration`,
              ]
            : [
                "low blast radius — route change should be safe",
                "still verify with `shape_check` before merging",
              ];

      return withNextSteps(
        `${header}\n${body}`,
        { routes: rows, highestRisk: highest },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerApiImpactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "api_impact",
    {
      title: "Route change blast radius",
      description:
        "Score the blast radius of changing a Route's contract. Returns risk (LOW/MEDIUM/HIGH/CRITICAL) plus the consumer files, middleware handlers, shape mismatches, and affected Process flows for every matching Route. Read-only.",
      inputSchema: ApiImpactInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runApiImpact(ctx, args)),
  );
}
