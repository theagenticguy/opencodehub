/**
 * OpenCode MCP config writer.
 *
 * Targets `<project>/opencode.json`. The OpenCode schema deviates from the
 * others:
 *   - top-level key is `mcp`, NOT `mcpServers`
 *   - each entry uses `type: "local"` (not `stdio`)
 *   - `command` is a single ARRAY `[exec, ...args]`, not `command` + `args`
 *   - env lives under `environment`, not `env`
 *   - `enabled` and `timeout` are conventional extras
 *
 * Other top-level keys and other entries under `mcp` are preserved.
 */

import { resolve } from "node:path";
import type { EditorWriter, McpInvocation } from "./types.js";

export interface OpenCodeWriterOptions {
  /** Absolute project root. The writer targets `<root>/opencode.json`. */
  readonly projectRoot: string;
  /** Optional timeout in ms for the MCP server startup. Default 10_000. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createOpenCodeWriter(opts: OpenCodeWriterOptions): EditorWriter {
  const configPath = resolve(opts.projectRoot, "opencode.json");
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: "opencode",
    configPath,
    merge(existing, invocation) {
      return mergeOpenCodeConfig(existing, invocation, timeout);
    },
  };
}

export function mergeOpenCodeConfig(
  existing: string | undefined,
  invocation: McpInvocation,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): string {
  const doc = parseJsonObject(existing);
  const mcp = isObject(doc["mcp"]) ? { ...doc["mcp"] } : {};
  mcp["codehub"] = buildOpenCodeEntry(invocation, timeoutMs);
  doc["mcp"] = mcp;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function buildOpenCodeEntry(invocation: McpInvocation, timeoutMs: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: "local",
    command: [invocation.command, ...invocation.args],
    enabled: true,
    timeout: timeoutMs,
  };
  if (Object.keys(invocation.env).length > 0) {
    entry["environment"] = { ...invocation.env };
  }
  return entry;
}

function parseJsonObject(input: string | undefined): Record<string, unknown> {
  if (input === undefined || input.trim().length === 0) return {};
  const parsed = JSON.parse(stripBom(input)) as unknown;
  if (!isObject(parsed)) {
    throw new Error("Expected opencode.json to contain a top-level object");
  }
  return { ...parsed };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
