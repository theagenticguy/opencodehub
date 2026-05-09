/**
 * `tool_map` — enumerate `Tool` nodes (MCP-style tool definitions).
 *
 * Returns one row per Tool node matching the optional `tool` name
 * substring. Each row carries the tool's file_path, description, and
 * parsed inputSchema (when the ingestion phase populated one).
 *
 * The storage schema stores the tool's input schema as a JSON string in
 * the `properties_bag` column under the key `inputSchemaJson` (written
 * by the tools ingestion phase). When the column is absent or the JSON
 * is malformed we fall back to the raw string so callers still see the
 * data unredacted.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  repoArgShape,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const ToolMapInput = {
  ...repoArgShape,
  tool: z.string().optional().describe("Substring match against tool name."),
};

interface ToolRow {
  readonly name: string;
  readonly filePath: string;
  readonly description: string;
  readonly inputSchema: unknown | null;
}

interface ToolMapArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly tool?: string | undefined;
}

export async function runToolMap(ctx: ToolContext, args: ToolMapArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      let listed = await store.graph.listNodesByKind("Tool", { limit: 500 });
      if (args.tool !== undefined && args.tool.length > 0) {
        const sub = args.tool;
        listed = listed.filter((n) => n.name.includes(sub));
      }
      const sorted = [...listed].sort((a, b) => {
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
      });
      const tools: ToolRow[] = sorted.map((t) => ({
        name: t.name,
        filePath: t.filePath,
        description: t.description ?? "",
        inputSchema: t.inputSchemaJson ? parseInputSchema(t.inputSchemaJson) : null,
      }));

      const header = `Tools (${tools.length}) for ${resolved.name}${
        args.tool ? ` · name~${args.tool}` : ""
      }:`;
      const body =
        tools.length === 0
          ? "(no Tool nodes — the `tools` ingestion phase found no MCP tool literals)"
          : tools
              .map((t) => {
                const desc = t.description.length > 0 ? ` — ${t.description}` : "";
                const schema = t.inputSchema === null ? "" : " [schema]";
                return `- ${t.name}${schema} @ ${t.filePath}${desc}`;
              })
              .join("\n");

      const next =
        tools.length === 0
          ? [
              "call `list_repos` to confirm the repo is indexed",
              "re-index with `codehub analyze` to refresh Tool nodes",
            ]
          : [
              `call \`context\` with symbol="${tools[0]?.name ?? ""}" to see callers/callees`,
              "call `query` with a tool concept to locate related symbols",
            ];

      return withNextSteps(
        `${header}\n${body}`,
        { tools, total: tools.length },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerToolMapTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "tool_map",
    {
      title: "Map MCP Tool definitions",
      description:
        "Enumerate Tool nodes detected by the tools ingestion phase, optionally filtered by name substring. Returns name, file_path, description, and the parsed input schema (JSON-decoded when available, raw string when unparseable, null when unset). Read-only.",
      inputSchema: ToolMapInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runToolMap(ctx, args)),
  );
}

/**
 * Parse the embedded JSON string. Returns the parsed value on success,
 * the raw string on parse failure, or null when no schema was present.
 */
function parseInputSchema(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
