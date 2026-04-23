/**
 * `list_findings_delta` — expose the SARIF baseline diff as an MCP tool.
 *
 * The SARIF baseline snapshot lives at `<repo>/.codehub/baseline.sarif`
 * (frozen via `codehub baseline freeze`); the latest scan lives at
 * `<repo>/.codehub/scan.sarif` (written by `codehub scan` / the `scan`
 * tool). This tool reads both, runs {@link diffSarif}, and returns the
 * four buckets (`new`, `fixed`, `unchanged`, `updated`) reshaped into an
 * agent-friendly per-finding view keyed on the `opencodehub/v1` partial
 * fingerprint.
 *
 * Annotation rationale:
 *   readOnlyHint    = true   — reads two SARIF files; writes nothing.
 *   destructiveHint = false  — no mutations.
 *   openWorldHint   = false  — no external processes or network.
 *   idempotentHint  = true   — same inputs → same buckets every call.
 *
 * Error handling:
 *   - Missing `.codehub/scan.sarif` → tool-level error with a "run
 *     `codehub scan` first" hint.
 *   - Missing baseline → every current finding bucketed as `new` with a
 *     `warning` surfaced alongside the payload so the agent knows the
 *     baseline has never been frozen.
 *   - Corrupt SARIF JSON / schema violation → `SCHEMA_MISMATCH` envelope.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type DiffResult,
  diffSarif,
  type SarifLog,
  SarifLogSchema,
  type SarifResult,
} from "@opencodehub/sarif";
import { resolveRepoMetaDir } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const ListFindingsDeltaInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
  baseline: z
    .string()
    .optional()
    .describe(
      "Custom path to a baseline SARIF log. When omitted, defaults to `<repo>/.codehub/baseline.sarif`.",
    ),
};

type BaselineStateTag = "new" | "fixed" | "unchanged" | "updated";

interface FindingDeltaRow {
  readonly ruleId: string;
  readonly severity: string;
  readonly scannerId: string;
  readonly message: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly fingerprint?: string;
  readonly baselineState: BaselineStateTag;
}

interface DeltaSummary {
  readonly new: number;
  readonly fixed: number;
  readonly unchanged: number;
  readonly updated: number;
}

interface DeltaFindings {
  readonly new: readonly FindingDeltaRow[];
  readonly fixed: readonly FindingDeltaRow[];
  readonly unchanged: readonly FindingDeltaRow[];
  readonly updated: readonly FindingDeltaRow[];
}

const OPENCODEHUB_FINGERPRINT_KEY = "opencodehub/v1";

const EMPTY_SARIF_LOG: SarifLog = {
  version: "2.1.0",
  runs: [],
};

export function registerListFindingsDeltaTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_findings_delta",
    {
      title: "Diff SARIF findings against baseline",
      description:
        "Diff the latest scan (`.codehub/scan.sarif`) against the frozen baseline (`.codehub/baseline.sarif` by default) and return findings bucketed into new / fixed / unchanged / updated, keyed on `partialFingerprints['opencodehub/v1']`. Read-only: reads SARIF files, writes nothing.",
      inputSchema: ListFindingsDeltaInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      return withStore(ctx, args.repo, async (_store, resolved) => {
        try {
          const metaDir = resolveRepoMetaDir(resolved.repoPath);
          const currentPath = resolve(`${metaDir}/scan.sarif`);
          const baselinePath = resolve(args.baseline ?? `${metaDir}/baseline.sarif`);

          const currentRead = await readSarif(currentPath);
          if (currentRead.kind === "missing") {
            return toolError(
              "NOT_FOUND",
              `No scan log found at ${currentPath}`,
              "Run `codehub scan` (or the `scan` MCP tool) in the target repo to generate .codehub/scan.sarif before diffing.",
            );
          }
          if (currentRead.kind === "invalid") {
            return toolError(
              "SCHEMA_MISMATCH",
              `scan.sarif at ${currentPath} failed SARIF 2.1.0 validation: ${currentRead.message}`,
              "Regenerate the scan log with `codehub scan`; the existing file may be truncated or from an older format.",
            );
          }

          const baselineRead = await readSarif(baselinePath);
          const warnings: string[] = [];
          let diff: DiffResult;
          if (baselineRead.kind === "missing") {
            warnings.push(
              `No baseline found at ${baselinePath}; treating every current finding as new. Run \`codehub baseline freeze\` to establish a baseline.`,
            );
            diff = diffSarif(EMPTY_SARIF_LOG, currentRead.log);
          } else if (baselineRead.kind === "invalid") {
            return toolError(
              "SCHEMA_MISMATCH",
              `baseline.sarif at ${baselinePath} failed SARIF 2.1.0 validation: ${baselineRead.message}`,
              "Re-freeze the baseline with `codehub baseline freeze`; the existing file may be truncated or from an older format.",
            );
          } else {
            diff = diffSarif(baselineRead.log, currentRead.log);
          }

          const findings: DeltaFindings = {
            new: diff.new.map((r) => toRow(r, "new")),
            fixed: diff.fixed.map((r) => toRow(r, "fixed")),
            unchanged: diff.unchanged.map((r) => toRow(r, "unchanged")),
            updated: diff.updated.map((r) => toRow(r, "updated")),
          };
          const summary: DeltaSummary = {
            new: findings.new.length,
            fixed: findings.fixed.length,
            unchanged: findings.unchanged.length,
            updated: findings.updated.length,
          };

          const header = `Findings delta for ${resolved.name}: ${summary.new} new · ${summary.fixed} fixed · ${summary.unchanged} unchanged · ${summary.updated} updated`;
          const lines: string[] = [header];
          if (warnings.length > 0) {
            for (const w of warnings) lines.push(`Warning: ${w}`);
          }
          if (summary.new > 0) {
            lines.push("New findings:");
            for (const row of findings.new.slice(0, 25)) {
              lines.push(formatRow(row));
            }
            if (findings.new.length > 25) {
              lines.push(`  … and ${findings.new.length - 25} more`);
            }
          }

          const next =
            summary.new > 0
              ? [
                  "call `context` with a new finding's filePath for caller/callee neighbours",
                  "call `verdict` to see how the delta maps to a PR decision",
                ]
              : summary.fixed > 0
                ? [
                    "call `baseline freeze` via the CLI to adopt the improved state as the new baseline",
                  ]
                : [
                    "call `list_findings` for the full non-delta finding list",
                    "call `scan` to refresh .codehub/scan.sarif",
                  ];

          return withNextSteps(
            lines.join("\n"),
            {
              summary,
              findings,
              baselinePath,
              currentPath,
              warnings,
            },
            next,
            stalenessFromMeta(resolved.meta),
          );
        } catch (err) {
          return toolErrorFromUnknown(err);
        }
      });
    },
  );
}

type SarifReadResult =
  | { readonly kind: "ok"; readonly log: SarifLog }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string };

async function readSarif(path: string): Promise<SarifReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "invalid", message: `JSON parse error: ${message}` };
  }
  const validated = SarifLogSchema.safeParse(parsedJson);
  if (!validated.success) {
    return { kind: "invalid", message: validated.error.message };
  }
  return { kind: "ok", log: validated.data };
}

function toRow(result: SarifResult, state: BaselineStateTag): FindingDeltaRow {
  const physical = result.locations?.[0]?.physicalLocation;
  const uri =
    typeof physical?.artifactLocation.uri === "string" ? physical.artifactLocation.uri : "";
  const startLine = physical?.region?.startLine;
  const severity = typeof result.level === "string" ? result.level : "none";
  const messageText = typeof result.message?.text === "string" ? result.message.text : "";
  const fingerprint = fingerprintOf(result);
  const scannerId = scannerIdOf(result);

  const row: FindingDeltaRow = {
    ruleId: typeof result.ruleId === "string" ? result.ruleId : "",
    severity,
    scannerId,
    message: messageText,
    filePath: uri,
    baselineState: state,
    ...(typeof startLine === "number" && Number.isFinite(startLine) ? { startLine } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
  return row;
}

function fingerprintOf(result: SarifResult): string | undefined {
  const pf = result.partialFingerprints;
  if (pf === undefined || pf === null) return undefined;
  const candidate = (pf as Record<string, unknown>)[OPENCODEHUB_FINGERPRINT_KEY];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Extract a scanner id for display purposes. SARIF does not carry a
 * per-result scanner name (only per-run). We check the result properties
 * bag first (opencodehub enrichment stashes the source tool there) and
 * fall back to the rule id's prefix when that is absent.
 */
function scannerIdOf(result: SarifResult): string {
  const props = result.properties;
  if (props !== undefined && props !== null) {
    const ocProps = (props as Record<string, unknown>)["opencodehub"];
    if (ocProps !== null && typeof ocProps === "object") {
      const scannerId = (ocProps as Record<string, unknown>)["scannerId"];
      if (typeof scannerId === "string" && scannerId.length > 0) return scannerId;
    }
    const flat = (props as Record<string, unknown>)["scannerId"];
    if (typeof flat === "string" && flat.length > 0) return flat;
  }
  const ruleId = typeof result.ruleId === "string" ? result.ruleId : "";
  const dot = ruleId.indexOf(".");
  if (dot > 0) return ruleId.slice(0, dot);
  return "unknown";
}

function formatRow(row: FindingDeltaRow): string {
  const loc = row.startLine !== undefined ? `${row.filePath}:${row.startLine}` : row.filePath;
  const msg = row.message ? ` — ${row.message}` : "";
  return `  - [${row.severity}] ${row.scannerId}:${row.ruleId} at ${loc}${msg}`;
}
