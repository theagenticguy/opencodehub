/**
 * `list_repos` — enumerate every repo registered under
 * `~/.codehub/registry.json` with the stats recorded at index time.
 *
 * This is the discovery entry point: agents unfamiliar with the user's
 * environment should call this first and then route every subsequent
 * tool call through one of the returned `name` values.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { readRegistry } from "../repo-resolver.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

interface RepoSummary {
  readonly name: string;
  readonly path: string;
  readonly lastCommit: string | null;
  readonly indexedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

/**
 * Transport-agnostic implementation. The MCP-registered handler adapts
 * the return value into the SDK's `CallToolResult`.
 */
export async function runListRepos(ctx: ToolContext): Promise<ToolResult> {
  try {
    const opts = ctx.home !== undefined ? { home: ctx.home } : {};
    const reg = await readRegistry(opts);
    const repos: RepoSummary[] = Object.keys(reg)
      .sort()
      .map((name) => {
        const e = reg[name];
        if (!e) throw new Error(`missing entry for ${name}`);
        return {
          name: e.name,
          path: e.path,
          lastCommit: e.lastCommit ?? null,
          indexedAt: e.indexedAt,
          nodeCount: e.nodeCount,
          edgeCount: e.edgeCount,
        };
      });

    const header = `Indexed repos (${repos.length}):`;
    const body =
      repos.length === 0
        ? "(none — run `codehub analyze` in a repo root to create an index)"
        : repos
            .map(
              (r) =>
                `- ${r.name}\n  path: ${r.path}\n  indexedAt: ${r.indexedAt}\n  nodes: ${r.nodeCount}, edges: ${r.edgeCount}`,
            )
            .join("\n");

    const next =
      repos.length === 0
        ? ["run `codehub analyze` on a git repo to index it"]
        : [`call \`query\` with a search phrase (repo="${repos[0]?.name ?? ""}") to explore`];

    return toToolResult(withNextSteps(`${header}\n${body}`, { repos }, next));
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

export function registerListReposTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_repos",
    {
      title: "List indexed repos",
      description:
        "Enumerate every repo that has been indexed by codehub on this machine. Returns name, on-disk path, last-seen commit, index timestamp, and node/edge counts per repo. Call this before any repo-scoped tool when you do not already know the repo name.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => fromToolResult(await runListRepos(ctx)),
  );
}
