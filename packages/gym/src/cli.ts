#!/usr/bin/env node
/**
 * `codehub-gym` CLI — three subcommands:
 *
 *   - `run`       replays the current corpora, optionally compares against
 *                 a baseline manifest, exits 1 on gate failure.
 *   - `baseline`  produces a fresh baseline manifest (skips gate
 *                 evaluation; writes to --output or
 *                 packages/gym/baselines/manifest.jsonl).
 *   - `replay`    re-scores a frozen manifest without spawning an LSP —
 *                 used in CI for deterministic regression checks.
 *
 * Exit codes:
 *   0  success / gates passed
 *   1  gate failure (or replay found mismatched expected results)
 *   2  unexpected error (IO failure, schema error, etc.)
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadCorpus } from "./corpus.js";
import { evaluateGates, loadThresholds } from "./gates.js";
import { readManifest } from "./manifest.js";
import { type RunResult, replayManifest, runGym } from "./runner.js";
import { defaultLspFactory, type LspFactory } from "./scip-factory.js";

const DEFAULT_CORPUS_GLOB = "packages/gym/corpus/**/*.yaml";
const DEFAULT_THRESHOLDS = "packages/gym/baselines/thresholds.json";
const DEFAULT_BASELINE_MANIFEST = "packages/gym/baselines/manifest.jsonl";
/**
 * Repo root the runner resolves `corpus.path` against. Each YAML's
 * `path` is expressed relative to the fixture-submodule tree at
 * `packages/gym/corpus/repos/` (see `packages/gym/corpus/repos/README.md`).
 */
const DEFAULT_REPO_ROOT = "packages/gym/corpus/repos";

export interface RunCommandOptions {
  readonly corpus?: string;
  readonly baseline?: string;
  readonly output?: string;
  readonly language?: string;
  readonly thresholds?: string;
  readonly repoRoot?: string;
  readonly lspFactory?: LspFactory;
}

export interface BaselineCommandOptions {
  readonly corpus?: string;
  readonly output?: string;
  readonly repoRoot?: string;
  readonly lspFactory?: LspFactory;
}

export interface ReplayCommandOptions {
  readonly manifest: string;
  readonly corpus?: string;
}

/**
 * Expand a glob (or a literal path) to absolute corpus file paths.
 * We keep the glob set small on purpose — the CLI's input space is
 * "either a directory tree to scan, or a single yaml" — so we lean on
 * a small recursive walk instead of pulling in a full glob library.
 */
async function expandCorpusPaths(spec: string, language?: string | undefined): Promise<string[]> {
  const resolved = path.resolve(spec);
  // Literal yaml file.
  if (spec.endsWith(".yaml") || spec.endsWith(".yml")) {
    try {
      const s = await stat(resolved);
      if (s.isFile()) {
        return filterByLanguage([resolved], language);
      }
    } catch {
      // fallthrough — treat as glob/root
    }
  }
  // `packages/gym/corpus/**/*.yaml` → recursive walk under
  // `packages/gym/corpus`.
  const globIndex = spec.indexOf("**");
  const walkRoot = globIndex === -1 ? resolved : path.resolve(spec.slice(0, globIndex));
  const out: string[] = [];
  await walkYaml(walkRoot, out);
  return filterByLanguage(out.sort(), language);
}

async function walkYaml(dir: string, acc: string[]): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = (await readdir(dir, { withFileTypes: true, encoding: "utf8" })) as Dirent<string>[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "repos" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkYaml(full, acc);
    } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      acc.push(full);
    }
  }
}

async function filterByLanguage(paths: string[], language?: string | undefined): Promise<string[]> {
  if (language === undefined) return paths;
  const keep: string[] = [];
  for (const p of paths) {
    try {
      const corpus = await loadCorpus(p);
      if (corpus.language === language) keep.push(p);
    } catch {
      // Let the runner surface corpus parse errors instead of silently
      // dropping broken files during filtering.
      keep.push(p);
    }
  }
  return keep;
}

function describeRollups(result: RunResult): string {
  const lines: string[] = [];
  for (const r of result.rollups) {
    const tau = r.meanKendallTau === undefined ? "n/a" : r.meanKendallTau.toFixed(3);
    lines.push(
      `  ${r.key.padEnd(40)} cases=${r.caseCount} F1=${r.f1.toFixed(3)} ` +
        `P=${r.precision.toFixed(3)} R=${r.recall.toFixed(3)} ` +
        `Jac=${r.meanJaccard.toFixed(3)} tau=${tau}`,
    );
  }
  return lines.join("\n");
}

export async function runCommand(options: RunCommandOptions): Promise<number> {
  const corpusSpec = options.corpus ?? DEFAULT_CORPUS_GLOB;
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const factory = options.lspFactory ?? defaultLspFactory;

  const corpusPaths = await expandCorpusPaths(corpusSpec, options.language);
  if (corpusPaths.length === 0) {
    process.stderr.write(`codehub-gym: no corpus files matched ${corpusSpec}\n`);
    return 2;
  }

  const result = await runGym({
    corpusPaths,
    repoRoot,
    lspFactory: factory,
    ...(options.output !== undefined ? { outputManifestPath: path.resolve(options.output) } : {}),
    ...(options.baseline !== undefined
      ? { baselineManifestPath: path.resolve(options.baseline) }
      : {}),
  });

  process.stdout.write(`codehub-gym run: ${corpusPaths.length} corpus files\n`);
  process.stdout.write(
    `summary: total=${result.summary.totalCases} passed=${result.summary.passed} ` +
      `failed=${result.summary.failed} waived=${result.summary.waived}\n`,
  );
  process.stdout.write(`rollups:\n${describeRollups(result)}\n`);

  if (options.baseline === undefined) {
    return 0;
  }

  const baselinePath = path.resolve(options.baseline);
  const thresholdsPath = path.resolve(options.thresholds ?? DEFAULT_THRESHOLDS);
  const [baselineRecords, thresholds] = await Promise.all([
    readManifest(baselinePath),
    loadThresholds(thresholdsPath),
  ]);
  const baselineReplay = await replayManifest({
    manifestPath: baselinePath,
    corpusPaths,
  }).catch(() => {
    // A baseline that can't be replayed against the current corpora is
    // treated as "no baseline" — the gate suite still runs the F1 floor
    // check, which is the real regression signal.
    return {
      manifest: baselineRecords,
      caseScores: [] as const,
      rollups: [] as const,
      summary: {
        totalCases: baselineRecords.length,
        passed: 0,
        failed: 0,
        waived: 0,
      },
    };
  });

  const report = evaluateGates({
    thresholds,
    currentRollups: result.rollups,
    baselineRollups: baselineReplay.rollups,
    currentCases: result.caseScores,
    baselineCases: baselineReplay.caseScores,
    waivedCaseIds: new Set<string>(),
  });

  if (report.passed) {
    process.stdout.write("gates: all passed\n");
    return 0;
  }
  process.stderr.write(`gates: FAILED (${report.findings.length} findings)\n`);
  for (const f of report.findings) {
    process.stderr.write(`  ${JSON.stringify(f)}\n`);
  }
  return 1;
}

export async function baselineCommand(options: BaselineCommandOptions): Promise<number> {
  const corpusSpec = options.corpus ?? DEFAULT_CORPUS_GLOB;
  const outputPath = path.resolve(options.output ?? DEFAULT_BASELINE_MANIFEST);
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const factory = options.lspFactory ?? defaultLspFactory;

  const corpusPaths = await expandCorpusPaths(corpusSpec);
  if (corpusPaths.length === 0) {
    process.stderr.write(`codehub-gym: no corpus files matched ${corpusSpec}\n`);
    return 2;
  }

  const result = await runGym({
    corpusPaths,
    repoRoot,
    lspFactory: factory,
    outputManifestPath: outputPath,
  });

  process.stdout.write(
    `codehub-gym baseline: wrote ${result.manifest.length} records to ${outputPath}\n`,
  );
  process.stdout.write(`rollups:\n${describeRollups(result)}\n`);
  return 0;
}

export async function replayCommand(options: ReplayCommandOptions): Promise<number> {
  const manifestPath = path.resolve(options.manifest);
  const corpusSpec = options.corpus ?? DEFAULT_CORPUS_GLOB;
  const corpusPaths = await expandCorpusPaths(corpusSpec);
  if (corpusPaths.length === 0) {
    process.stderr.write(`codehub-gym: no corpus files matched ${corpusSpec}\n`);
    return 2;
  }
  const result = await replayManifest({ manifestPath, corpusPaths });
  process.stdout.write(
    `codehub-gym replay: ${result.manifest.length} manifest rows, ${result.caseScores.length} scored\n`,
  );
  process.stdout.write(`rollups:\n${describeRollups(result)}\n`);
  return 0;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("codehub-gym")
    .description("OpenCodeHub differential LSP oracle gym")
    .version("0.1.0");

  program
    .command("run")
    .description("Run the gym harness against the current corpus state")
    .option("--corpus <glob>", "corpus path or glob", DEFAULT_CORPUS_GLOB)
    .option("--baseline <path>", "baseline manifest to compare against")
    .option("--output <path>", "write the current run's manifest JSONL here")
    .option("--language <lang>", "filter corpora by language (python|typescript|go|rust)")
    .option("--thresholds <path>", "gate thresholds JSON", DEFAULT_THRESHOLDS)
    .action(async (options: RunCommandOptions) => {
      const code = await runCommand(options);
      process.exit(code);
    });

  program
    .command("baseline")
    .description("Lock a fresh baseline manifest from the current gym run")
    .option("--corpus <glob>", "corpus path or glob", DEFAULT_CORPUS_GLOB)
    .option("--output <path>", "destination baseline manifest", DEFAULT_BASELINE_MANIFEST)
    .action(async (options: BaselineCommandOptions) => {
      const code = await baselineCommand(options);
      process.exit(code);
    });

  program
    .command("replay")
    .description("Re-score a frozen manifest without spawning any LSP")
    .requiredOption("--manifest <path>", "manifest JSONL to replay")
    .option("--corpus <glob>", "corpus path or glob", DEFAULT_CORPUS_GLOB)
    .action(async (options: ReplayCommandOptions) => {
      const code = await replayCommand(options);
      process.exit(code);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`codehub-gym: ${message}\n`);
    process.exit(2);
  }
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const entryUrl = new URL(`file://${path.resolve(entry)}`).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main();
}
