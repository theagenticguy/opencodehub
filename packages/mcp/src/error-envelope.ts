/**
 * Uniform error envelope for MCP tool responses.
 *
 * The OpenCodeHub PRD (§9.1) defines a single error code enumeration used
 * across the MCP surface. Every tool that fails gracefully (i.e. the tool
 * ran but the operation could not complete) returns this shape so agents
 * can key on `error.code` to decide whether to retry, disambiguate, or
 * abort.
 *
 * For protocol-level failures (unknown tool name, malformed JSON-RPC) the
 * SDK's `McpError` class is thrown instead — those do not go through this
 * helper.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The fixed set of tool-level error codes exposed to MCP clients. */
export type ErrorCode =
  | "STALENESS"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "DB_ERROR"
  | "SCHEMA_MISMATCH"
  | "RATE_LIMITED"
  | "INTERNAL"
  | "NO_INDEX"
  | "AMBIGUOUS_REPO";

/** Structured shape carried under `structuredContent.error`. */
export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
}

/**
 * Build a tool-level error result. Both `content` (for clients that only
 * read text) and `structuredContent` (for clients that honour the output
 * schema) are populated, and `isError` is set so output-schema validation
 * is skipped by the SDK per the 2025-06-18 spec revision.
 */
export function toolError(code: ErrorCode, message: string, hint?: string): CallToolResult {
  const lines = [`Error (${code}): ${message}`];
  if (hint) lines.push(`Hint: ${hint}`);
  const detail: ErrorDetail = hint ? { code, message, hint } : { code, message };
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: { error: detail },
    isError: true,
  };
}

/**
 * Map an arbitrary thrown value to an `INTERNAL` error envelope. Used as a
 * catch-all at the boundary of each tool handler so unexpected exceptions
 * reach the agent as a structured error instead of tearing down the stdio
 * transport.
 */
export function toolErrorFromUnknown(err: unknown, hint?: string): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return toolError("INTERNAL", message, hint);
}
