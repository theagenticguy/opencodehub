/**
 * `explore_area` prompt — guided tour of a named functional area.
 *
 * An "area" here maps to a Community node (clustered by co-change plus
 * static graph proximity in ingestion). We ask the agent to locate the
 * community, then widen the view to its key symbols, owners, and flows.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerExploreAreaPrompt(server: McpServer): void {
  server.registerPrompt(
    "explore_area",
    {
      title: "Explore a functional area",
      description:
        "Guided tour of a code area (Community). Locates the community, lists its key symbols, owners, and processes.",
      argsSchema: {
        area: z
          .string()
          .describe(
            "Area name — either a Community's inferredLabel (e.g. 'authentication') or a concept phrase.",
          ),
        repo: z
          .string()
          .optional()
          .describe("Registered repo name (defaults to the single indexed repo)."),
      },
    },
    ({ area, repo }) => {
      const repoArg = repo ? `, repo="${repo}"` : "";
      const text = [
        `You are giving a guided tour of the \`${area}\` area${repo ? ` in repo \`${repo}\`` : ""}.`,
        "",
        "Perform these steps in order:",
        `1. Call \`sql\` with "SELECT id, name, inferred_label, symbol_count, cohesion, keywords FROM nodes WHERE kind = 'Community' AND (name LIKE '%${area}%' OR inferred_label LIKE '%${area}%') ORDER BY symbol_count DESC LIMIT 5"${repoArg}. If no rows come back, fall back to \`query\` with phrase="${area}" and pick the top hit's containing community via \`sql\`.`,
        "2. For the chosen community node, call `context` with `symbol` set to its `name` (or node id) to list its members, callers/callees, and any processes that traverse it.",
        "3. Call `owners` on the community node id to list the top contributors.",
        `4. Call \`query\` with "${area}" to surface any route / finding / dependency symbols the community summary missed.`,
        "",
        "Produce a tour with these sections:",
        `  - What is the "${area}" area? (1–2 sentences, grounded in inferredLabel + keywords + symbol_count)`,
        "  - Entry points (routes, exported functions)",
        "  - Key internal symbols",
        "  - Who owns it (top 3 contributors)",
        "  - Flows/processes that go through it",
        "  - Notable findings (if any)",
      ].join("\n");
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    },
  );
}
