/**
 * Windsurf MCP config writer.
 *
 * Targets `~/.codeium/windsurf/mcp_config.json`. Same `mcpServers` shape as
 * Claude Code / Cursor.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { mergeMcpServers } from "./claude-code.js";
import type { EditorWriter } from "./types.js";

export interface WindsurfWriterOptions {
  readonly home?: string;
}

export function createWindsurfWriter(opts: WindsurfWriterOptions = {}): EditorWriter {
  const home = opts.home ?? homedir();
  const configPath = resolve(home, ".codeium", "windsurf", "mcp_config.json");
  return {
    id: "windsurf",
    configPath,
    merge(existing, invocation) {
      return mergeMcpServers(existing, invocation);
    },
  };
}
