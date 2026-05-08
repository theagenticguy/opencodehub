/**
 * `group_list` — enumerate every cross-repo group under
 * `~/.codehub/groups/*.json`. Read-only. Deterministic output (groups and
 * repos both sorted by name).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { listGroups } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import { deriveRepoUri, type RegistryEntry, readRegistry } from "../repo-resolver.js";
import { repoUriForEntry } from "../repo-uri-for-entry.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

/**
 * One repo entry as surfaced by `group_list`. `repo_uri` is additive per
 * AC-M6-4 and is the authoritative cross-repo handle going forward; the
 * legacy `name` field stays through M7 so existing consumers keep working.
 */
interface GroupRepoSummary {
  readonly name: string;
  readonly path: string;
  readonly repo_uri: string;
}

interface GroupSummary {
  readonly name: string;
  readonly createdAt: string;
  readonly repos: readonly GroupRepoSummary[];
  readonly description?: string;
}

export async function runGroupList(ctx: ToolContext): Promise<ToolResult> {
  try {
    const opts = ctx.home !== undefined ? { home: ctx.home } : {};
    const raw = await listGroups(opts);
    const registry = await readRegistry(opts);
    const groups: GroupSummary[] = [];
    for (const g of raw) {
      const repos: GroupRepoSummary[] = [];
      for (const r of g.repos) {
        const entry: RegistryEntry | undefined = registry[r.name];
        // Prefer the graph-backed RepoNode.repoUri (AC-M6-1) when the repo
        // is registered; otherwise fall back to deriveRepoUri against a
        // synthetic entry built from the group record so orphan references
        // still receive a stable `local:<hash>`.
        const repo_uri = entry
          ? await repoUriForEntry(entry, ctx.pool)
          : deriveRepoUri({
              name: r.name,
              path: r.path,
              indexedAt: "",
              nodeCount: 0,
              edgeCount: 0,
            });
        repos.push({ name: r.name, path: r.path, repo_uri });
      }
      groups.push({
        name: g.name,
        createdAt: g.createdAt,
        repos,
        ...(g.description !== undefined ? { description: g.description } : {}),
      });
    }
    const header = `Groups (${groups.length}):`;
    const body =
      groups.length === 0
        ? "(none — create one with `codehub group create <name> <repo> <repo> ...`)"
        : groups
            .map(
              (g) =>
                `- ${g.name} (${g.repos.length} repo${g.repos.length === 1 ? "" : "s"}): ${g.repos.map((r) => r.name).join(", ")}`,
            )
            .join("\n");
    const next =
      groups.length === 0
        ? ["run `codehub group create <name> <repo1> <repo2>` to define a group"]
        : [
            `call \`group_status\` with groupName="${groups[0]?.name ?? ""}" to see per-repo freshness`,
            `call \`group_query\` with groupName + query to fan out BM25 across the group`,
          ];
    return toToolResult(withNextSteps(`${header}\n${body}`, { groups }, next));
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

export function registerGroupListTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "group_list",
    {
      title: "List cross-repo groups",
      description:
        "Enumerate every cross-repo group defined under ~/.codehub/groups. Groups bundle already-indexed repos so an agent can run one query across a whole stack (web-client + api-server + shared libs). Returns each group's name, creation timestamp, optional description, and constituent repos.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => fromToolResult(await runGroupList(ctx)),
  );
}
