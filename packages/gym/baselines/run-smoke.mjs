#!/usr/bin/env node
/**
 * Orchestrates the full E2E smoke harness across every gym fixture and
 * emits `packages/gym/baselines/performance.json` + `smoke-report.md`.
 *
 * Per fixture:
 *   - Runs `run-analyze-with-stats.mjs <path>` wrapped in `/usr/bin/time -l`
 *     so we capture wall-clock + peak RSS + per-phase timings together.
 *   - Runs the gym harness filtered to the fixture's language to verify the
 *     produced graph still satisfies the differential oracle contract.
 *   - Cleans up `<fixture>/.codehub/` when the fixture is a git submodule so
 *     the submodule's working tree stays clean.
 *
 * Skips fixtures that are absent (e.g. submodule not initialized).
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const BASELINES_DIR = resolve(import.meta.dirname);

const fixtures = [
  {
    name: "sdk-python",
    language: "python",
    path: "packages/gym/corpus/repos/python/sdk-python",
    submodule: true,
    corpusGlob: "packages/gym/corpus/python/**/*.yaml",
  },
  {
    name: "ts-pattern",
    language: "typescript",
    path: "packages/gym/corpus/repos/typescript/ts-pattern",
    submodule: true,
    corpusGlob: "packages/gym/corpus/typescript/**/*.yaml",
  },
  {
    name: "cobra",
    language: "go",
    path: "packages/gym/corpus/repos/go/cobra",
    submodule: true,
    corpusGlob: "packages/gym/corpus/go/**/*.yaml",
  },
  {
    name: "thiserror",
    language: "rust",
    path: "packages/gym/corpus/repos/rust/thiserror",
    submodule: true,
    corpusGlob: "packages/gym/corpus/rust/**/*.yaml",
  },
  {
    name: "electron-ws-python",
    language: "monorepo",
    path: "packages/gym/corpus/repos/monorepo/electron-ws-python",
    submodule: false,
    corpusGlob: "packages/gym/corpus/monorepo/**/*.yaml",
  },
];

function fixtureExists(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) return false;
  try {
    const s = statSync(abs);
    if (!s.isDirectory()) return false;
    // "initialized submodule" heuristic: non-empty directory.
    const entries = readdirSync(abs);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function getCommit(fixturePath) {
  const abs = resolve(ROOT, fixturePath);
  const r = spawnSync("git", ["-C", abs, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runAnalyze(fixturePath) {
  const abs = resolve(ROOT, fixturePath);
  // Force a clean run so phase timings reflect cold-start.
  rmSync(resolve(abs, ".codehub"), { recursive: true, force: true });
  const started = Date.now();
  const driver = resolve(BASELINES_DIR, "run-analyze-with-stats.mjs");
  const r = spawnSync(
    "/usr/bin/time",
    ["-l", "node", driver, abs],
    {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 600_000,
    },
  );
  const wallMs = Date.now() - started;
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  const statsLine = stdout.split("\n").find((l) => l.startsWith("STATS_JSON:"));
  if (!statsLine) {
    return {
      ok: false,
      wallMs,
      error: `no STATS_JSON line. stderr tail:\n${stderr.slice(-2000)}`,
    };
  }
  const stats = JSON.parse(statsLine.slice("STATS_JSON:".length));
  // Parse RSS from /usr/bin/time -l output (bytes on macOS).
  const rssMatch = stderr.match(/(\d+)\s+maximum resident set size/);
  const peakRssMb = rssMatch ? Math.round(Number(rssMatch[1]) / 1024 / 1024) : null;
  return { ok: r.status === 0, wallMs, stats, peakRssMb, stderr };
}

function runGymSmoke(fixture) {
  const cliPath = resolve(ROOT, "packages/gym/dist/cli.js");
  const args = ["run", "--corpus", fixture.corpusGlob];
  if (fixture.language !== "monorepo") {
    args.push("--language", fixture.language);
  }
  const r = spawnSync("node", [cliPath, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 300_000,
  });
  return {
    ok: r.status === 0,
    exitCode: r.status,
    stdoutTail: (r.stdout || "").slice(-500),
    stderrTail: (r.stderr || "").slice(-500),
  };
}

function cleanupFixture(fixture) {
  if (!fixture.submodule) return;
  const abs = resolve(ROOT, fixture.path);
  rmSync(resolve(abs, ".codehub"), { recursive: true, force: true });
}

const results = [];
const aggregateStart = Date.now();

for (const fixture of fixtures) {
  console.error(`\n=== ${fixture.name} (${fixture.language}) ===`);
  if (!fixtureExists(fixture.path)) {
    console.error(`  SKIP: ${fixture.path} not present`);
    results.push({
      name: fixture.name,
      language: fixture.language,
      path: fixture.path,
      skipped: true,
      reason: "submodule not initialized / path missing",
    });
    continue;
  }
  const commit = getCommit(fixture.path);
  console.error(`  commit: ${commit?.slice(0, 10) ?? "n/a"}`);
  console.error(`  analyze...`);
  const analyze = runAnalyze(fixture.path);
  if (!analyze.ok) {
    console.error(`  analyze FAILED after ${analyze.wallMs}ms: ${analyze.error ?? ""}`);
    console.error(analyze.stderr?.slice(-1000));
    results.push({
      name: fixture.name,
      language: fixture.language,
      path: fixture.path,
      commit,
      skipped: false,
      analyzeFailed: true,
      wallClockMs: analyze.wallMs,
      error: analyze.error ?? "analyze exited non-zero",
      mcpSmoke: false,
    });
    cleanupFixture(fixture);
    continue;
  }
  console.error(
    `  analyze OK: ${analyze.stats.nodeCount} nodes / ${analyze.stats.edgeCount} edges in ${analyze.stats.wallClockMs}ms (RSS ${analyze.peakRssMb}MB)`,
  );
  console.error(`  gym smoke...`);
  const smoke = runGymSmoke(fixture);
  console.error(`  gym smoke: exit=${smoke.exitCode} ok=${smoke.ok}`);
  results.push({
    name: fixture.name,
    language: fixture.language,
    path: fixture.path,
    commit,
    skipped: false,
    wallClockMs: analyze.stats.wallClockMs,
    peakRssMb: analyze.peakRssMb,
    nodeCount: analyze.stats.nodeCount,
    edgeCount: analyze.stats.edgeCount,
    lspPhaseEdges: analyze.stats.lspPhaseEdges,
    heuristicEdges: analyze.stats.heuristicEdges,
    demotedEdges: analyze.stats.demotedEdges,
    graphHash: analyze.stats.graphHash,
    phaseTimings: analyze.stats.phaseTimings,
    mcpSmoke: smoke.ok,
    mcpSmokeExit: smoke.exitCode,
    mcpSmokeStdoutTail: smoke.stdoutTail,
    mcpSmokeStderrTail: smoke.stderrTail,
    warningCount: analyze.stats.warningCount,
  });
  cleanupFixture(fixture);
}

const totalMs = Date.now() - aggregateStart;

// Toolchain versions (best-effort probes).
function tryVersion(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  if (r.status !== 0) return null;
  return (r.stdout || r.stderr || "").trim().split("\n")[0];
}

const toolchain = {
  node: process.version,
  pyright: tryVersion("pyright", ["--version"]),
  "typescript-language-server": tryVersion("typescript-language-server", ["--version"]),
  gopls: tryVersion("gopls", ["version"]),
  "rust-analyzer": tryVersion("rust-analyzer", ["--version"]),
};

const performance = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  totalWallClockMs: totalMs,
  toolchain,
  fixtures: results,
};

writeFileSync(
  resolve(BASELINES_DIR, "performance.json"),
  `${JSON.stringify(performance, null, 2)}\n`,
);

console.error(`\n=== done in ${totalMs}ms — wrote performance.json ===`);
