/**
 * `license_audit` — classify Dependency nodes by license risk tier.
 *
 * Walks every Dependency node the ingestion pipeline produced and sorts
 * each one into three buckets:
 *
 *   - copyleft    — names matching GPL/AGPL/SSPL/EUPL/CPAL/OSL/RPL. These
 *                   are redistribution-contagious licenses that the host
 *                   project (Apache-2.0) cannot safely link against.
 *   - proprietary — explicit "PROPRIETARY" declarations.
 *   - unknown     — missing licenses or the `"UNKNOWN"` sentinel emitted
 *                   by the dependency phase when a manifest parser could
 *                   not recover a declared license. A later release will
 *                   populate real licenses from ecosystem metadata;
 *                   until then most audits WILL return tier=WARN.
 *
 * Tier assignment:
 *   BLOCK  — any copyleft OR any proprietary dep.
 *   WARN   — no copyleft/proprietary, at least one unknown.
 *   OK     — nothing flagged.
 *
 * Annotations are {readOnly, closedWorld, idempotent} — the tool only
 * queries the graph.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { classifyDependencies, type DependencyRef } from "@opencodehub/analysis";
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

const LicenseAuditInput = {
  ...repoArgShape,
};

interface LicenseAuditArgs {
  readonly repo?: string | undefined;
  readonly repo_uri?: string | undefined;
}

export async function runLicenseAudit(
  ctx: ToolContext,
  args: LicenseAuditArgs,
): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
    try {
      const all = await store.graph.listDependencies();
      const deps: DependencyRef[] = all.map((d) => ({
        id: d.id,
        name: d.name,
        version: stringOr(d.version, "UNKNOWN"),
        ecosystem: stringOr(d.ecosystem, "unknown"),
        license: stringOr(d.license, "UNKNOWN"),
        lockfileSource: stringOr(d.lockfileSource, d.filePath),
      }));

      const result = classifyDependencies(deps);
      const header = `License audit for ${resolved.name}: tier=${result.tier} (${result.summary.okCount}/${result.summary.total} ok, ${result.summary.flaggedCount} flagged)`;
      const bodyLines: string[] = [];
      if (result.flagged.copyleft.length > 0) {
        bodyLines.push(
          `Copyleft (${result.flagged.copyleft.length}):`,
          ...result.flagged.copyleft.map(
            (d) => `  - [${d.ecosystem}] ${d.name}@${d.version} — ${d.license}`,
          ),
        );
      }
      if (result.flagged.proprietary.length > 0) {
        bodyLines.push(
          `Proprietary (${result.flagged.proprietary.length}):`,
          ...result.flagged.proprietary.map(
            (d) => `  - [${d.ecosystem}] ${d.name}@${d.version} — ${d.license}`,
          ),
        );
      }
      if (result.flagged.unknown.length > 0) {
        bodyLines.push(
          `Unknown/missing (${result.flagged.unknown.length}):`,
          ...result.flagged.unknown
            .slice(0, 25)
            .map((d) => `  - [${d.ecosystem}] ${d.name}@${d.version}`),
        );
        if (result.flagged.unknown.length > 25) {
          bodyLines.push(
            `  ... ${result.flagged.unknown.length - 25} more (see structuredContent.flagged.unknown)`,
          );
        }
      }
      if (bodyLines.length === 0) {
        bodyLines.push("All licenses cleared.");
      }

      const nextSteps: string[] = [];
      if (result.tier === "BLOCK") {
        nextSteps.push(
          "review the copyleft/proprietary deps above — each must be replaced or explicitly approved by legal",
          "call `dependencies` with the offending ecosystem filter to see the full record",
        );
      } else if (result.tier === "WARN") {
        nextSteps.push(
          "populate missing licenses: re-index with `codehub analyze --force` once the license-detection follow-up lands",
          "call `dependencies` to inspect the raw Dependency rows",
        );
      } else {
        nextSteps.push(
          "no action required — re-run after bumping any dependency",
          "call `dependencies` to inspect the full list",
        );
      }

      return withNextSteps(
        [header, ...bodyLines].join("\n"),
        {
          tier: result.tier,
          flagged: result.flagged,
          summary: result.summary,
        },
        nextSteps,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerLicenseAuditTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "license_audit",
    {
      title: "Audit dependency licenses",
      description:
        "Classify every Dependency node by license risk: copyleft (GPL/AGPL/SSPL/EUPL/CPAL/OSL/RPL), proprietary, unknown. Returns tier=BLOCK if any copyleft or proprietary dep, WARN if only unknowns, OK otherwise. Note: until per-ecosystem license detection lands, most Dependency nodes carry license='UNKNOWN', so most audits will return tier=WARN until that follow-up ships.",
      inputSchema: LicenseAuditInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => fromToolResult(await runLicenseAudit(ctx, args)),
  );
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
