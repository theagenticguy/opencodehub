/**
 * Tests for `codehub risk-trends` CLI command.
 *
 * The command reads snapshot history and runs `computeRiskTrends`. The
 * mandatory `snapshotsFn` test seam supplies the snapshots directly so the
 * test never seeds a real `.codehub/history` directory on disk.
 *
 * Covers:
 *   - Empty history → overall=stable, snapshot_count=0.
 *   - A rising two-snapshot history → a non-stable community trend in JSON.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RiskSnapshot } from "@opencodehub/analysis";
import { runRiskTrends } from "./risk-trends.js";

function snapshot(ts: string, c1Risk: number): RiskSnapshot {
  return {
    timestamp: ts,
    commit: ts,
    perCommunityRisk: { c1: { risk: c1Risk, nodeCount: 5 } },
    totalNodeCount: 5,
    totalEdgeCount: 4,
    findingsSeverityHistogram: { error: 0, warning: 0, note: 0 },
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

test("risk-trends --json on empty history → stable, count 0", async () => {
  const out = await captureStdout(async () => {
    await runRiskTrends({
      repo: "/tmp/fake-repo-no-history",
      json: true,
      snapshotsFn: async () => [],
    });
  });
  const parsed = JSON.parse(out) as { overall_trend: string; snapshot_count: number };
  assert.equal(parsed.overall_trend, "stable");
  assert.equal(parsed.snapshot_count, 0);
});

test("risk-trends --json surfaces per-community trend from injected snapshots", async () => {
  const snaps: readonly RiskSnapshot[] = [
    snapshot("2026-01-01T00:00:00.000Z", 0.1),
    snapshot("2026-02-01T00:00:00.000Z", 0.5),
    snapshot("2026-03-01T00:00:00.000Z", 0.9),
  ];
  const out = await captureStdout(async () => {
    await runRiskTrends({
      repo: "/tmp/fake-repo",
      json: true,
      snapshotsFn: async () => snaps,
    });
  });
  const parsed = JSON.parse(out) as {
    snapshot_count: number;
    communities: Record<string, { trend: string; currentRisk: number }>;
  };
  assert.equal(parsed.snapshot_count, 3);
  assert.ok(parsed.communities["c1"], "c1 community trend present");
  assert.ok(typeof parsed.communities["c1"]?.trend === "string");
});
