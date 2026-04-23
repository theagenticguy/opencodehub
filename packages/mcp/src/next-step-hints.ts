/**
 * Next-step hint helper.
 *
 * The MCP spec (rev 2025-06-18) does not carve out a first-class "suggest
 * what tool to call next" field. Research-mcp.yaml captures the three
 * in-spec options; we combine two:
 *   (a) a `next_steps: string[]` under `structuredContent` for clients that
 *       consume the output schema, and
 *   (b) a trailing "Suggested next tools:" text block in the primary
 *       `content` array for clients that only ingest text.
 *
 * The `_meta` map under structuredContent carries staleness under a stable
 * `codehub/staleness` namespace so non-aware clients simply ignore it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StalenessEnvelope } from "@opencodehub/core-types";

const STALENESS_META_KEY = "codehub/staleness";

/**
 * Wrap a tool's text + structured payload with next-step hints and an
 * optional staleness envelope. `structured` must be a plain object; the
 * result includes every key from `structured` plus `next_steps` and
 * `_meta`.
 */
export function withNextSteps<T extends Record<string, unknown>>(
  content: string,
  structured: T,
  nextSteps: readonly string[],
  staleness?: StalenessEnvelope,
): CallToolResult {
  const hintBlock =
    nextSteps.length > 0
      ? `\n\nSuggested next tools:\n${nextSteps.map((s) => `- ${s}`).join("\n")}`
      : "";
  const meta: Record<string, unknown> = {};
  if (staleness) meta[STALENESS_META_KEY] = staleness;

  const structuredContent: Record<string, unknown> = {
    ...structured,
    next_steps: [...nextSteps],
  };
  if (Object.keys(meta).length > 0) {
    structuredContent["_meta"] = meta;
  }

  return {
    content: [{ type: "text" as const, text: content + hintBlock }],
    structuredContent,
  };
}
