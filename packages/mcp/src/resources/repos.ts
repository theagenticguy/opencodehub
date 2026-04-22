/**
 * Resource `codehub://repos` — lists every registered repo with stats.
 *
 * The payload is YAML for readability (agents tend to handle YAML well in
 * resources that they render in their own context) and because it is
 * what the `codehub://repo/{name}/context` resource also emits.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { readRegistry } from "../repo-resolver.js";

export interface ResourceContext {
  readonly home?: string;
}

const URI = "codehub://repos";

export function registerReposResource(server: McpServer, ctx: ResourceContext): void {
  server.registerResource(
    "repos",
    URI,
    {
      title: "Indexed repos",
      description:
        "YAML listing of every repo registered under ~/.codehub/registry.json with name, path, and stats.",
      mimeType: "text/yaml",
    },
    async (uri): Promise<ReadResourceResult> => {
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const reg = await readRegistry(opts);
      const names = Object.keys(reg).sort();
      const lines: string[] = ["repos:"];
      if (names.length === 0) {
        lines.push("  []");
      } else {
        for (const name of names) {
          const e = reg[name];
          if (!e) continue;
          lines.push(`  - name: ${yaml(name)}`);
          lines.push(`    path: ${yaml(e.path)}`);
          lines.push(`    indexedAt: ${yaml(e.indexedAt)}`);
          if (e.lastCommit) lines.push(`    lastCommit: ${yaml(e.lastCommit)}`);
          lines.push(`    nodeCount: ${e.nodeCount}`);
          lines.push(`    edgeCount: ${e.edgeCount}`);
        }
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/yaml",
            text: `${lines.join("\n")}\n`,
          },
        ],
      };
    },
  );
}

function yaml(value: string): string {
  // Very small YAML scalar quoter: wrap in double quotes if the value
  // contains characters that would confuse a loose YAML parser.
  if (/^[A-Za-z0-9._\-/]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
