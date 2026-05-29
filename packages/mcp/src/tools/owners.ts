/**
 * `owners` MCP tool — return ranked `OWNED_BY` contributors for a node.
 *
 * Accepts any node id (File, Symbol, Community) and walks the outgoing
 * `OWNED_BY` edges in confidence-descending order. Each row includes the
 * contributor's email hash, display name, the raw line share (`weight`),
 * and, when present in the graph, the plain email (opt-in; hashed by
 * default per the ownership phase's privacy rules).
 *
 * Read-only, idempotent, closed-world.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listOwners } from "@opencodehub/analysis";
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

const OwnersInput = {
  target: z
    .string()
    .min(1)
    .describe(
      "Node id of a File, Symbol, or Community to query for ownership. Must be a fully-qualified node id (e.g. 'File:src/app.ts:src/app.ts').",
    ),
  ...repoArgShape,
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of contributors to return (default 20, max 100)."),
};

interface OwnersArgs {
  readonly target: string;
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly limit?: number | undefined;
}

export async function runOwners(ctx: ToolContext, args: OwnersArgs): Promise<ToolResult> {
  const limit = args.limit ?? 20;
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const owners = await listOwners(store.graph, args.target, limit);

      const header = `Owners for ${args.target} in ${resolved.name} (${owners.length}):`;
      const body =
        owners.length === 0
          ? "(no OWNED_BY edges for this target — either the target id is unknown or the ownership phase has not run. Re-index with `codehub analyze --force`.)"
          : owners
              .map((o) => {
                const id = o.email.length > 0 ? o.email : `sha256:${o.emailHash.slice(0, 10)}…`;
                const name = o.name.length > 0 ? o.name : "unknown";
                return `- ${name} <${id}>  weight=${o.weight.toFixed(3)}`;
              })
              .join("\n");

      const next =
        owners.length === 0
          ? [
              "call `query` with the target's name to check it is indexed",
              "re-index with `codehub analyze --force` to emit OWNED_BY edges",
            ]
          : [
              "call `context` on the top owner to see what else they maintain",
              "call `impact` on the target to correlate ownership with blast radius",
            ];

      return withNextSteps(
        `${header}\n${body}`,
        { owners, total: owners.length },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerOwnersTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "owners",
    {
      title: "List owners for a node",
      description:
        "Enumerate the ranked set of Contributors linked to a node via OWNED_BY edges. Source is git blame; emails are SHA-256 hashed by default (plain emails only when ingestion ran with --plain-emails).",
      inputSchema: OwnersInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => fromToolResult(await runOwners(ctx, args)),
  );
}
