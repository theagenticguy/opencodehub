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
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const ToolMapInput = {
  repo: z.string().optional().describe("Registered repo name."),
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
  readonly tool?: string | undefined;
}

export async function runToolMap(ctx: ToolContext, args: ToolMapArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const clauses: string[] = ["kind = 'Tool'"];
      const params: (string | number)[] = [];
      if (args.tool !== undefined && args.tool.length > 0) {
        clauses.push("name LIKE ?");
        params.push(`%${args.tool}%`);
      }
      // `properties_bag` is a polymorphic JSON column; we read the
      // `inputSchemaJson` key from it when present. Every Tool node
      // still exists in the nodes table even if the column is null.
      const sql = `SELECT id, name, file_path, description, properties_bag FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY name, file_path LIMIT 500`;
      const raw = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;

      const tools: ToolRow[] = raw.map((r) => {
        const inputSchemaJson = readInputSchemaJson(r["properties_bag"]);
        return {
          name: stringOr(r["name"], ""),
          filePath: stringOr(r["file_path"], ""),
          description: stringOr(r["description"], ""),
          inputSchema: parseInputSchema(inputSchemaJson),
        };
      });

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
 * Pull `inputSchemaJson` out of a `properties_bag` value. The column can
 * be null, a JSON-encoded object, or (for tests) a pre-parsed record.
 */
function readInputSchemaJson(bag: unknown): string | null {
  if (bag === null || bag === undefined) return null;
  if (typeof bag === "string") {
    if (bag.length === 0) return null;
    try {
      const parsed = JSON.parse(bag) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const v = (parsed as Record<string, unknown>)["inputSchemaJson"];
        return typeof v === "string" ? v : null;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof bag === "object" && !Array.isArray(bag)) {
    const v = (bag as Record<string, unknown>)["inputSchemaJson"];
    return typeof v === "string" ? v : null;
  }
  return null;
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

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
