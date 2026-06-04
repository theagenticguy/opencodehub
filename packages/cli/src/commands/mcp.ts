/**
 * `codehub mcp` — launch the stdio MCP server.
 *
 * `@opencodehub/mcp` is bundled into this CLI at build time (the workspace
 * libraries are inlined — see `packages/cli/tsup.config.ts`), so a static
 * import is correct: there is no separately-installed package to probe for.
 */

import { startStdioServer } from "@opencodehub/mcp";

export async function runMcp(): Promise<void> {
  await startStdioServer();
}
