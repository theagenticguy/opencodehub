/**
 * `codehub mcp` — launch the stdio MCP server.
 *
 * Wave 8c ships `@opencodehub/mcp`. Until that package exports
 * `startStdioServer()`, this command surfaces a friendly error instead of a
 * cryptic import failure.
 */

export async function runMcp(): Promise<void> {
  let mod: unknown;
  try {
    // Dynamic string import so TypeScript does not require the dependency to
    // be built at CLI build time. Wave 8c owns the @opencodehub/mcp package.
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
        "Upgrade to the Wave 8c build that wires the stdio transport.",
    );
    process.exit(2);
  }

  await candidate.startStdioServer();
}
