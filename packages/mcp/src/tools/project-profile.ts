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
 *
 * `frameworks_json` is polymorphic across two generations:
 *   - v1.0 (legacy) → a flat `string[]` of framework names.
 *   - v2.0 (post-P05) → `{ flat: string[], detected: FrameworkDetection[] }`
 *     so variant / version / confidence / parent metadata survives the
 *     round-trip. Both are read transparently; callers receive both a
 *     flat form (backward-compat) and the structured form in the payload.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FrameworkDetection } from "@opencodehub/core-types";
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

const ProjectProfileInput = {
  ...repoArgShape,
};

interface ProjectProfilePayload {
  readonly languages: readonly string[];
  /** Flat-string framework view (backward-compat). */
  readonly frameworks: readonly string[];
  /** Structured framework detections with variant / version / confidence / parent. */
  readonly frameworksDetected: readonly FrameworkDetection[];
  readonly iacTypes: readonly string[];
  readonly apiContracts: readonly string[];
  readonly manifests: readonly string[];
  readonly srcDirs: readonly string[];
}

interface ProjectProfileArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
}

export async function runProjectProfile(
  ctx: ToolContext,
  args: ProjectProfileArgs,
): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const nodes = await store.graph.listNodesByKind("ProjectProfile", { limit: 1 });
      const profile = nodes[0];
      const payload: ProjectProfilePayload = {
        languages: profile?.languages ? [...profile.languages] : [],
        frameworks: profile?.frameworks ? [...profile.frameworks] : [],
        frameworksDetected: profile?.frameworksDetected ? [...profile.frameworksDetected] : [],
        iacTypes: profile?.iacTypes ? [...profile.iacTypes] : [],
        apiContracts: profile?.apiContracts ? [...profile.apiContracts] : [],
        manifests: profile?.manifests ? [...profile.manifests] : [],
        srcDirs: profile?.srcDirs ? [...profile.srcDirs] : [],
      };

      const profileExists = profile !== undefined;
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
        "Returns the detected project profile: languages, frameworks (flat + structured), IaC types, API contracts, manifests, source directories.",
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
