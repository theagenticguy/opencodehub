/**
 * `project_profile` — return the ProjectProfile node for a repo.
 *
 * Profile is a singleton per repo, emitted by the ingestion `profile` phase.
 * Each array field is stored in SQLite as a JSON-encoded TEXT column
 * (`languages_json`, `frameworks_json`, etc.) so the capability decodes every
 * column back into a `string[]`. If the repo was indexed before the profile
 * phase shipped (or the phase failed to write the node), the capability reports
 * `profileExists: false` and this presenter nudges the caller toward `codehub
 * analyze --force`.
 *
 * `frameworks_json` is polymorphic across two generations:
 *   - v1.0 (legacy) → a flat `string[]` of framework names.
 *   - v2.0 (post-P05) → `{ flat: string[], detected: FrameworkDetection[] }`
 *     so variant / version / confidence / parent metadata survives the
 *     round-trip. Both are read transparently; callers receive both a
 *     flat form (backward-compat) and the structured form in the payload.
 *
 * The shared reader/decoder lives in `@opencodehub/core-ops`
 * `projectProfileCapability`; this file is the thin MCP adapter built with
 * `defineTool` — the presenter builds the line list + conditional next-steps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type ProjectProfileInput,
  type ProjectProfileOutput,
  projectProfileCapability,
} from "@opencodehub/core-ops";
import { defineTool } from "./define-tool.js";
import { repoArgShape, type ToolContext, type ToolResult } from "./shared.js";

const ProjectProfileInputSchema = {
  ...repoArgShape,
};

interface ProjectProfileArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
}

const projectProfileTool = defineTool<
  ProjectProfileArgs,
  ProjectProfileInput,
  ProjectProfileOutput
>({
  name: "project_profile",
  title: "Project Profile",
  description:
    "Returns the detected project profile: languages, frameworks (flat + structured), IaC types, API contracts, manifests, source directories.",
  inputSchema: ProjectProfileInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  capability: projectProfileCapability,
  toInput: () => ({}),
  present: (out) => {
    const { profile: payload, profileExists } = out;
    const header = profileExists
      ? `Project profile for ${out.repoName}:`
      : `No ProjectProfile node in ${out.repoName}. Re-index with \`codehub analyze --force\` to populate.`;

    const lines: string[] = [header];
    if (payload.languages.length > 0) {
      lines.push(`  languages     (${payload.languages.length}): ${payload.languages.join(", ")}`);
    }
    if (payload.frameworks.length > 0) {
      // Prefer the structured form for display when available — render
      // each framework with its variant so operators see "nextjs:app-router"
      // rather than a bare "nextjs". Fall back to flat names.
      const display =
        payload.frameworksDetected.length > 0
          ? payload.frameworksDetected.map((d) => (d.variant ? `${d.name}:${d.variant}` : d.name))
          : payload.frameworks;
      lines.push(`  frameworks    (${display.length}): ${display.join(", ")}`);
    }
    if (payload.iacTypes.length > 0) {
      lines.push(`  iacTypes      (${payload.iacTypes.length}): ${payload.iacTypes.join(", ")}`);
    }
    if (payload.apiContracts.length > 0) {
      lines.push(
        `  apiContracts  (${payload.apiContracts.length}): ${payload.apiContracts.join(", ")}`,
      );
    }
    if (payload.manifests.length > 0) {
      lines.push(`  manifests     (${payload.manifests.length}): ${payload.manifests.join(", ")}`);
    }
    if (payload.srcDirs.length > 0) {
      lines.push(`  srcDirs       (${payload.srcDirs.length}): ${payload.srcDirs.join(", ")}`);
    }

    const nextSteps: string[] = [];
    if (!profileExists) {
      nextSteps.push("run `codehub analyze --force` to emit the ProjectProfile node");
    } else {
      if (payload.frameworks.length > 0) {
        nextSteps.push(
          `call \`query\` with the framework name (e.g. "${payload.frameworks[0] ?? ""}") to find entry points`,
        );
      }
      if (payload.apiContracts.includes("openapi")) {
        nextSteps.push("call `query` with kinds=['Operation'] to list OpenAPI operations");
      }
      if (payload.iacTypes.includes("terraform")) {
        nextSteps.push("call `list_findings` (once scanners are wired) for tfsec/checkov results");
      }
      if (nextSteps.length === 0) {
        nextSteps.push("call `list_repos` to pick a different repo");
      }
    }

    return {
      text: lines.join("\n"),
      structured: { profile: payload },
      nextSteps,
    };
  },
});

export async function runProjectProfile(
  ctx: ToolContext,
  args: ProjectProfileArgs,
): Promise<ToolResult> {
  return projectProfileTool.run(ctx, args);
}

export function registerProjectProfileTool(server: McpServer, ctx: ToolContext): void {
  projectProfileTool.register(server, ctx);
}
