/**
 * `generate_map` prompt — architecture-map sketch for an indexed repo.
 *
 * Chains the `processes` + `clusters` resources (when available) with
 * `query` / `context` / `sql` to produce an ARCHITECTURE.md draft. The
 * `processes` and `clusters` resource templates may not be registered on
 * every server build, so the prompt is written to tolerate their absence
 * and fall back to schema-level `sql` queries and `query` calls for the
 * same information.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerGenerateMapPrompt(server: McpServer): void {
  server.registerPrompt(
    "generate_map",
    {
      title: "Generate an architecture map",
      description:
        "Draft an ARCHITECTURE.md sketch by chaining the processes + clusters resources with `query`, `context`, and `sql`. Falls back to `sql` when the resource templates are not yet available.",
      argsSchema: {
        repo: z
          .string()
          .optional()
          .describe("Registered repo name (defaults to the single indexed repo)."),
        focus: z
          .string()
          .optional()
          .describe(
            "Optional area/module name to narrow the map (e.g. 'payments' or 'packages/mcp').",
          ),
      },
    },
    ({ repo, focus }) => {
      const repoArg = repo ? `, repo="${repo}"` : "";
      const repoPath = repo ?? "{name}";
      const focusClause = focus
        ? ` Narrow every step to the \`${focus}\` area — prefer symbols, processes, and communities whose name/label/filePath mentions "${focus}".`
        : "";
      const text = [
        `Produce an ARCHITECTURE.md sketch${repo ? ` for repo \`${repo}\`` : ""} using the knowledge graph.${focusClause}`,
        "",
        "Perform these steps in order. When a resource is unavailable, fall back to the `sql` tool as noted.",
        `1. Read \`codehub://repo/${repoPath}/processes\` to list the top 10 processes by stepCount (processType, label, stepCount). If the resource is not registered yet, run \`sql\` with "SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind ORDER BY n DESC"${repoArg} to infer the dominant symbol kinds, then call \`query\` with phrase="entry point" or "main" to surface plausible heads.`,
        `2. For each of the top 10 processes (or the top 10 \`query\` hits when falling back), call \`context\` on the head symbol${repoArg ? ` with${repoArg.slice(1)}` : ""} to capture its callers, callees, and owning module.`,
        `3. Read \`codehub://repo/${repoPath}/clusters\` to list the top 5 communities by symbolCount (label, cohesion, keywords). If the resource is not registered yet, run \`sql\` with "SELECT name, kind FROM nodes WHERE kind = 'Community' ORDER BY name LIMIT 5"${repoArg} and, for any row returned, call \`context\` on its name.`,
        `4. Optional — if the processes + clusters above don't cover a visible area, run \`sql\` with a custom grouping (for example "SELECT module_path, COUNT(*) AS n FROM nodes WHERE module_path IS NOT NULL GROUP BY module_path ORDER BY n DESC LIMIT 20"${repoArg}) to find module-level concentration you can use as an additional section.`,
        "",
        "Then emit an ARCHITECTURE.md draft with these sections (Markdown, no code fences around the whole document):",
        "  - System overview: 2–3 sentences grounded in `project_profile` or the kind histogram from step 1.",
        "  - Module map: top modules/communities from steps 3–4, each with a 1-line purpose derived from label + keywords.",
        "  - Key processes: the top processes from step 1, each with entry point, stepCount, and a 1-line summary from the `context` call in step 2.",
        "  - Cross-module dependencies: call out CALLS / IMPORTS / FETCHES edges crossing module boundaries (use the `context` outputs; run an extra `sql` on `relations` if needed).",
        "  - Notable risks: pull risk tiers from `verdict` and the top findings from `list_findings` (category + severity). Skip silently if either tool has no data for this repo.",
        '  - Recommended deeper-dives: 3–5 bullet suggestions (e.g. "run `impact` on <symbol>", "explore the <community> cluster", "re-scan with `codehub scan`") that follow from gaps you noticed.',
        "",
        "Surface any resource/tool that returned empty or errored inline so the reader knows which sections are incomplete. Do not fabricate symbol names — every name in the map must appear in a tool or resource response you already made.",
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
