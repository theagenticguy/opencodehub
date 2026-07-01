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
import {
  type CacheChannel,
  cacheBreakpointSentinel,
  cacheChannelNeedsMarkers,
  DEFAULT_CACHE_CHANNEL,
} from "@opencodehub/pack";
import { DEFAULT_TOKENIZER_ID, runCodePack } from "./code-pack.js";

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
   * Tokenizer-provenance lane the with-pack arm packs under
   * ("<vendor>:<name>@<pin>"). Defaults to the pack's DEFAULT_TOKENIZER_ID when
   * absent. Recorded on the report's `packTokenizerId` so Finding 0001 v2 can
   * attribute results to a lane (e.g. SONNET5_TOKENIZER_ID for Sonnet 5's
   * heavier tokenizer).
   */
  readonly packTokenizer?: string;
  /**
   * Delivery channel for channel-aware cache-prefix enforcement (Move 4).
   * Threads into the pack-context assembler so the probe's with-pack arm gets
   * a cache-breakpoint marker on the opt-in channels (`bedrock`, `vertex`) and
   * a marker-free byte-identical context on the automatic channels + the
   * `auto` default. Defaults to `auto` when omitted.
   */
  readonly cacheChannel?: CacheChannel;
  /**
   * Test seam — inject a fake pack-context assembler so unit tests don't need a
   * real analyzed repo + pack on disk. Receives the resolved tokenizer lane so
   * a test can assert it threads through to the assemble call.
   */
  readonly _assemblePackContext?: (repo: string, tokenizer: string) => Promise<string>;
  /**
   * Test seam — inject a runner factory so unit tests drive a fake agent
   * instead of spawning the real `claude` / `codex` CLIs.
   */
  readonly _runnerFor?: (harness: Harness) => AgentRunner;
}

/**
 * The deterministic prefix boundary for channel-aware cache enforcement
 * (Move 4). Files whose names sort at or before this marker are the "stable
 * prefix" (skeleton + file-tree — the large, slow-to-change bulk of a pack);
 * everything after is the volatile tail (findings, xrefs, licenses, readme,
 * …). When a channel needs cache markers, the cache-breakpoint sentinel is
 * inserted at exactly this boundary so the expensive stable prefix is cached
 * and only the tail is re-processed run-to-run.
 *
 * Chosen because `file-tree.jsonl` and `skeleton.jsonl` are the two files that
 * sort first among the pack body files AND are the deterministic, high-volume
 * structural artifacts — the ideal cache prefix. The boundary is expressed as a
 * predicate over the sorted file list rather than a hard-coded index so it
 * stays correct if a pack omits one of these files.
 */
const STABLE_PREFIX_FILES: ReadonlySet<string> = new Set(["file-tree.jsonl", "skeleton.jsonl"]);

/**
 * Assemble the on-disk pack directory into a single context string. Reads the
 * consumer-facing `readme.md` plus the BOM body files (`*.jsonl`, `*.md`) in
 * sorted order, so the injected context is deterministic. The manifest +
 * context-bom.json are provenance records, not agent-facing content, so they
 * are skipped.
 *
 * Move 4 — channel-aware cache-prefix enforcement: when `cacheChannel` needs
 * explicit cache markers (classic Bedrock / Vertex, which do NOT cache
 * automatically), a single cache-breakpoint sentinel is inserted at the
 * deterministic prefix boundary (after the stable skeleton/file-tree prefix,
 * before the volatile tail). Automatic channels (`anthropic`,
 * `claude-on-aws`, `foundry`) and the `auto` default emit NO marker, so the
 * default path is byte-identical to the pre-Move-4 output. Same inputs + same
 * channel → identical bytes.
 */
export async function assemblePackContext(
  packOutDir: string,
  cacheChannel: CacheChannel = DEFAULT_CACHE_CHANNEL,
): Promise<string> {
  const entries = await readdir(packOutDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n !== "manifest.json" && n !== "context-bom.json")
    .sort();

  const insertMarker = cacheChannelNeedsMarkers(cacheChannel);
  const sentinel = insertMarker ? cacheBreakpointSentinel(cacheChannel) : "";

  const parts: string[] = [];
  let markerInserted = false;
  for (const name of files) {
    const body = await readFile(join(packOutDir, name), "utf8");
    parts.push(`### ${name}\n\n${body}`);
    // Insert the cache-breakpoint sentinel once, immediately after the last
    // stable-prefix file that is present. The next non-prefix file starts the
    // volatile tail, so this is the deterministic cache boundary.
    if (insertMarker && !markerInserted && STABLE_PREFIX_FILES.has(name)) {
      const next = files[files.indexOf(name) + 1];
      if (next === undefined || !STABLE_PREFIX_FILES.has(next)) {
        parts.push(sentinel);
        markerInserted = true;
      }
    }
  }
  // Edge case: markers needed but no stable-prefix file present. Emit the
  // sentinel at the very front so the boundary still exists deterministically.
  if (insertMarker && !markerInserted) {
    parts.unshift(sentinel);
  }
  return parts.join("\n\n");
}

/**
 * Run the variance probe. Returns the report so callers (and tests) can assert
 * on it; the CLI action prints it.
 */
export async function runVarianceProbe(args: VarianceProbeArgs): Promise<VarianceReport> {
  const task = await loadTask(args.taskFile);

  // Resolve the tokenizer-provenance lane the with-pack arm packs under. When
  // the flag is absent, packing stays on DEFAULT_TOKENIZER_ID (unchanged
  // behavior); a caller opts into e.g. Sonnet 5's heavier tokenizer by passing
  // SONNET5_TOKENIZER_ID. The resolved lane is recorded on the report so
  // Finding 0001 v2 attributes results to a tokenizer.
  const packTokenizerId = args.packTokenizer ?? DEFAULT_TOKENIZER_ID;

  //    The cache channel (Move 4) threads into the default assembler so the
  //    with-pack context carries a cache-breakpoint marker on opt-in channels;
  //    the tokenizer lane (Move 1) controls the pack's chunk sizing.
  const cacheChannel = args.cacheChannel ?? DEFAULT_CACHE_CHANNEL;

  // 1. Generate the OCH pack for the task's repo (requires it to be analyzed).
  //    Then assemble its artifacts into the context the with-pack arm injects.
  //    The test seam receives the resolved tokenizer lane; the production
  //    assembler also binds the cache channel.
  const assemble =
    args._assemblePackContext ??
    ((repo: string, tokenizer: string) => defaultAssemble(repo, tokenizer, cacheChannel));
  const packContext = await assemble(task.repo, packTokenizerId);

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
    packTokenizerId,
    ...(args.runs !== undefined ? { runs: args.runs } : {}),
    ...(args.harness !== undefined ? { harnesses: [args.harness] } : {}),
  };

  return runProbe(task, runnerFor, options);
}

/**
 * Production pack-context assembler: generate the pack for `repo` via the same
 * `runCodePack` the bare `code-pack` command uses, then read its artifacts.
 * Packs under the resolved tokenizer-provenance lane (Move 1) so the with-pack
 * arm's chunking reflects the consuming agent's tokenizer, and threads the
 * cache channel (Move 4) so the assembled context carries a cache-breakpoint
 * marker on the opt-in channels.
 */
async function defaultAssemble(
  repo: string,
  tokenizer: string,
  cacheChannel: CacheChannel = DEFAULT_CACHE_CHANNEL,
): Promise<string> {
  const result = await runCodePack({ repo, engine: "pack", tokenizer, cacheChannel });
  return assemblePackContext(result.outDir, cacheChannel);
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
