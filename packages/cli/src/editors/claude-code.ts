/**
 * Claude Code MCP config writer.
 *
 * Targets `<project>/.mcp.json` by default, which is the `project` scope that
 * gets checked into VCS. Shape:
 *   { "mcpServers": { "<name>": { "command": ..., "args": [...], "env": {...} } } }
 *
 * The writer preserves every top-level key on the file AND every sibling entry
 * under `mcpServers`. Only the `codehub` key is upserted.
 */

import { resolve } from "node:path";
import type { EditorWriter, McpInvocation } from "./types.js";

export interface ClaudeCodeWriterOptions {
  /** Absolute project root. The writer targets `<root>/.mcp.json`. */
  readonly projectRoot: string;
}

export function createClaudeCodeWriter(opts: ClaudeCodeWriterOptions): EditorWriter {
  const configPath = resolve(opts.projectRoot, ".mcp.json");
  return {
    id: "claude-code",
    configPath,
    merge(existing, invocation) {
      return mergeMcpServers(existing, invocation);
    },
  };
}

/**
 * Shared JSON merge for the "mcpServers" shape — used by Claude Code, Cursor,
 * and Windsurf. Exposed so each editor's writer stays a one-liner.
 */
export function mergeMcpServers(existing: string | undefined, invocation: McpInvocation): string {
  const doc = parseJsonObject(existing);
  const servers = isObject(doc["mcpServers"]) ? { ...doc["mcpServers"] } : {};
  servers["codehub"] = buildMcpServersEntry(invocation);
  doc["mcpServers"] = servers;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function buildMcpServersEntry(invocation: McpInvocation): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: invocation.command,
    args: [...invocation.args],
  };
  if (Object.keys(invocation.env).length > 0) {
    entry["env"] = { ...invocation.env };
  }
  return entry;
}

function parseJsonObject(input: string | undefined): Record<string, unknown> {
  if (input === undefined || input.trim().length === 0) return {};
  const parsed = JSON.parse(stripBom(input)) as unknown;
  if (!isObject(parsed)) {
    throw new Error("Expected config file to contain a top-level JSON object");
  }
  return { ...parsed };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
