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
  | "AMBIGUOUS_REPO"
  | "EMBEDDER_MISMATCH";

/** Structured shape carried under `structuredContent.error`. */
export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
}

/**
 * One registered repo exposed to the caller in an `AMBIGUOUS_REPO` envelope
 * so the LLM can retry with an explicit `repo_uri`. Snake-case wire fields
 * are intentional — this shape crosses the MCP boundary to an agent, and
 * the research spec (§6.2 of research-m5m6.yaml) names them that way.
 *
 * `repo_uri` is derived from the registry at error-construction time. Once
 * AC-M6-1's `RepoNode` type lands in M7, this field will be pulled from
 * the registry-backed node instead of being computed from
 * `RegistryEntry.name`.
 */
export interface RepoChoice {
  readonly repo_uri: string;
  readonly default_branch: string | null;
  readonly group: string | null;
}

/**
 * Extended detail shape for `AMBIGUOUS_REPO`. Retains the legacy
 * `{ code, message, hint }` surface so existing callers (and tests at
 * error-envelope.test.ts:39-47) keep working; adds structured fields for
 * LLM disambiguation.
 */
export interface AmbiguousRepoDetail extends ErrorDetail {
  readonly code: "AMBIGUOUS_REPO";
  /** Alias of `code` — matches the `error_code` field in the research spec. */
  readonly error_code: "AMBIGUOUS_REPO";
  /** JSON-RPC code for "invalid params" — per MCP spec. */
  readonly jsonrpc_code: -32602;
  /** Capped at 10 — see AC-M6-2 §5. */
  readonly choices: readonly RepoChoice[];
  /** Full count of matching registry entries (may exceed `choices.length`). */
  readonly total_matches: number;
}

/**
 * Input to {@link toolAmbiguousRepoError}. Caller (typically the repo
 * resolver at `repo-resolver.ts`) provides the full choice set; this
 * builder caps it to 10 and reports the untruncated total.
 */
export interface AmbiguousRepoPayload {
  readonly message: string;
  readonly hint: string;
  readonly choices: readonly RepoChoice[];
  readonly totalMatches: number;
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

/**
 * Max number of `choices[]` entries carried in an AMBIGUOUS_REPO envelope.
 * More than 10 gets truncated; `total_matches` still reports the full count
 * so the caller knows there is more.
 */
export const AMBIGUOUS_REPO_CHOICES_CAP = 10;

/**
 * Build a structured AMBIGUOUS_REPO envelope. Wraps {@link toolError} so
 * the legacy `{ code, message, hint }` fields stay intact (back-compat with
 * `error-envelope.test.ts:39-47`) and layers on `error_code`, `choices[]`,
 * `total_matches` for disambiguation by an agent.
 *
 * Choices are capped at {@link AMBIGUOUS_REPO_CHOICES_CAP}; `total_matches`
 * always reports the pre-truncation count.
 */
export function toolAmbiguousRepoError(payload: AmbiguousRepoPayload): CallToolResult {
  const capped = payload.choices.slice(0, AMBIGUOUS_REPO_CHOICES_CAP);
  const base = toolError("AMBIGUOUS_REPO", payload.message, payload.hint);
  const baseDetail = (base.structuredContent as { error: ErrorDetail }).error;
  const detail: AmbiguousRepoDetail = {
    code: "AMBIGUOUS_REPO",
    message: baseDetail.message,
    ...(baseDetail.hint !== undefined ? { hint: baseDetail.hint } : {}),
    error_code: "AMBIGUOUS_REPO",
    jsonrpc_code: -32602,
    choices: capped,
    total_matches: payload.totalMatches,
  };
  return {
    content: base.content,
    structuredContent: { error: detail },
    isError: true,
  };
}
