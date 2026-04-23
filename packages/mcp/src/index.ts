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
