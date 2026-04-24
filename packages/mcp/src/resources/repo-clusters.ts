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
import { readRegistry } from "../repo-resolver.js";
import type { ResourceContext } from "./repos.js";
import { withResourceStore } from "./store-helper.js";
import { yamlScalar } from "./yaml.js";

const PATTERN = "codehub://repo/{name}/clusters";
const RESULT_CAP = 20;

interface CommunityRow {
  id: string;
  name: string;
  inferred_label: string | null;
  symbol_count: number | null;
  cohesion: number | null;
  keywords: readonly string[] | null;
}

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
        const rows = (await store.query(
          `SELECT id, name, inferred_label, symbol_count, cohesion, keywords
           FROM nodes
           WHERE kind = 'Community'
           ORDER BY COALESCE(symbol_count, 0) DESC, COALESCE(cohesion, 0) DESC, id ASC
           LIMIT ?`,
          [RESULT_CAP],
        )) as readonly Record<string, unknown>[];

        const lines: string[] = [];
        lines.push(`repo: ${yamlScalar(repoName)}`);
        lines.push("clusters:");
        if (rows.length === 0) {
          lines.push("  []");
        } else {
          for (const raw of rows) {
            const row = coerceRow(raw);
            lines.push(`  - id: ${yamlScalar(row.id)}`);
            lines.push(`    name: ${yamlScalar(row.name)}`);
            if (row.inferred_label) {
              lines.push(`    label: ${yamlScalar(row.inferred_label)}`);
            }
            lines.push(`    symbolCount: ${row.symbol_count ?? 0}`);
            lines.push(`    cohesion: ${row.cohesion ?? 0}`);
            if (row.keywords && row.keywords.length > 0) {
              lines.push("    keywords:");
              for (const kw of row.keywords) {
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

function coerceRow(raw: Record<string, unknown>): CommunityRow {
  const keywords = raw["keywords"];
  return {
    id: String(raw["id"] ?? ""),
    name: String(raw["name"] ?? ""),
    inferred_label:
      typeof raw["inferred_label"] === "string" && raw["inferred_label"].length > 0
        ? raw["inferred_label"]
        : null,
    symbol_count: typeof raw["symbol_count"] === "number" ? raw["symbol_count"] : null,
    cohesion: typeof raw["cohesion"] === "number" ? raw["cohesion"] : null,
    keywords: Array.isArray(keywords) ? (keywords as string[]).map(String) : null,
  };
}
