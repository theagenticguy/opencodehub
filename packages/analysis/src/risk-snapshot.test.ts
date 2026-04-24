/**
 * Risk-snapshot + trend-classification tests.
 *
 * Trend rules (PRD §F.2):
 *   - 3+ consecutive rising deltas → accelerating_risk.
 *   - last 2 trend up (but < 3 streak) → degrading.
 *   - last 2 trend down → improving.
 *   - else → stable.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeRiskTrends,
  loadSnapshots,
  persistRiskSnapshot,
  type RiskSnapshot,
  snapshotFilename,
} from "./risk-snapshot.js";

function snap(iso: string, communityRisks: Readonly<Record<string, number>>): RiskSnapshot {
  const perCommunityRisk: Record<string, { risk: number; nodeCount: number }> = {};
  for (const [k, r] of Object.entries(communityRisks)) {
    perCommunityRisk[k] = { risk: r, nodeCount: 1 };
  }
  return {
    timestamp: iso,
    commit: "deadbeef",
    perCommunityRisk,
    totalNodeCount: 10,
    totalEdgeCount: 5,
    findingsSeverityHistogram: { error: 0, warning: 0, note: 0 },
  };
}

test("computeRiskTrends: 4 ascending snapshots → accelerating_risk", () => {
  const series = [
    snap("2026-04-14T00:00:00Z", { "Community:a": 1 }),
    snap("2026-04-15T00:00:00Z", { "Community:a": 3 }),
    snap("2026-04-16T00:00:00Z", { "Community:a": 5 }),
    snap("2026-04-17T00:00:00Z", { "Community:a": 10 }),
  ];
  const trends = computeRiskTrends(series);
  assert.equal(trends.snapshotCount, 4);
  const a = trends.communities["Community:a"];
  assert.ok(a !== undefined);
  assert.equal(a.trend, "accelerating_risk");
  assert.ok(a.projectedRisk30d > a.currentRisk, "projection should be above current");
});

test("computeRiskTrends: one up tick → degrading (not accelerating)", () => {
  const series = [
    snap("2026-04-14T00:00:00Z", { "Community:a": 5 }),
    snap("2026-04-15T00:00:00Z", { "Community:a": 5 }),
    snap("2026-04-16T00:00:00Z", { "Community:a": 6 }),
  ];
  const trends = computeRiskTrends(series);
  const a = trends.communities["Community:a"];
  assert.ok(a !== undefined);
  assert.equal(a.trend, "degrading");
});

test("computeRiskTrends: last transition downward → improving", () => {
  const series = [
    snap("2026-04-14T00:00:00Z", { "Community:a": 6 }),
    snap("2026-04-15T00:00:00Z", { "Community:a": 4 }),
  ];
  const trends = computeRiskTrends(series);
  const a = trends.communities["Community:a"];
  assert.ok(a !== undefined);
  assert.equal(a.trend, "improving");
});

test("computeRiskTrends: flat → stable", () => {
  const series = [
    snap("2026-04-14T00:00:00Z", { "Community:a": 3 }),
    snap("2026-04-15T00:00:00Z", { "Community:a": 3 }),
  ];
  const trends = computeRiskTrends(series);
  const a = trends.communities["Community:a"];
  assert.ok(a !== undefined);
  assert.equal(a.trend, "stable");
});

test("snapshotFilename: chronological lexicographic order", () => {
  const a = snapshotFilename("2026-04-14T00:00:00Z");
  const b = snapshotFilename("2026-04-15T00:00:00Z");
  assert.ok(a < b, `${a} should sort before ${b}`);
});

test("persist + load round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codehub-risk-"));
  const s = snap("2026-04-16T12:00:00Z", { "Community:x": 2 });
  const file = await persistRiskSnapshot(dir, s);
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as RiskSnapshot;
  assert.equal(parsed.commit, "deadbeef");
  assert.equal(parsed.perCommunityRisk["Community:x"]?.risk, 2);
  const loaded = await loadSnapshots(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.commit, "deadbeef");
});

test("computeRiskTrends: empty input → stable + zero count", () => {
  const trends = computeRiskTrends([]);
  assert.equal(trends.snapshotCount, 0);
  assert.equal(trends.overallTrend, "stable");
  assert.deepEqual(trends.communities, {});
});
