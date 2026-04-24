/**
 * `review_pr` prompt — structured PR review by diff'ing against a base ref.
 *
 * Agents that speak this prompt should chain `detect_changes` (mapping the
 * diff to indexed symbols/processes) and `impact` (risk per symbol). The
 * prompt ends with a rubric the agent should fill in so output is
 * predictable enough for humans and downstream automation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerReviewPrPrompt(server: McpServer): void {
  server.registerPrompt(
    "review_pr",
    {
      title: "Review a pull request",
      description:
        "Diff HEAD against a base ref, map changes to graph symbols, and grade the PR by risk + coverage + ownership.",
      argsSchema: {
        base: z
          .string()
          .describe("Base git ref (e.g. 'main', 'origin/main') to compare against HEAD."),
        head: z.string().optional().describe("Head git ref (default: current working tree)."),
        repo: z
          .string()
          .optional()
          .describe("Registered repo name (defaults to the single indexed repo)."),
      },
    },
    ({ base, head, repo }) => {
      const repoArg = repo ? `, repo="${repo}"` : "";
      const headPhrase = head ? `\`${head}\`` : "the current working tree";
      const text = [
        `Review the pull request represented by the diff between \`${base}\` and ${headPhrase}${repo ? ` in repo \`${repo}\`` : ""}.`,
        "",
        "Perform these steps in order:",
        `1. Call \`detect_changes\` with scope="compare", compareRef="${base}"${repoArg} to map the diff onto indexed symbols and affected processes.`,
        "2. For each changed symbol with risk >= MEDIUM, call `impact` (direction=upstream, maxDepth=3) to list direct dependents.",
        "3. For the top 3 highest-risk changed files, call `owners` on the file node id to identify the reviewers who historically maintain that code.",
        "",
        "Then produce a structured review with these sections:",
        "  - Summary (2–3 sentences: what the PR does, based on the changed files).",
        "  - Risk assessment (use the `detect_changes` summary + per-symbol impact).",
        "  - Affected processes (from `detect_changes.affected_processes`).",
        "  - Suggested reviewers (from `owners` output).",
        "  - Test coverage concerns (flag any changed symbol with zero direct tests detected).",
        "",
        "If `detect_changes` returns no affected symbols, say so and note whether the diff is docs/tests-only.",
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
