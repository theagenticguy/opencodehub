/**
 * Resource template `codehub://repo/{name}/processes` — list process flows.
 *
 * Each row is a `Process` node emitted by the processes phase (BFS from
 * scored entry points). Ranked by `stepCount DESC` so the longest /
 * most consequential flows surface first; capped at 20. `processType`
 * is always `"flow"` today; the field is kept shape-stable so future
 * process flavours (route flows, tool flows) don't force a rev.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { readRegistry } from "../repo-resolver.js";
import type { ResourceContext } from "./repos.js";
import { withResourceStore } from "./store-helper.js";
import { yamlScalar } from "./yaml.js";

const PATTERN = "codehub://repo/{name}/processes";
const RESULT_CAP = 20;

export function registerRepoProcessesResource(server: McpServer, ctx: ResourceContext): void {
  const template = new ResourceTemplate(PATTERN, {
    list: async (): Promise<ListResourcesResult> => {
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const reg = await readRegistry(opts);
      return {
        resources: Object.keys(reg)
          .sort()
          .map((name) => ({
            name: `${name}/processes`,
            uri: `codehub://repo/${encodeURIComponent(name)}/processes`,
            mimeType: "text/yaml",
            description: `Process flows for repo ${name}`,
          })),
      };
    },
  });
  server.registerResource(
    "repo-processes",
    template,
    {
      title: "Repo processes",
      description: "YAML list of Process nodes (BFS flows) ranked by stepCount. Cap 20.",
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
          `SELECT id, name, inferred_label, step_count, entry_point_id, file_path
           FROM nodes
           WHERE kind = 'Process'
           ORDER BY COALESCE(step_count, 0) DESC, id ASC
           LIMIT ?`,
          [RESULT_CAP],
        )) as readonly Record<string, unknown>[];

        const lines: string[] = [];
        lines.push(`repo: ${yamlScalar(repoName)}`);
        lines.push("processes:");
        if (rows.length === 0) {
          lines.push("  []");
        } else {
          for (const row of rows) {
            const id = String(row["id"] ?? "");
            const name = String(row["name"] ?? "");
            const label =
              typeof row["inferred_label"] === "string" && row["inferred_label"].length > 0
                ? String(row["inferred_label"])
                : null;
            const stepCount = typeof row["step_count"] === "number" ? row["step_count"] : 0;
            const entryPointId =
              typeof row["entry_point_id"] === "string" && row["entry_point_id"].length > 0
                ? String(row["entry_point_id"])
                : null;
            const filePath = String(row["file_path"] ?? "");
            lines.push(`  - id: ${yamlScalar(id)}`);
            lines.push(`    name: ${yamlScalar(name)}`);
            if (label) {
              lines.push(`    label: ${yamlScalar(label)}`);
            }
            lines.push(`    processType: flow`);
            lines.push(`    stepCount: ${stepCount}`);
            if (entryPointId) {
              lines.push(`    entryPointId: ${yamlScalar(entryPointId)}`);
            }
            if (filePath) {
              lines.push(`    filePath: ${yamlScalar(filePath)}`);
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
