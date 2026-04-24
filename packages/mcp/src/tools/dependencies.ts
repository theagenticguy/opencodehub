/**
 * `dependencies` — enumerate Dependency nodes for an indexed repo.
 *
 * A Dependency node is produced by the `dependencies` pipeline phase
 * from per-ecosystem manifest parsers. Every node carries
 * `ecosystem`, `name`, `version`, and a `lockfileSource` relpath.
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

const DependenciesInput = {
  repo: z
    .string()
    .optional()
    .describe("Registered repo name. Omit to use the single registered repo."),
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

/**
 * A row returned to agents. Kept as a flat object so clients that only
 * inspect `structuredContent` can grok it without crawling the graph.
 */
interface DependencyRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly license: string;
  readonly lockfileSource: string;
}

interface DependenciesArgs {
  readonly repo?: string | undefined;
  readonly filePath?: string | undefined;
  readonly ecosystem?: "npm" | "pypi" | "go" | "cargo" | "maven" | "nuget" | undefined;
  readonly limit?: number | undefined;
}

export async function runDependencies(
  ctx: ToolContext,
  args: DependenciesArgs,
): Promise<ToolResult> {
  const limit = args.limit ?? 500;
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      // The storage layer has dedicated columns for Dependency
      // nodes: `version`, `license`, `lockfile_source`, `ecosystem`.
      // We read them directly instead of unpacking a generic
      // properties blob.
      const clauses: string[] = ["kind = 'Dependency'"];
      const params: (string | number)[] = [];
      if (args.filePath !== undefined) {
        clauses.push("file_path LIKE ?");
        params.push(`%${args.filePath}%`);
      }
      if (args.ecosystem !== undefined) {
        clauses.push("ecosystem = ?");
        params.push(args.ecosystem);
      }
      const sql = `SELECT id, name, file_path, version, license, lockfile_source, ecosystem FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ${limit}`;
      const raw = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;

      const rows: DependencyRow[] = raw.map((r) => ({
        id: String(r["id"]),
        name: String(r["name"]),
        version: stringOr(r["version"], "UNKNOWN"),
        ecosystem: stringOr(r["ecosystem"], "unknown"),
        license: stringOr(r["license"], "UNKNOWN"),
        lockfileSource: stringOr(r["lockfile_source"], String(r["file_path"] ?? "")),
      }));

      const header = `Dependencies (${rows.length}) for ${resolved.name}${
        args.ecosystem ? ` · ecosystem=${args.ecosystem}` : ""
      }${args.filePath ? ` · filePath~${args.filePath}` : ""}:`;
      const body =
        rows.length === 0
          ? "(no dependencies found — index the repo with `codehub analyze` and verify the pipeline ran the `dependencies` phase)"
          : rows
              .map(
                (d) =>
                  `- [${d.ecosystem}] ${d.name}@${d.version}  (${d.lockfileSource}, license=${d.license})`,
              )
              .join("\n");

      const next =
        rows.length === 0
          ? [
              "call `list_repos` to confirm the repo is indexed",
              "re-index with `codehub analyze` to populate Dependency nodes",
            ]
          : [
              "call `query` with one of the names above to find import sites",
              "call `sql` with 'SELECT * FROM relations WHERE type = ''DEPENDS_ON''' for the raw edges",
            ];

      return withNextSteps(
        `${header}\n${body}`,
        { dependencies: rows, total: rows.length },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerDependenciesTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dependencies",
    {
      title: "List external dependencies",
      description:
        "Enumerate external package dependencies of the indexed repo, sourced from lockfiles and manifests (package-lock.json, pnpm-lock.yaml, pyproject.toml, requirements.txt, uv.lock, go.mod, go.sum, Cargo.lock, Cargo.toml, pom.xml, *.csproj, packages.lock.json). Optionally filter by ecosystem or lockfile path substring. License field is 'UNKNOWN' at v1.0; real license detection lands in a later release.",
      inputSchema: DependenciesInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => fromToolResult(await runDependencies(ctx, args)),
  );
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
