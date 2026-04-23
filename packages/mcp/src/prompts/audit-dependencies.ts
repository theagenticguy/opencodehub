/**
 * `audit_dependencies` prompt — license + supply-chain risk audit.
 *
 * Chains `dependencies` (inventory), `license_audit` (tier classification),
 * and `list_findings` (CVE/supply-chain findings from osv-scanner, etc.),
 * then asks the agent to prioritize remediation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerAuditDependenciesPrompt(server: McpServer): void {
  server.registerPrompt(
    "audit_dependencies",
    {
      title: "Audit external dependencies",
      description:
        "Inventory external deps, classify licenses, correlate with any osv-scanner findings, and produce a remediation list.",
      argsSchema: {
        repo: z
          .string()
          .optional()
          .describe("Registered repo name (defaults to the single indexed repo)."),
        ecosystem: z
          .string()
          .optional()
          .describe(
            "Optional ecosystem filter (npm, pypi, go, cargo, maven, nuget) to narrow the audit.",
          ),
      },
    },
    ({ repo, ecosystem }) => {
      const repoArg = repo ? `, repo="${repo}"` : "";
      const ecoArg = ecosystem ? `, ecosystem="${ecosystem}"` : "";
      const text = [
        `You are auditing the external dependencies${repo ? ` of repo \`${repo}\`` : ""}${ecosystem ? ` scoped to the \`${ecosystem}\` ecosystem` : ""}.`,
        "",
        "Perform these steps in order:",
        `1. Call \`dependencies\`${repoArg ? ` with${repoArg.slice(1)}` : ""}${ecoArg}${!repoArg && !ecoArg ? "" : ""} to list every Dependency node (use the appropriate filters if set).`,
        `2. Call \`license_audit\`${repo ? ` with repoPath="${repo}"` : ""} to classify each dependency into copyleft / proprietary / unknown / ok tiers.`,
        `3. Call \`list_findings\`${repo ? ` with repoPath="${repo}"` : ""}, scanner="osv-scanner" to pull any published CVEs against those dependencies.`,
        "",
        "Then produce a report with these sections:",
        "  - Inventory summary: total count by ecosystem.",
        "  - License risk: BLOCK / WARN / OK tier from `license_audit`, with the offending dependencies listed.",
        "  - Vulnerabilities: findings from osv-scanner, grouped by severity.",
        "  - Prioritized remediation list: for each blocker, recommend an action (replace, upgrade, drop, or accept with legal sign-off). Rank by severity desc, then by ecosystem.",
        "",
        "If either the license or findings output is empty, call that out explicitly and suggest the next step (re-index with `codehub analyze --force` or run `codehub scan`).",
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
