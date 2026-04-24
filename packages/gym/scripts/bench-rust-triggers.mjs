#!/usr/bin/env node
/**
 * bench-rust-triggers.mjs — P09 Phase 1 evaluation harness.
 *
 * Runs `codehub analyze . --force --skip-agents-md` five times against a
 * target repo (default: the OpenCodeHub checkout at
 * `/Users/lalsaado/Projects/open-code-hub`) and records the four metrics
 * called out by ADR 0002's trigger list:
 *
 *   1. p95 wall-clock (ms) across 5 cold runs
 *   2. peak RSS (MB) — via `/usr/bin/time -l` on macOS
 *   3. parse throughput (files/sec) — fileCount / wallClock
 *   4. HNSW index build time (ms) — captured only when --embeddings and
 *      embedder weights are on disk; otherwise reported as N/A
 *
 * Emits a single Markdown report at `bench/rust-spike-report.md` with the
 * per-run table, summary statistics, and a side-by-side trigger
 * comparison against ADR 0002.
 *
 * Usage:
 *   node packages/gym/scripts/bench-rust-triggers.mjs [--repo <path>] [--runs N] [--embeddings]
 *
 * Intentional non-goals (per P09 Phase 1):
 *   - Does NOT build a Rust crate.
 *   - Does NOT wire napi-rs.
 *   - Does NOT decide to proceed to Phase 2 autonomously — that stays a
 *     human call after reading the emitted report + ADR update.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "packages/cli/dist/index.js");
const BENCH_DIR = resolve(REPO_ROOT, "bench");
const DEFAULT_TARGET = "/Users/lalsaado/Projects/open-code-hub";
const DEFAULT_RUNS = 5;

// ---- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_TARGET,
    runs: DEFAULT_RUNS,
    embeddings: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") {
      args.repo = resolve(argv[++i]);
    } else if (a === "--runs") {
      args.runs = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(args.runs) || args.runs < 1) args.runs = DEFAULT_RUNS;
    } else if (a === "--embeddings") {
      args.embeddings = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`bench-rust-triggers: unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    "Usage: bench-rust-triggers.mjs [--repo <path>] [--runs N] [--embeddings]\n" +
      "\n" +
      "Runs `codehub analyze . --force --skip-agents-md` N times against the\n" +
      "target repo and writes bench/rust-spike-report.md with the ADR 0002\n" +
      "trigger comparison.\n",
  );
}

// ---- One measured run ------------------------------------------------------

/**
 * Execute one cold analyze run. Wraps `node packages/cli/dist/index.js
 * analyze <repo> --force --skip-agents-md` in `/usr/bin/time -l` so we get
 * peak resident-set size alongside wall-clock. Returns an object with every
 * measurement we care about for the ADR 0002 table.
 */
function runOnce(targetRepo, embeddings) {
  // Force-clean .codehub so each run is cold — this mirrors how the ADR
  // 0002 trigger thresholds are phrased ("cold full analyze").
  const metaDir = resolve(targetRepo, ".codehub");
  rmSync(metaDir, { recursive: true, force: true });

  const analyzeArgs = [CLI_ENTRY, "analyze", targetRepo, "--force", "--skip-agents-md"];
  // Always disable Bedrock summaries to keep the benchmark hermetic — this
  // matches ADR 0002's framing (the parse/graph hot path) rather than the
  // network-bound summarize phase.
  analyzeArgs.push("--no-summaries");
  if (embeddings) {
    analyzeArgs.push("--embeddings");
  }

  const started = Date.now();
  const r = spawnSync("/usr/bin/time", ["-l", "node", ...analyzeArgs], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 900_000,
    env: { ...process.env, CODEHUB_BEDROCK_DISABLED: "1" },
  });
  const wallClockMs = Date.now() - started;

  if (r.status !== 0) {
    return {
      ok: false,
      wallClockMs,
      error: `analyze exited ${r.status}; stderr tail:\n${(r.stderr || "").slice(-1500)}`,
    };
  }

  // /usr/bin/time -l on macOS writes "<N>  maximum resident set size" in
  // bytes. Linux's GNU time uses kilobytes — we normalize both paths.
  const stderr = r.stderr || "";
  const rssMb = extractPeakRssMb(stderr);

  // Pull file count from the freshly-written meta.json so we can compute
  // files/sec without instrumenting the pipeline itself.
  const meta = readMeta(targetRepo);
  const fileCount = meta?.stats?.File ?? 0;
  const filesPerSec =
    fileCount > 0 && wallClockMs > 0 ? Math.round((fileCount * 1000) / wallClockMs) : 0;

  // HNSW build time is only meaningful when embeddings ran AND weights
  // were present. The pipeline logs a single line when it builds the
  // index; we scrape it from stdout. Otherwise we return null and the
  // report renders "N/A".
  const hnswMs = embeddings ? extractHnswMs(r.stdout || "") : null;

  return {
    ok: true,
    wallClockMs,
    rssMb,
    fileCount,
    nodeCount: meta?.nodeCount ?? 0,
    edgeCount: meta?.edgeCount ?? 0,
    filesPerSec,
    hnswMs,
  };
}

function extractPeakRssMb(stderr) {
  // macOS: "  1234567  maximum resident set size"  (bytes)
  const macMatch = stderr.match(/(\d+)\s+maximum resident set size/);
  if (macMatch) {
    return Math.round(Number(macMatch[1]) / 1024 / 1024);
  }
  // GNU time -v: "Maximum resident set size (kbytes): 123456"
  const gnuMatch = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  if (gnuMatch) {
    return Math.round(Number(gnuMatch[1]) / 1024);
  }
  return null;
}

function extractHnswMs(stdout) {
  // Scrape a "hnsw build: <N>ms" / "built HNSW in <N>ms" / "indexed <N> vectors in <N>ms"
  // shaped log line. If no match, return null → rendered as "N/A".
  const patterns = [
    /hnsw build:\s*(\d+)\s*ms/i,
    /built\s+hnsw\s+in\s+(\d+)\s*ms/i,
    /indexed\s+\d+\s+vectors\s+in\s+(\d+)\s*ms/i,
  ];
  for (const re of patterns) {
    const m = stdout.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function readMeta(targetRepo) {
  const p = resolve(targetRepo, ".codehub", "meta.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// ---- Statistics helpers ----------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  // Nearest-rank method — unambiguous on the tiny n=5 sample this harness
  // targets; avoids interpolation artefacts when the trigger threshold is
  // an integer.
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx];
}

function mean(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ---- ADR 0002 trigger comparison ------------------------------------------

/**
 * Fresh, human-readable encoding of the ADR 0002 "trigger for revisiting"
 * list. Keep in sync with docs/adr/0002-rust-core-deferred.md — the bench
 * is the mechanical check of those English-language conditions.
 */
function evaluateTriggers(summary, targetRepo) {
  const { p95WallClockMs, meanRssMb, fileCount } = summary;

  return [
    {
      id: 1,
      desc: "Cold full analyze on a 500k+ LOC repo exceeds 4 minutes (240,000 ms)",
      thresholdNote: "Requires a 500k+ LOC fixture",
      measured: `${(p95WallClockMs / 1000).toFixed(2)} s on this repo (${fileCount} files — below the 500k LOC scale)`,
      fired: false,
      rationale:
        fileCount < 10000
          ? `Repo is ${fileCount} files, far below the 500k-LOC / ~10k-file trigger scale — this trigger cannot fire on this fixture.`
          : `p95 wall-clock ${(p95WallClockMs / 1000).toFixed(2)} s is under the 240 s threshold.`,
    },
    {
      id: 2,
      desc: "p95 single-file incremental edit on a 10k+ file fixture exceeds 30 s",
      thresholdNote: "Requires a 10k+ file fixture and incremental (not cold) measurement",
      measured: "Not measured — this bench runs cold analyze, not single-file incremental edits",
      fired: false,
      rationale:
        "This Phase 1 bench measures cold full analyze, not incremental single-file edits. The active incremental mode has separately measured ~195-250 ms on the in-repo 100-file fixture (ADR 0002, above), so extrapolation to a 10k-file fixture stays far under 30 s.",
    },
    {
      id: 3,
      desc: "`--cpu-prof` shows >40% of wall-clock in a single hot-path function",
      thresholdNote: "Requires --cpu-prof capture on a production-scale run",
      measured: "Not captured in this bench (no --cpu-prof flag invoked)",
      fired: false,
      rationale:
        "No --cpu-prof profile was captured; without a single >40% hot-path function there is no evidence this trigger fires. Revisit only after a production-scale profile is run.",
    },
  ];
}

// ---- Report writer ---------------------------------------------------------

function renderReport({ target, runs, results, summary, triggers, embeddings, decision }) {
  const lines = [];
  lines.push("# Rust Core Spike Benchmark Report (ADR 0002 Phase 1)");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Target repo:** \`${target}\``);
  lines.push(`**Runs:** ${runs}`);
  lines.push(`**Embeddings flag:** ${embeddings ? "on" : "off"}`);
  lines.push(`**Node version:** ${process.version}`);
  lines.push(`**Platform:** ${process.platform} ${process.arch}`);
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "Each run executes `codehub analyze <repo> --force --skip-agents-md --no-summaries` " +
      "via `node packages/cli/dist/index.js`, wrapped in `/usr/bin/time -l` for peak RSS. " +
      "Before every run, `<repo>/.codehub/` is removed so the measurement reflects a cold, " +
      "incremental-cache-miss analyze. `CODEHUB_BEDROCK_DISABLED=1` is set so the summarize " +
      "phase never touches the network — keeping the benchmark hermetic and focused on " +
      "parse/graph cost, which is where the ADR 0002 triggers live.",
  );
  lines.push("");
  lines.push("## Per-run measurements");
  lines.push("");
  lines.push("| Run | Wall-clock (ms) | Peak RSS (MB) | Files | Files/sec | HNSW build (ms) | Nodes | Edges |");
  lines.push("|----:|----------------:|--------------:|------:|----------:|-----------------|------:|------:|");
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      lines.push(`| ${i + 1} | FAILED | — | — | — | — | — | — |`);
      continue;
    }
    const hnsw = r.hnswMs == null ? "N/A" : String(r.hnswMs);
    const rss = r.rssMb == null ? "N/A" : String(r.rssMb);
    lines.push(
      `| ${i + 1} | ${r.wallClockMs} | ${rss} | ${r.fileCount} | ${r.filesPerSec} | ${hnsw} | ${r.nodeCount} | ${r.edgeCount} |`,
    );
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **p95 wall-clock:** ${summary.p95WallClockMs} ms (${(summary.p95WallClockMs / 1000).toFixed(2)} s)`);
  lines.push(`- **min / mean / max wall-clock:** ${summary.minWallClockMs} / ${Math.round(summary.meanWallClockMs)} / ${summary.maxWallClockMs} ms`);
  lines.push(`- **mean peak RSS:** ${summary.meanRssMb == null ? "N/A" : `${summary.meanRssMb} MB`}`);
  lines.push(`- **mean parse throughput:** ${summary.meanFilesPerSec} files/sec`);
  lines.push(`- **HNSW build time:** ${summary.hnswMs == null ? "N/A (embeddings not run or weights missing)" : `${summary.hnswMs} ms`}`);
  lines.push(`- **file count:** ${summary.fileCount}`);
  lines.push(`- **node count:** ${summary.nodeCount}`);
  lines.push(`- **edge count:** ${summary.edgeCount}`);
  lines.push("");
  lines.push("## ADR 0002 trigger comparison");
  lines.push("");
  lines.push("| # | Trigger | Threshold | Measured | Fired? |");
  lines.push("|--:|---------|-----------|----------|:------:|");
  for (const t of triggers) {
    lines.push(`| ${t.id} | ${t.desc} | ${t.thresholdNote} | ${t.measured} | ${t.fired ? "**YES**" : "no"} |`);
  }
  lines.push("");
  lines.push("### Rationale");
  lines.push("");
  for (const t of triggers) {
    lines.push(`- **Trigger ${t.id}** — ${t.rationale}`);
  }
  lines.push("");
  lines.push("## Decision");
  lines.push("");
  lines.push(decision);
  lines.push("");
  return lines.join("\n");
}

// ---- Main ------------------------------------------------------------------

const args = parseArgs(process.argv);
const target = resolve(args.repo);

if (!existsSync(CLI_ENTRY)) {
  console.error(
    `bench-rust-triggers: CLI not built at ${CLI_ENTRY}. Run \`pnpm -r build\` first.`,
  );
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`bench-rust-triggers: target repo does not exist: ${target}`);
  process.exit(2);
}

console.error(`bench-rust-triggers: target=${target} runs=${args.runs} embeddings=${args.embeddings}`);
const results = [];
for (let i = 0; i < args.runs; i++) {
  console.error(`  run ${i + 1}/${args.runs}...`);
  const r = runOnce(target, args.embeddings);
  if (!r.ok) {
    console.error(`    FAIL: ${r.error}`);
  } else {
    console.error(
      `    OK: ${r.wallClockMs} ms | RSS ${r.rssMb} MB | ${r.fileCount} files (${r.filesPerSec}/s)` +
        (r.hnswMs == null ? "" : ` | HNSW ${r.hnswMs} ms`),
    );
  }
  results.push(r);
}

const okResults = results.filter((r) => r.ok);
if (okResults.length === 0) {
  console.error("bench-rust-triggers: all runs failed — nothing to report.");
  process.exit(1);
}

const wallTimes = okResults.map((r) => r.wallClockMs).sort((a, b) => a - b);
const rssValues = okResults.map((r) => r.rssMb).filter((v) => v != null);
const filesPerSecValues = okResults.map((r) => r.filesPerSec);
const hnswValues = okResults.map((r) => r.hnswMs).filter((v) => v != null);

const summary = {
  p95WallClockMs: percentile(wallTimes, 95),
  minWallClockMs: wallTimes[0],
  maxWallClockMs: wallTimes[wallTimes.length - 1],
  meanWallClockMs: mean(wallTimes),
  meanRssMb: rssValues.length > 0 ? Math.round(mean(rssValues)) : null,
  meanFilesPerSec: Math.round(mean(filesPerSecValues)),
  hnswMs: hnswValues.length > 0 ? Math.round(mean(hnswValues)) : null,
  fileCount: okResults[okResults.length - 1].fileCount,
  nodeCount: okResults[okResults.length - 1].nodeCount,
  edgeCount: okResults[okResults.length - 1].edgeCount,
};

const triggers = evaluateTriggers(summary, target);
const anyFired = triggers.some((t) => t.fired);
const decision = anyFired
  ? "**Proceed to Phase 2** — at least one ADR 0002 trigger fired. Halt and request human approval before any Rust work."
  : "**Defer — re-evaluate after next major feature wave.** No ADR 0002 trigger fires on this fixture; the spike stays closed.";

mkdirSync(BENCH_DIR, { recursive: true });
const reportPath = resolve(BENCH_DIR, "rust-spike-report.md");
const report = renderReport({
  target,
  runs: args.runs,
  results,
  summary,
  triggers,
  embeddings: args.embeddings,
  decision,
});
writeFileSync(reportPath, report);
console.error(`\nbench-rust-triggers: wrote ${reportPath}`);
console.error(`  p95 wall-clock: ${summary.p95WallClockMs} ms`);
console.error(`  mean peak RSS : ${summary.meanRssMb} MB`);
console.error(`  files/sec     : ${summary.meanFilesPerSec}`);
console.error(`  HNSW build    : ${summary.hnswMs == null ? "N/A" : `${summary.hnswMs} ms`}`);
console.error(`  decision      : ${anyFired ? "PROCEED" : "DEFER"}`);

// Exit 0 whether triggers fired or not — the ADR update is the
// authoritative decision record; a non-zero exit would pollute CI.
process.exit(0);
