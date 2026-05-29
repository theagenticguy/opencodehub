/**
 * `codehub risk-trends` — per-community risk trajectory + 30-day projection.
 *
 * CLI sibling of the MCP `risk_trends` tool. Unlike the other read-only
 * commands this one does NOT touch the graph — it reads the snapshot history
 * written by the risk-snapshot phase (`.codehub/history/risk_*.json`) and
 * runs `computeRiskTrends(await loadSnapshots(repoPath))`, both exported from
 * `@opencodehub/analysis` (the same pair `wiki.ts` consumes).
 *
 * Mirrors `packages/mcp/src/tools/risk-trends.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 *
 * A mandatory `snapshotsFn?` test seam (default `loadSnapshots`) lets tests
 * supply the snapshot array directly so they never have to seed a real
 * `.codehub/history` directory.
 */

import { resolve } from "node:path";
import { computeRiskTrends, loadSnapshots, type RiskSnapshot } from "@opencodehub/analysis";
import { readRegistry } from "../registry.js";

export interface RiskTrendsOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  /**
   * Test seam — load snapshots for a repo path. Defaults to the real
   * `loadSnapshots` reader. Tests inject a fake so they never seed a real
   * `.codehub/history` directory on disk.
   */
  readonly snapshotsFn?: (repoPath: string) => Promise<readonly RiskSnapshot[]>;
}

export async function runRiskTrends(opts: RiskTrendsOptions = {}): Promise<void> {
  const repoPath = await resolveRepoPath(opts);
  const load = opts.snapshotsFn ?? loadSnapshots;
  const snapshots = await load(repoPath);
  const trends = computeRiskTrends(snapshots);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          overall_trend: trends.overallTrend,
          snapshot_count: trends.snapshotCount,
          communities: trends.communities,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.warn(`risk-trends: overall=${trends.overallTrend} (${trends.snapshotCount} snapshots).`);
  const ids = Object.keys(trends.communities).sort();
  if (ids.length === 0) {
    console.log("(no community trends yet — run `codehub analyze` a few times to build history)");
    return;
  }
  for (const id of ids.slice(0, 30)) {
    const entry = trends.communities[id];
    if (entry === undefined) continue;
    console.log(
      `- ${id}: ${entry.trend} (current=${entry.currentRisk.toFixed(3)}, 30d=${entry.projectedRisk30d.toFixed(3)})`,
    );
  }
  if (ids.length > 30) console.log(`… ${ids.length - 30} more communities`);
}

/**
 * Resolve the repo path from `--repo <name>` (registry lookup, falling back
 * to a raw path) or the current working directory. Mirrors the resolution in
 * `open-store.ts` but without opening the graph, since risk-trends is a
 * filesystem read.
 */
async function resolveRepoPath(opts: RiskTrendsOptions): Promise<string> {
  if (opts.repo !== undefined) {
    const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
    const registry = await readRegistry(registryOpts);
    const hit = registry[opts.repo];
    if (hit) return resolve(hit.path);
    return resolve(opts.repo);
  }
  return resolve(process.cwd());
}
