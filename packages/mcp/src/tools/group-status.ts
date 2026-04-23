/**
 * `group_status` — per-repo index freshness within a named group.
 *
 * For each repo referenced by the group we emit:
 *   - name, path
 *   - nodeCount / edgeCount from the registry at group-create time
 *   - indexedAt from the registry (ISO8601)
 *   - staleness envelope via @opencodehub/analysis.computeStaleness when
 *     the on-disk meta.json is readable
 *   - `inRegistry: false` for orphan references (repo was removed but the
 *     group still points at it)
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StalenessEnvelope } from "@opencodehub/core-types";
import { readStoreMeta } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { readGroup } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import { readRegistry } from "../repo-resolver.js";
import { stalenessFor } from "../staleness.js";
import type { ToolContext } from "./shared.js";

const GroupStatusInput = {
  groupName: z.string().min(1).describe("Name of the group to inspect."),
};

interface RepoStatusRow {
  readonly name: string;
  readonly path: string;
  readonly inRegistry: boolean;
  readonly indexedAt: string | null;
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly lastCommit: string | null;
  readonly staleness?: StalenessEnvelope;
}

export function registerGroupStatusTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "group_status",
    {
      title: "Cross-repo group status",
      description:
        "Report per-repo index freshness for every repo in a named group. Returns node/edge counts, last-indexed timestamp, last commit, and a best-effort staleness envelope so the agent can decide whether to re-analyze before querying.",
      inputSchema: GroupStatusInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const opts = ctx.home !== undefined ? { home: ctx.home } : {};
        const group = await readGroup(args.groupName, opts);
        if (!group) {
          return toolError(
            "NOT_FOUND",
            `Group ${args.groupName} is not defined.`,
            "Run `codehub group list` to see defined groups.",
          );
        }
        const registry = await readRegistry(opts);
        const rows: RepoStatusRow[] = [];
        // Alphabetical iteration keeps output deterministic.
        const sorted = [...group.repos].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const repo of sorted) {
          const hit = registry[repo.name];
          if (!hit) {
            rows.push({
              name: repo.name,
              path: repo.path,
              inRegistry: false,
              indexedAt: null,
              nodeCount: null,
              edgeCount: null,
              lastCommit: null,
            });
            continue;
          }
          const meta = await readStoreMeta(hit.path).catch(() => undefined);
          const staleness = meta
            ? await stalenessFor(hit.path, meta).catch(() => undefined)
            : undefined;
          rows.push({
            name: hit.name,
            path: hit.path,
            inRegistry: true,
            indexedAt: hit.indexedAt,
            nodeCount: hit.nodeCount,
            edgeCount: hit.edgeCount,
            lastCommit: hit.lastCommit ?? null,
            ...(staleness ? { staleness } : {}),
          });
        }

        const header = `Group ${group.name} (${rows.length} repo${rows.length === 1 ? "" : "s"}):`;
        const body = rows
          .map((r) => {
            if (!r.inRegistry) return `- ${r.name}  [orphan — run \`codehub analyze ${r.path}\`]`;
            const staleBadge = r.staleness?.isStale ? "  [stale]" : "";
            return (
              `- ${r.name}${staleBadge}\n` +
              `    path: ${r.path}\n` +
              `    nodes: ${r.nodeCount ?? "?"}, edges: ${r.edgeCount ?? "?"}\n` +
              `    indexedAt: ${r.indexedAt ?? "?"}, lastCommit: ${r.lastCommit ?? "-"}`
            );
          })
          .join("\n");

        const staleRepos = rows.filter((r) => r.staleness?.isStale).map((r) => r.name);
        const orphans = rows.filter((r) => !r.inRegistry).map((r) => r.name);
        const next: string[] = [];
        if (orphans.length > 0) {
          next.push(`re-run \`codehub analyze\` for orphaned repo(s): ${orphans.join(", ")}`);
        }
        if (staleRepos.length > 0) {
          next.push(`re-run \`codehub analyze\` to refresh: ${staleRepos.join(", ")}`);
        }
        if (next.length === 0) {
          next.push(
            `call \`group_query\` with groupName="${group.name}" and a search phrase to explore`,
          );
        }

        return withNextSteps(`${header}\n${body}`, { groupName: group.name, repos: rows }, next);
      } catch (err) {
        return toolErrorFromUnknown(err);
      }
    },
  );
}
