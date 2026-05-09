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
import type { ProcessNode } from "@opencodehub/core-types";
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
        const processes = (await store.graph.listNodesByKind("Process")) as readonly ProcessNode[];
        const rows = [...processes]
          .sort((a, b) => {
            const ac = a.stepCount ?? 0;
            const bc = b.stepCount ?? 0;
            if (ac !== bc) return bc - ac;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
          .slice(0, RESULT_CAP);

        const lines: string[] = [];
        lines.push(`repo: ${yamlScalar(repoName)}`);
        lines.push("processes:");
        if (rows.length === 0) {
          lines.push("  []");
        } else {
          for (const p of rows) {
            const label =
              typeof p.inferredLabel === "string" && p.inferredLabel.length > 0
                ? p.inferredLabel
                : null;
            const stepCount = p.stepCount ?? 0;
            const entryPointId =
              typeof p.entryPointId === "string" && p.entryPointId.length > 0
                ? p.entryPointId
                : null;
            lines.push(`  - id: ${yamlScalar(p.id)}`);
            lines.push(`    name: ${yamlScalar(p.name)}`);
            if (label) {
              lines.push(`    label: ${yamlScalar(label)}`);
            }
            lines.push(`    processType: flow`);
            lines.push(`    stepCount: ${stepCount}`);
            if (entryPointId) {
              lines.push(`    entryPointId: ${yamlScalar(entryPointId)}`);
            }
            if (p.filePath && p.filePath.length > 0) {
              lines.push(`    filePath: ${yamlScalar(p.filePath)}`);
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
