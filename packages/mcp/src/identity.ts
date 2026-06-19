/**
 * Server identity constants, extracted so both `buildServer` (which passes
 * them to the SDK `McpServer`) and the `server/discover` handler (E-C10,
 * which advertises them as `serverInfo`) read from one source of truth.
 */

export const SERVER_NAME = "opencodehub" as const;
export const SERVER_VERSION = "0.0.0" as const;
