/**
 * `detect_impact` prompt — blast-radius story for a symbol or file.
 *
 * The prompt returns a single user-role message that tells the agent how
 * to chain the `impact` and `context` tools, then frame the results for a
 * human reviewer. We intentionally do NOT execute any tools here — prompts
 * are templates, tool selection is the agent's job.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerDetectImpactPrompt(server: McpServer): void {
  server.registerPrompt(
    "detect_impact",
    {
      title: "Detect impact of a code change",
      description:
        "Analyze the blast radius of a given symbol or file. Chains `impact` + `context` and asks the agent to explain what could break.",
      argsSchema: {
        target: z
          .string()
          .describe("Symbol name or file path to analyze (e.g. 'UserService' or 'src/auth.ts')."),
        repo: z
          .string()
          .optional()
          .describe("Registered repo name (defaults to the single indexed repo)."),
      },
    },
    ({ target, repo }) => {
      const repoSuffix = repo ? ` in repo "${repo}"` : "";
      const text = [
        `You are assessing the change-impact blast radius of \`${target}\`${repoSuffix}.`,
        "",
        "Perform these steps in order:",
        `1. Call the \`impact\` tool with target="${target}"${repo ? ` and repo="${repo}"` : ""}, direction="upstream", maxDepth=3.`,
        `2. Call the \`context\` tool with symbol="${target}"${repo ? ` and repo="${repo}"` : ""} for callers/callees and the owning module.`,
        "3. Summarize what would break if `" +
          target +
          "` is changed, focusing on direct-dependent (depth=1) nodes and the risk band returned by `impact`.",
        "4. Explicitly list the top 3 code paths most at risk, and call out any processes (flows) touched.",
        "",
        "If `impact` reports the target is ambiguous, call `query` first to pick a concrete node id, then re-run `impact` with that id.",
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
