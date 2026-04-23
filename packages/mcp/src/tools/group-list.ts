/**
 * `group_list` — enumerate every cross-repo group under
 * `~/.codehub/groups/*.json`. Read-only. Deterministic output (groups and
 * repos both sorted by name).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { listGroups } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import type { ToolContext } from "./shared.js";

interface GroupSummary {
  readonly name: string;
  readonly createdAt: string;
  readonly repos: readonly { readonly name: string; readonly path: string }[];
  readonly description?: string;
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
    async () => {
      try {
        const opts = ctx.home !== undefined ? { home: ctx.home } : {};
        const raw = await listGroups(opts);
        const groups: GroupSummary[] = raw.map((g) => ({
          name: g.name,
          createdAt: g.createdAt,
          repos: g.repos.map((r) => ({ name: r.name, path: r.path })),
          ...(g.description !== undefined ? { description: g.description } : {}),
        }));
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
        return withNextSteps(`${header}\n${body}`, { groups }, next);
      } catch (err) {
        return toolErrorFromUnknown(err);
      }
    },
  );
}
