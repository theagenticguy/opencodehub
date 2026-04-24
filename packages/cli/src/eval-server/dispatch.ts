/**
 * Tool dispatch table for the `codehub eval-server` HTTP surface.
 *
 * Maps tool name (as passed in the URL path) to the corresponding pure
 * `run*` handler from `@opencodehub/mcp`. The HTTP layer converts JSON
 * request bodies straight into the handler's arg object — we rely on the
 * handler's own input validation rather than re-implementing zod schemas
 * here. Any handler throw is reshaped into an `INVALID_INPUT`-style
 * ToolResult by `runDispatch` so the HTTP layer never surfaces 500s from
 * user-supplied bad input.
 */

import {
  runApiImpact,
  runContext,
  runDependencies,
  runDetectChanges,
  runGroupContracts,
  runGroupList,
  runGroupQuery,
  runGroupStatus,
  runImpact,
  runLicenseAudit,
  runListDeadCode,
  runListFindings,
  runListFindingsDelta,
  runListRepos,
  runOwners,
  runProjectProfile,
  runQuery,
  runRemoveDeadCode,
  runRename,
  runRiskTrends,
  runRouteMap,
  runScan,
  runShapeCheck,
  runSignature,
  runSql,
  runToolMap,
  runVerdict,
  type ToolContext,
  type ToolResult,
} from "@opencodehub/mcp";

// biome-ignore lint/suspicious/noExplicitAny: HTTP body shape is intentionally untyped at the dispatch boundary
type AnyArgs = any;
export type ToolHandler = (ctx: ToolContext, args: AnyArgs) => Promise<ToolResult>;

/**
 * Argless handlers are lifted into a (ctx, _args) shape so every entry in
 * the dispatch table has the same call signature. The `_args` parameter
 * is ignored; the HTTP layer still validates that the body (if any) was
 * valid JSON before dispatch.
 */
function ignoreArgs(fn: (ctx: ToolContext) => Promise<ToolResult>): ToolHandler {
  return async (ctx) => fn(ctx);
}

export const TOOL_DISPATCH: Readonly<Record<string, ToolHandler>> = Object.freeze({
  api_impact: runApiImpact,
  context: runContext,
  dependencies: runDependencies,
  detect_changes: runDetectChanges,
  group_contracts: runGroupContracts,
  group_list: ignoreArgs(runGroupList),
  group_query: runGroupQuery,
  group_status: runGroupStatus,
  impact: runImpact,
  license_audit: runLicenseAudit,
  list_dead_code: runListDeadCode,
  list_findings: runListFindings,
  list_findings_delta: runListFindingsDelta,
  list_repos: ignoreArgs(runListRepos),
  owners: runOwners,
  project_profile: runProjectProfile,
  query: runQuery,
  remove_dead_code: runRemoveDeadCode,
  rename: runRename,
  risk_trends: runRiskTrends,
  route_map: runRouteMap,
  scan: runScan,
  shape_check: runShapeCheck,
  signature: runSignature,
  sql: runSql,
  tool_map: runToolMap,
  verdict: runVerdict,
} satisfies Record<string, ToolHandler>);

export const KNOWN_TOOLS: readonly string[] = Object.freeze(Object.keys(TOOL_DISPATCH).sort());

/**
 * Invoke a registered tool by name. Returns `undefined` when the tool
 * name is not in the dispatch table so the caller can render a 404. Any
 * error thrown inside the handler becomes a `ToolResult` with
 * `isError: true` rather than propagating — HTTP callers always get a
 * well-formed text body.
 */
export async function runDispatch(
  toolName: string,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolResult | undefined> {
  const handler = TOOL_DISPATCH[toolName];
  if (!handler) return undefined;
  try {
    return await handler(ctx, args ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      structuredContent: {
        error: { code: "TOOL_ERROR", message },
      },
      text: `Error in ${toolName}: ${message}`,
      isError: true,
    };
  }
}
