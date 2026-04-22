/**
 * Cursor MCP config writer.
 *
 * Targets `~/.cursor/mcp.json` (global scope). Same `mcpServers` shape as
 * Claude Code, so we reuse the shared merger.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { mergeMcpServers } from "./claude-code.js";
import type { EditorWriter } from "./types.js";

export interface CursorWriterOptions {
  /** Override the home directory used to resolve the config path. */
  readonly home?: string;
}

export function createCursorWriter(opts: CursorWriterOptions = {}): EditorWriter {
  const home = opts.home ?? homedir();
  const configPath = resolve(home, ".cursor", "mcp.json");
  return {
    id: "cursor",
    configPath,
    merge(existing, invocation) {
      return mergeMcpServers(existing, invocation);
    },
  };
}
