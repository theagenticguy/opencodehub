/**
 * Resource template `codehub://repo/{name}/clusters` — list community clusters.
 *
 * Each row corresponds to a `Community` node emitted by the communities
 * phase (Leiden over the CALLS + HAS_METHOD callable graph). The agent
 * uses this as the entry point for behavioural navigation: pick a
 * cluster, then read `codehub://repo/{name}/cluster/{clusterName}` for
 * its members. Ranked by `symbolCount DESC, cohesion DESC` so the
 * highest-impact clusters surface first; capped at 20.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { CommunityNode } from "@opencodehub/core-types";
import { readRegistry } from "../repo-resolver.js";
import type { ResourceContext } from "./repos.js";
import { withResourceStore } from "./store-helper.js";
import { yamlScalar } from "./yaml.js";

const PATTERN = "codehub://repo/{name}/clusters";
const RESULT_CAP = 20;

export function registerRepoClustersResource(server: McpServer, ctx: ResourceContext): void {
  const template = new ResourceTemplate(PATTERN, {
    list: async (): Promise<ListResourcesResult> => {
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const reg = await readRegistry(opts);
      return {
        resources: Object.keys(reg)
          .sort()
          .map((name) => ({
            name: `${name}/clusters`,
            uri: `codehub://repo/${encodeURIComponent(name)}/clusters`,
            mimeType: "text/yaml",
            description: `Community clusters for repo ${name}`,
          })),
      };
    },
  });
  server.registerResource(
    "repo-clusters",
    template,
    {
      title: "Repo clusters",
      description:
        "YAML list of Community nodes (Leiden clusters) ranked by size and cohesion. Cap 20.",
      mimeType: "text/yaml",
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const raw = variables["name"];
      const nameVar = Array.isArray(raw) ? raw[0] : raw;
      const decoded = nameVar ? decodeURIComponent(String(nameVar)) : undefined;
      const resourceOpts: { home?: string; pool?: typeof ctx.pool } = {};
      if (ctx.home !== undefined) resourceOpts.home = ctx.home;
      if (ctx.pool !== undefined) resourceOpts.pool = ctx.pool;
      return withResourceStore(uri.href, decoded, resourceOpts, async (store, repoName) => {
        const communities = (await store.graph.listNodesByKind(
          "Community",
        )) as readonly CommunityNode[];
        const rows = [...communities]
          .sort((a, b) => {
            const ac = a.symbolCount ?? 0;
            const bc = b.symbolCount ?? 0;
            if (ac !== bc) return bc - ac;
            const ah = a.cohesion ?? 0;
            const bh = b.cohesion ?? 0;
            if (ah !== bh) return bh - ah;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
          .slice(0, RESULT_CAP);

        const lines: string[] = [];
        lines.push(`repo: ${yamlScalar(repoName)}`);
        lines.push("clusters:");
        if (rows.length === 0) {
          lines.push("  []");
        } else {
          for (const c of rows) {
            lines.push(`  - id: ${yamlScalar(c.id)}`);
            lines.push(`    name: ${yamlScalar(c.name)}`);
            if (c.inferredLabel && c.inferredLabel.length > 0) {
              lines.push(`    label: ${yamlScalar(c.inferredLabel)}`);
            }
            lines.push(`    symbolCount: ${c.symbolCount ?? 0}`);
            lines.push(`    cohesion: ${c.cohesion ?? 0}`);
            if (c.keywords && c.keywords.length > 0) {
              lines.push("    keywords:");
              for (const kw of c.keywords) {
                lines.push(`      - ${yamlScalar(kw)}`);
              }
            }
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
      });
    },
  );
}
