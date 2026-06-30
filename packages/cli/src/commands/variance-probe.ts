/**
 * `codehub code-pack --variance-probe <task-file>` — measure the run-to-run
 * answer variance an OCH pack removes from a coding agent (spec 010 / Move 2).
 *
 * Flow:
 *   1. Load + validate the task file (`@opencodehub/eval`'s `loadTask`).
 *   2. Generate the OCH code-pack for the task's repo (reuses `runCodePack`),
 *      then assemble its on-disk artifacts into a single `packContext` string —
 *      what the with-pack arm injects into the agent's context.
 *   3. Run the with/without experiment via the Bedrock-wired direct-CLI runner
 *      (`@opencodehub/eval`'s `CliAgentRunner`), N times per arm per harness.
 *   4. Emit the report — human summary to stderr, `--json` to stdout.
 *
 * `console.log` to stdout is sanctioned in command modules (biome override);
 * the JSON report goes to stdout so it pipes cleanly, the human summary to
 * stderr so it never pollutes a piped stdout (the context-bom discipline).
 *
 * The probe is on-demand and costs real agent minutes + Bedrock spend — it is
 * never a CI gate (spec 010 §8).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentRunner,
  CliAgentRunner,
  formatReport,
  type Harness,
  loadTask,
  type ProbeOptions,
  runProbe,
  serializeReport,
  type VarianceReport,
} from "@opencodehub/eval";
import { runCodePack } from "./code-pack.js";

export interface VarianceProbeArgs {
  /** Path to the task file (YAML or JSON). */
  readonly taskFile: string;
  /** Runs per arm. Defaults to the probe's DEFAULT_RUNS (10). */
  readonly runs?: number;
  /** Restrict to one harness; omitted runs the task's set (default both). */
  readonly harness?: Harness;
  /** AWS region for Bedrock inference; falls back to the inherited env. */
  readonly awsRegion?: string;
  /**
   * Per-harness Bedrock model / inference-profile override. Claude and Codex
   * take different model ids (a `us.`-prefixed Anthropic profile vs an
   * `openai.*` Bedrock model), so one global value cannot serve both — each
   * harness reads its own entry, falling back to the runner's per-harness
   * default when absent.
   */
  readonly models?: Partial<Record<Harness, string>>;
  /**
   * Test seam — inject a fake pack-context assembler so unit tests don't need a
   * real analyzed repo + pack on disk.
   */
  readonly _assemblePackContext?: (repo: string) => Promise<string>;
  /**
   * Test seam — inject a runner factory so unit tests drive a fake agent
   * instead of spawning the real `claude` / `codex` CLIs.
   */
  readonly _runnerFor?: (harness: Harness) => AgentRunner;
}

/**
 * Assemble the on-disk pack directory into a single context string. Reads the
 * consumer-facing `readme.md` plus the BOM body files (`*.jsonl`, `*.md`) in
 * sorted order, so the injected context is deterministic. The manifest +
 * context-bom.json are provenance records, not agent-facing content, so they
 * are skipped.
 */
export async function assemblePackContext(packOutDir: string): Promise<string> {
  const entries = await readdir(packOutDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n !== "manifest.json" && n !== "context-bom.json")
    .sort();

  const parts: string[] = [];
  for (const name of files) {
    const body = await readFile(join(packOutDir, name), "utf8");
    parts.push(`### ${name}\n\n${body}`);
  }
  return parts.join("\n\n");
}

/**
 * Run the variance probe. Returns the report so callers (and tests) can assert
 * on it; the CLI action prints it.
 */
export async function runVarianceProbe(args: VarianceProbeArgs): Promise<VarianceReport> {
  const task = await loadTask(args.taskFile);

  // 1. Generate the OCH pack for the task's repo (requires it to be analyzed).
  //    Then assemble its artifacts into the context the with-pack arm injects.
  const assemble = args._assemblePackContext ?? defaultAssemble;
  const packContext = await assemble(task.repo);

  // 2. The runner factory: a Bedrock-wired direct-CLI runner per harness
  //    (spec 010 §4a). Tests inject a fake via `_runnerFor`.
  const runnerFor =
    args._runnerFor ??
    ((harness: Harness) => {
      const model = args.models?.[harness];
      return new CliAgentRunner({
        harness,
        ...(model !== undefined ? { model } : {}),
        ...(args.awsRegion !== undefined ? { awsRegion: args.awsRegion } : {}),
      });
    });

  const options: ProbeOptions = {
    packContext,
    ...(args.runs !== undefined ? { runs: args.runs } : {}),
    ...(args.harness !== undefined ? { harnesses: [args.harness] } : {}),
  };

  return runProbe(task, runnerFor, options);
}

/**
 * Production pack-context assembler: generate the pack for `repo` via the same
 * `runCodePack` the bare `code-pack` command uses, then read its artifacts.
 */
async function defaultAssemble(repo: string): Promise<string> {
  const result = await runCodePack({ repo, engine: "pack" });
  return assemblePackContext(result.outDir);
}

/**
 * Print a {@link VarianceReport}. JSON → stdout (machine consumers / `--json`);
 * the human summary → stderr so it never pollutes a piped stdout.
 */
export function printVarianceReport(report: VarianceReport, asJson: boolean): void {
  if (asJson) {
    console.log(serializeReport(report));
  } else {
    console.warn(formatReport(report));
  }
}
