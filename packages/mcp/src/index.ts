/**
 * Barrel for `@opencodehub/mcp`.
 *
 * The CLI's `codehub mcp` subcommand imports `startStdioServer` to host
 * the server in-process. Tests import `buildServer` directly so they
 * can drive tool handlers without a stdio transport.
 */

export {
  ConnectionPool,
  type ConnectionPoolOptions,
  type StoreFactory,
} from "./connection-pool.js";
export {
  type ErrorCode,
  type ErrorDetail,
  toolError,
  toolErrorFromUnknown,
} from "./error-envelope.js";
export { withNextSteps } from "./next-step-hints.js";
export {
  type RegistryEntry,
  RepoResolveError,
  type ResolvedRepo,
  readRegistry,
  resolveRepo,
} from "./repo-resolver.js";
export {
  buildServer,
  type RunningServer,
  type StartServerOptions,
  startStdioServer,
} from "./server.js";
export { stalenessFromMeta } from "./staleness.js";
export { runApiImpact } from "./tools/api-impact.js";
export { runContext } from "./tools/context.js";
export { runDependencies } from "./tools/dependencies.js";
export { runDetectChanges } from "./tools/detect-changes.js";
export { runGroupContracts } from "./tools/group-contracts.js";
export { runGroupList } from "./tools/group-list.js";
export { runGroupQuery } from "./tools/group-query.js";
export { runGroupStatus } from "./tools/group-status.js";
export { runGroupSyncTool } from "./tools/group-sync.js";
export { runImpact } from "./tools/impact.js";
export { runLicenseAudit } from "./tools/license-audit.js";
export { runListDeadCode } from "./tools/list-dead-code.js";
export { runListFindings } from "./tools/list-findings.js";
export { runListFindingsDelta } from "./tools/list-findings-delta.js";
export { runListRepos } from "./tools/list-repos.js";
export { runOwners } from "./tools/owners.js";
export { runProjectProfile } from "./tools/project-profile.js";
export { runQuery } from "./tools/query.js";
export { runRemoveDeadCode } from "./tools/remove-dead-code.js";
export { runRename } from "./tools/rename.js";
export { runRiskTrends } from "./tools/risk-trends.js";
export { runRouteMap } from "./tools/route-map.js";
export { runScan } from "./tools/scan.js";
export { runShapeCheck } from "./tools/shape-check.js";
// Pure tool handlers for non-SDK callers (e.g. the CLI `eval-server`
// subcommand). Every run function takes a `ToolContext` and returns a
// transport-agnostic `ToolResult` with both `text` and `structuredContent`.
export {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
} from "./tools/shared.js";
export { runSignature } from "./tools/signature.js";
export { runSql } from "./tools/sql.js";
export { runToolMap } from "./tools/tool-map.js";
export { runVerdict } from "./tools/verdict.js";

// Allow `node dist/index.js` to boot the stdio server directly. The CLI
// package's `codehub mcp` binary imports `startStdioServer` instead so
// it can pre-parse its own flags before handing off to us.
if (
  process.argv[1] &&
  (process.argv[1].endsWith("/dist/index.js") || process.argv[1].endsWith("\\dist\\index.js"))
) {
  const { startStdioServer } = await import("./server.js");
  await startStdioServer();
}
