/**
 * `dependencies` — enumerate Dependency nodes for an indexed repo.
 *
 * A Dependency node is produced by the `dependencies` pipeline phase
 * from per-ecosystem manifest parsers. Every node carries
 * `ecosystem`, `name`, `version`, and a `lockfileSource` relpath.
 *
 * The shared reader/filter/projection lives in `@opencodehub/core-ops`
 * `dependenciesCapability`; this file is the thin MCP adapter built with
 * `defineTool` — it declares the input schema, the args→Input projection,
 * and the presenter that renders `DependenciesOutput` into the MCP text
 * body + `next_steps` + staleness envelope.
 *
 * Filters:
 *   - `ecosystem`   — restrict to one ecosystem (npm, pypi, go, cargo,
 *                     maven, nuget). Server does no validation beyond
 *                     string compare — an unknown value returns an
 *                     empty list.
 *   - `filePath`    — substring match against `file_path` (alias of the
 *                     lockfile source). Useful when a repo has multiple
 *                     workspaces with their own manifests.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type DependenciesInput,
  type DependenciesOutput,
  dependenciesCapability,
} from "@opencodehub/core-ops";
import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { repoArgShape, type ToolContext, type ToolResult } from "./shared.js";

const DependenciesInputSchema = {
  ...repoArgShape,
  filePath: z
    .string()
    .optional()
    .describe("Optional substring filter on the manifest path (e.g. 'apps/web/package.json')."),
  ecosystem: z
    .enum(["npm", "pypi", "go", "cargo", "maven", "nuget"])
    .optional()
    .describe("Restrict to a single ecosystem."),
  limit: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Maximum number of dependencies to return (default 500, max 10000)."),
};

interface DependenciesArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
  readonly filePath?: string | undefined;
  readonly ecosystem?: "npm" | "pypi" | "go" | "cargo" | "maven" | "nuget" | undefined;
  readonly limit?: number | undefined;
}

const dependenciesTool = defineTool<DependenciesArgs, DependenciesInput, DependenciesOutput>({
  name: "dependencies",
  title: "List external dependencies",
  description:
    "Enumerate external package dependencies of the indexed repo, sourced from lockfiles and manifests (package-lock.json, pnpm-lock.yaml, pyproject.toml, requirements.txt, uv.lock, go.mod, go.sum, Cargo.lock, Cargo.toml, pom.xml, *.csproj, packages.lock.json). Optionally filter by ecosystem or lockfile path substring. License field is 'UNKNOWN' at v1.0; real license detection lands in a later release.",
  inputSchema: DependenciesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  capability: dependenciesCapability,
  toInput: (args) => ({
    ...(args.ecosystem !== undefined ? { ecosystem: args.ecosystem } : {}),
    ...(args.filePath !== undefined ? { filePath: args.filePath } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  }),
  present: (out) => {
    const header = `Dependencies (${out.total}) for ${out.repoName}${
      out.filters.ecosystem ? ` · ecosystem=${out.filters.ecosystem}` : ""
    }${out.filters.filePath ? ` · filePath~${out.filters.filePath}` : ""}:`;
    const body =
      out.total === 0
        ? "(no dependencies found — index the repo with `codehub analyze` and verify the pipeline ran the `dependencies` phase)"
        : out.dependencies
            .map(
              (d) =>
                `- [${d.ecosystem}] ${d.name}@${d.version}  (${d.lockfileSource}, license=${d.license})`,
            )
            .join("\n");

    const nextSteps =
      out.total === 0
        ? [
            "call `list_repos` to confirm the repo is indexed",
            "re-index with `codehub analyze` to populate Dependency nodes",
          ]
        : [
            "call `query` with one of the names above to find import sites",
            "call `sql` with cypher 'MATCH ()-[r:DEPENDS_ON]->() RETURN r' for the raw edges",
          ];

    return {
      text: `${header}\n${body}`,
      structured: { dependencies: out.dependencies, total: out.total },
      nextSteps,
    };
  },
});

export async function runDependencies(
  ctx: ToolContext,
  args: DependenciesArgs,
): Promise<ToolResult> {
  return dependenciesTool.run(ctx, args);
}

export function registerDependenciesTool(server: McpServer, ctx: ToolContext): void {
  dependenciesTool.register(server, ctx);
}
