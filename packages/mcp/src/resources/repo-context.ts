/**
 * Resource template `codehub://repo/{name}/context` — per-repo overview.
 *
 * Emits stats + staleness + a curated list of available tools so agents
 * learn what they can do in a single `resources/read`. The `list`
 * callback enumerates the same URI pattern for every registered repo so
 * clients like Claude Code show them in the @-mention picker.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveRepo } from "../repo-resolver.js";
import { stalenessFromMeta } from "../staleness.js";
import type { ResourceContext } from "./repos.js";

const PATTERN = "codehub://repo/{name}/context";

const AVAILABLE_TOOLS = [
  "list_repos",
  "query",
  "context",
  "impact",
  "detect_changes",
  "rename",
  "sql",
] as const;

export function registerRepoContextResource(server: McpServer, ctx: ResourceContext): void {
  const template = new ResourceTemplate(PATTERN, {
    list: async (): Promise<ListResourcesResult> => {
      const { readRegistry } = await import("../repo-resolver.js");
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const reg = await readRegistry(opts);
      return {
        resources: Object.keys(reg)
          .sort()
          .map((name) => ({
            name: `${name}/context`,
            uri: `codehub://repo/${encodeURIComponent(name)}/context`,
            mimeType: "text/yaml",
            description: `Context card for repo ${name}`,
          })),
      };
    },
  });
  server.registerResource(
    "repo-context",
    template,
    {
      title: "Repo context card",
      description:
        "YAML overview of a registered repo: stats, staleness, and the tools available to act on it.",
      mimeType: "text/yaml",
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const raw = variables["name"];
      const nameVar = Array.isArray(raw) ? raw[0] : raw;
      const decoded = nameVar ? decodeURIComponent(String(nameVar)) : undefined;
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const resolved = await resolveRepo(decoded, opts);
      const staleness = stalenessFromMeta(resolved.meta);
      const lines: string[] = [];
      lines.push(`repo: ${resolved.name}`);
      lines.push(`path: ${resolved.repoPath}`);
      lines.push("stats:");
      lines.push(`  nodeCount: ${resolved.entry.nodeCount}`);
      lines.push(`  edgeCount: ${resolved.entry.edgeCount}`);
      lines.push(`  indexedAt: ${resolved.entry.indexedAt}`);
      if (resolved.entry.lastCommit) {
        lines.push(`  lastCommit: ${resolved.entry.lastCommit}`);
      }
      if (staleness) {
        lines.push("staleness:");
        lines.push(`  isStale: ${staleness.isStale}`);
        lines.push(`  commitsBehind: ${staleness.commitsBehind}`);
        if (staleness.lastIndexedCommit) {
          lines.push(`  lastIndexedCommit: ${staleness.lastIndexedCommit}`);
        }
      }
      lines.push("available_tools:");
      for (const t of AVAILABLE_TOOLS) {
        lines.push(`  - ${t}`);
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
