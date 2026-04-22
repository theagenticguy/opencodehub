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
 *                   by W2-I5 when a manifest parser could not recover a
 *                   declared license. W2-I7+N will populate real licenses
 *                   from ecosystem metadata; until then most audits WILL
 *                   return tier=WARN.
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
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const LicenseAuditInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
};

/**
 * Copyleft license prefix matcher. Upper-cased inputs only — callers must
 * normalise. The regex is anchored so `LGPL-3.0` does NOT match `^GPL`
 * (LGPL is weak copyleft → classified as UNKNOWN/WARN for v1.0, upgraded
 * in a follow-up task).
 */
const COPYLEFT_PATTERN = /^(GPL|AGPL|SSPL|EUPL|CPAL|OSL|RPL)/;

export interface DependencyRef {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly license: string;
  readonly lockfileSource: string;
}

export type LicenseTier = "OK" | "WARN" | "BLOCK";

export interface LicenseAuditFlagged {
  readonly copyleft: readonly DependencyRef[];
  readonly unknown: readonly DependencyRef[];
  readonly proprietary: readonly DependencyRef[];
}

export interface LicenseAuditResult {
  readonly tier: LicenseTier;
  readonly flagged: LicenseAuditFlagged;
  readonly summary: {
    readonly total: number;
    readonly okCount: number;
    readonly flaggedCount: number;
  };
}

/**
 * Pure classification. Exposed so unit tests can assert tier logic
 * without touching the MCP server scaffolding.
 */
export function classifyDependencies(deps: readonly DependencyRef[]): LicenseAuditResult {
  const copyleft: DependencyRef[] = [];
  const unknown: DependencyRef[] = [];
  const proprietary: DependencyRef[] = [];

  for (const d of deps) {
    const normalised = d.license.trim().toUpperCase();
    if (normalised === "" || normalised === "UNKNOWN") {
      unknown.push(d);
    } else if (normalised === "PROPRIETARY") {
      proprietary.push(d);
    } else if (COPYLEFT_PATTERN.test(normalised)) {
      copyleft.push(d);
    }
  }

  const flaggedCount = copyleft.length + unknown.length + proprietary.length;
  const hasBlocking = copyleft.length > 0 || proprietary.length > 0;
  const tier: LicenseTier = hasBlocking ? "BLOCK" : unknown.length > 0 ? "WARN" : "OK";

  return {
    tier,
    flagged: { copyleft, unknown, proprietary },
    summary: {
      total: deps.length,
      okCount: deps.length - flaggedCount,
      flaggedCount,
    },
  };
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
    async (args) => {
      return withStore(ctx, args.repo, async (store, resolved) => {
        try {
          const rows = (await store.query(
            `SELECT id, name, version, license, lockfile_source, ecosystem, file_path
             FROM nodes
             WHERE kind = 'Dependency'
             ORDER BY id`,
            [],
          )) as ReadonlyArray<Record<string, unknown>>;

          const deps: DependencyRef[] = rows.map((r) => ({
            id: String(r["id"] ?? ""),
            name: String(r["name"] ?? ""),
            version: stringOr(r["version"], "UNKNOWN"),
            ecosystem: stringOr(r["ecosystem"], "unknown"),
            license: stringOr(r["license"], "UNKNOWN"),
            lockfileSource: stringOr(r["lockfile_source"], String(r["file_path"] ?? "")),
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
    },
  );
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
