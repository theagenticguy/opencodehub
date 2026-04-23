/**
 * OpenAI Codex CLI MCP config writer.
 *
 * Targets `~/.codex/config.toml` — the only TOML config of the five. Shape:
 *
 *   [mcp_servers.codehub]
 *   command = "codehub"
 *   args = ["mcp"]
 *   env = { ... }
 *
 * We round-trip the file via `@iarna/toml`. The library preserves string
 * values and key ordering for tables we don't touch; we only rewrite the
 * `[mcp_servers.codehub]` table. Other `[mcp_servers.*]` tables and unrelated
 * top-level tables are preserved verbatim.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import * as TOML from "@iarna/toml";
import type { EditorWriter, McpInvocation } from "./types.js";

export interface CodexWriterOptions {
  readonly home?: string;
}

export function createCodexWriter(opts: CodexWriterOptions = {}): EditorWriter {
  const home = opts.home ?? homedir();
  const configPath = resolve(home, ".codex", "config.toml");
  return {
    id: "codex",
    configPath,
    merge(existing, invocation) {
      return mergeCodexConfig(existing, invocation);
    },
  };
}

export function mergeCodexConfig(existing: string | undefined, invocation: McpInvocation): string {
  const doc = parseTomlObject(existing);
  const servers = isObject(doc["mcp_servers"]) ? { ...doc["mcp_servers"] } : {};
  servers["codehub"] = buildCodexEntry(invocation);
  doc["mcp_servers"] = servers;
  return TOML.stringify(doc as TOML.JsonMap);
}

function buildCodexEntry(invocation: McpInvocation): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: invocation.command,
    args: [...invocation.args],
  };
  if (Object.keys(invocation.env).length > 0) {
    entry["env"] = { ...invocation.env };
  }
  return entry;
}

function parseTomlObject(input: string | undefined): Record<string, unknown> {
  if (input === undefined || input.trim().length === 0) return {};
  const parsed = TOML.parse(input) as unknown;
  if (!isObject(parsed)) {
    throw new Error("Expected Codex config to parse as a TOML table");
  }
  return { ...parsed };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
