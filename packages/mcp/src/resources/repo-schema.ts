/**
 * Resource template `codehub://repo/{name}/schema` — node/edge vocabulary.
 *
 * Exposed as YAML so agents can author SQL (or reason about graph
 * structure) without having to call `sql` with introspective queries.
 * The payload is static — it reflects the compile-time vocabulary, not
 * anything runtime-discovered — which is fine because every indexed
 * repo shares the same schema version at MVP.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { NODE_KINDS, RELATION_TYPES, SCHEMA_VERSION } from "@opencodehub/core-types";
import { readRegistry } from "../repo-resolver.js";
import type { ResourceContext } from "./repos.js";

const PATTERN = "codehub://repo/{name}/schema";

const NODE_COLUMNS = [
  "id",
  "kind",
  "name",
  "file_path",
  "start_line",
  "end_line",
  "is_exported",
  "signature",
  "parameter_count",
  "return_type",
  "declared_type",
  "owner",
  "url",
  "method",
  "tool_name",
  "content",
  "content_hash",
  "inferred_label",
  "symbol_count",
  "cohesion",
  "keywords",
  "entry_point_id",
  "step_count",
  "level",
  "response_keys",
  "description",
] as const;

const RELATION_COLUMNS = [
  "id",
  "from_id",
  "to_id",
  "type",
  "confidence",
  "reason",
  "step",
] as const;

export function registerRepoSchemaResource(server: McpServer, ctx: ResourceContext): void {
  const template = new ResourceTemplate(PATTERN, {
    list: async (): Promise<ListResourcesResult> => {
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const reg = await readRegistry(opts);
      return {
        resources: Object.keys(reg)
          .sort()
          .map((name) => ({
            name: `${name}/schema`,
            uri: `codehub://repo/${encodeURIComponent(name)}/schema`,
            mimeType: "text/yaml",
            description: `Graph schema for repo ${name}`,
          })),
      };
    },
  });
  server.registerResource(
    "repo-schema",
    template,
    {
      title: "Graph schema",
      description:
        "YAML listing every NodeKind and RelationType with the table columns agents can filter on when authoring `sql` queries.",
      mimeType: "text/yaml",
    },
    async (uri): Promise<ReadResourceResult> => {
      const lines: string[] = [];
      lines.push(`schemaVersion: ${SCHEMA_VERSION}`);
      lines.push("tables:");
      lines.push("  nodes:");
      for (const c of NODE_COLUMNS) lines.push(`    - ${c}`);
      lines.push("  relations:");
      for (const c of RELATION_COLUMNS) lines.push(`    - ${c}`);
      lines.push("nodeKinds:");
      for (const k of NODE_KINDS) lines.push(`  - ${k}`);
      lines.push("relationTypes:");
      for (const t of RELATION_TYPES) lines.push(`  - ${t}`);
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
