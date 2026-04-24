/**
 * `project_profile` — return the ProjectProfile node for a repo.
 *
 * Profile is a singleton per repo, emitted by the ingestion `profile` phase.
 * Each array field is stored in DuckDB as a JSON-encoded TEXT column
 * (`languages_json`, `frameworks_json`, etc.) so we decode every column
 * back into a `string[]` before returning. If the repo was indexed before
 * the profile phase shipped (or the phase failed to write the node), we
 * return empty arrays and a hint nudging the caller toward `codehub
 * analyze --force`.
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

const ProjectProfileInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
};

interface ProjectProfilePayload {
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly iacTypes: readonly string[];
  readonly apiContracts: readonly string[];
  readonly manifests: readonly string[];
  readonly srcDirs: readonly string[];
}

function parseJsonArray(raw: unknown): readonly string[] {
  if (raw == null) return [];
  if (typeof raw !== "string") return [];
  if (raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

interface ProjectProfileArgs {
  readonly repo?: string | undefined;
}

export async function runProjectProfile(
  ctx: ToolContext,
  args: ProjectProfileArgs,
): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const rows = (await store.query(
        `SELECT languages_json, frameworks_json, iac_types_json,
                    api_contracts_json, manifests_json, src_dirs_json
             FROM nodes WHERE kind = 'ProjectProfile' LIMIT 1`,
        [],
      )) as ReadonlyArray<Record<string, unknown>>;

      const row = rows[0];
      const payload: ProjectProfilePayload = {
        languages: parseJsonArray(row?.["languages_json"]),
        frameworks: parseJsonArray(row?.["frameworks_json"]),
        iacTypes: parseJsonArray(row?.["iac_types_json"]),
        apiContracts: parseJsonArray(row?.["api_contracts_json"]),
        manifests: parseJsonArray(row?.["manifests_json"]),
        srcDirs: parseJsonArray(row?.["src_dirs_json"]),
      };

      const profileExists = row !== undefined;
      const header = profileExists
        ? `Project profile for ${resolved.name}:`
        : `No ProjectProfile node in ${resolved.name}. Re-index with \`codehub analyze --force\` to populate.`;

      const lines: string[] = [header];
      if (payload.languages.length > 0) {
        lines.push(
          `  languages     (${payload.languages.length}): ${payload.languages.join(", ")}`,
        );
      }
      if (payload.frameworks.length > 0) {
        lines.push(
          `  frameworks    (${payload.frameworks.length}): ${payload.frameworks.join(", ")}`,
        );
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
        lines.push(
          `  manifests     (${payload.manifests.length}): ${payload.manifests.join(", ")}`,
        );
      }
      if (payload.srcDirs.length > 0) {
        lines.push(`  srcDirs       (${payload.srcDirs.length}): ${payload.srcDirs.join(", ")}`);
      }

      const next: string[] = [];
      if (!profileExists) {
        next.push("run `codehub analyze --force` to emit the ProjectProfile node");
      } else {
        if (payload.frameworks.length > 0) {
          next.push(
            `call \`query\` with the framework name (e.g. "${payload.frameworks[0] ?? ""}") to find entry points`,
          );
        }
        if (payload.apiContracts.includes("openapi")) {
          next.push("call `query` with kinds=['Operation'] to list OpenAPI operations");
        }
        if (payload.iacTypes.includes("terraform")) {
          next.push("call `list_findings` (once scanners are wired) for tfsec/checkov results");
        }
        if (next.length === 0) {
          next.push("call `list_repos` to pick a different repo");
        }
      }

      return withNextSteps(
        lines.join("\n"),
        { profile: payload },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerProjectProfileTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "project_profile",
    {
      title: "Project Profile",
      description:
        "Returns the detected project profile: languages, frameworks, IaC types, API contracts, manifests, source directories.",
      inputSchema: ProjectProfileInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => fromToolResult(await runProjectProfile(ctx, args)),
  );
}
