/**
 * `scan` — run Priority-1 scanners against a repo and return merged SARIF.
 *
 * Unlike every other OpenCodeHub tool, `scan` has filesystem effects:
 * it spawns external scanner binaries and writes `.codehub/scan.sarif`
 * on disk. Annotations reflect that:
 *
 *   readOnlyHint    = false   — we write SARIF to disk
 *   destructiveHint = false   — we never delete anything
 *   openWorldHint   = true    — we spawn untrusted subprocesses
 *   idempotentHint  = false   — two scans can differ (tool output drift)
 *
 * The tool returns the merged SARIF plus a summary by tool + severity so
 * agents can reason about results without fetching the whole log.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { mkdir, writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SarifLog } from "@opencodehub/sarif";
import {
  ALL_SPECS,
  createDefaultWrappers,
  filterSpecsByProfile,
  type ProjectProfileGate,
  runScanners,
  type ScannerSpec,
} from "@opencodehub/scanners";
import { resolveRepoMetaDir } from "@opencodehub/storage";
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

const ScanInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
  scanners: z
    .array(z.string())
    .optional()
    .describe(
      "Explicit scanner ids. When omitted, scanners are gated by the ProjectProfile languages.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Per-scanner wall-clock timeout in ms (default 300000)."),
};

interface ScanSummary {
  readonly total: number;
  readonly byTool: Record<string, number>;
  readonly bySeverity: Record<string, number>;
}

interface ScanArgs {
  readonly repo?: string | undefined;
  readonly scanners?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

export async function runScan(ctx: ToolContext, args: ScanArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const specs = await selectScanners(store, args.scanners);
      if (specs.length === 0) {
        return withNextSteps(
          `No scanners selected for ${resolved.name}.`,
          { sarif: { version: "2.1.0", runs: [] } as SarifLog, summary: emptySummary() },
          [
            "pass explicit scanners=['semgrep'] to override profile gating",
            "run `codehub analyze --force` to refresh the ProjectProfile",
          ],
          stalenessFromMeta(resolved.meta),
        );
      }
      const wrappers = createDefaultWrappers(specs);
      const runnerOpts = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {};
      const result = await runScanners(resolved.repoPath, wrappers, runnerOpts);

      // Persist merged SARIF to `.codehub/scan.sarif` for later ingestion.
      await mkdir(resolveRepoMetaDir(resolved.repoPath), { recursive: true });
      const sarifPath = `${resolveRepoMetaDir(resolved.repoPath)}/scan.sarif`;
      await writeFile(sarifPath, `${JSON.stringify(result.sarif, null, 2)}\n`, "utf8");

      const summary = summarize(result.sarif);
      const errored = result.errored.map((e) => `${e.spec.id}: ${e.error}`);
      const header = `scan — ${summary.total} findings across ${
        Object.keys(summary.byTool).length
      } scanner(s); wrote ${sarifPath}`;
      const lines: string[] = [header];
      for (const [tool, count] of Object.entries(summary.byTool).sort()) {
        lines.push(`  ${tool}: ${count}`);
      }
      if (errored.length > 0) {
        lines.push("Errored scanners:");
        for (const e of errored) lines.push(`  - ${e}`);
      }

      const next = [
        "call `list_findings` to browse the ingested findings",
        "call `codehub ingest-sarif` to re-ingest if you edit the SARIF",
      ];

      return withNextSteps(
        lines.join("\n"),
        { sarif: result.sarif, summary, errored, outputPath: sarifPath },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerScanTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "scan",
    {
      title: "Run Priority-1 scanners",
      description:
        "Spawn Semgrep + Betterleaks + OSV-Scanner (+ Bandit/Biome when the project profile supports them), merge their SARIF outputs, write `.codehub/scan.sarif`, and return a summary. Selected scanners default to the polyglot set filtered by ProjectProfile.languages. IMPORTANT: this tool has filesystem effects and spawns external processes.",
      inputSchema: ScanInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async (args) => fromToolResult(await runScan(ctx, args)),
  );
}

async function selectScanners(
  store: {
    query: (
      sql: string,
      params?: readonly (string | number)[],
    ) => Promise<readonly Record<string, unknown>[]>;
  },
  explicit: readonly string[] | undefined,
): Promise<readonly ScannerSpec[]> {
  if (explicit !== undefined && explicit.length > 0) {
    const wanted = new Set(explicit);
    return ALL_SPECS.filter((s) => wanted.has(s.id));
  }
  const profile = await readProfile(store);
  return filterSpecsByProfile(ALL_SPECS, profile);
}

async function readProfile(store: {
  query: (
    sql: string,
    params?: readonly (string | number)[],
  ) => Promise<readonly Record<string, unknown>[]>;
}): Promise<ProjectProfileGate> {
  try {
    const rows = await store.query(
      "SELECT languages_json, iac_types_json, api_contracts_json FROM nodes WHERE kind = 'ProjectProfile' LIMIT 1",
      [],
    );
    const first = rows[0];
    if (!first) return {};
    return {
      languages: parseJsonArray(first["languages_json"]),
      iacTypes: parseJsonArray(first["iac_types_json"]),
      apiContracts: parseJsonArray(first["api_contracts_json"]),
    };
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function summarize(sarif: SarifLog): ScanSummary {
  const byTool: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let total = 0;
  for (const run of sarif.runs) {
    const tool = run.tool.driver.name;
    const count = run.results?.length ?? 0;
    byTool[tool] = (byTool[tool] ?? 0) + count;
    total += count;
    for (const result of run.results ?? []) {
      const level = result.level ?? "note";
      bySeverity[level] = (bySeverity[level] ?? 0) + 1;
    }
  }
  return { total, byTool, bySeverity };
}

function emptySummary(): ScanSummary {
  return { total: 0, byTool: {}, bySeverity: {} };
}
