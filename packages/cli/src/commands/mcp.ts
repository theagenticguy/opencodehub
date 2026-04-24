/**
 * `codehub mcp` — launch the stdio MCP server.
 *
 * Surfaces a friendly error instead of a cryptic import failure when
 * `@opencodehub/mcp` has not been built yet.
 */

export async function runMcp(): Promise<void> {
  let mod: unknown;
  try {
    // Dynamic string import so TypeScript does not require the dependency to
    // be built at CLI build time. The @opencodehub/mcp package owns startStdioServer.
    const specifier = "@opencodehub/mcp";
    mod = await import(specifier);
  } catch (err) {
    console.error(
      `codehub mcp: the @opencodehub/mcp package is not built yet. Build it first.\n` +
        `  cause: ${(err as Error).message}`,
    );
    process.exit(2);
  }

  const candidate = mod as {
    startStdioServer?: () => Promise<void>;
  };
  if (typeof candidate.startStdioServer !== "function") {
    console.error(
      "codehub mcp: @opencodehub/mcp does not export startStdioServer(). " +
        "Rebuild @opencodehub/mcp so it exports startStdioServer().",
    );
    process.exit(2);
  }

  await candidate.startStdioServer();
}
