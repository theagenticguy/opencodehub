/**
 * Risk snapshots + trend classification (Stream F.2).
 *
 * After every analyze run we persist a per-community snapshot to
 * `.codehub/history/risk_<ISOTS>.json`. Snapshots are JSON, UTC-timestamped,
 * and keep rotation to the last 100 files. The `computeRiskTrends` function
 * classifies each community's recent arc (accelerating/degrading/
 * improving/stable) and produces a 30-day linear extrapolation of risk.
 *
 * The trend algorithm is deliberately simple: we work over the delta sequence
 * between consecutive snapshots and apply the tier rules straight from PRD
 * §F.2. This keeps results explainable and deterministic.
 */

import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { CommunityNode, KnowledgeGraph } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import wfa from "write-file-atomic";

export const HISTORY_DIR = ".codehub/history";
const SNAPSHOT_PREFIX = "risk_";
const SNAPSHOT_SUFFIX = ".json";
export const SNAPSHOT_RETENTION = 100;

export type RiskTrend = "accelerating_risk" | "degrading" | "improving" | "stable";

export type FindingSeverity = "error" | "warning" | "note";

export interface CommunityRiskEntry {
  readonly risk: number;
  readonly nodeCount: number;
  readonly inferredLabel?: string;
}

export interface RiskSnapshot {
  readonly timestamp: string;
  readonly commit: string;
  readonly perCommunityRisk: Readonly<Record<string, CommunityRiskEntry>>;
  readonly totalNodeCount: number;
  readonly totalEdgeCount: number;
  readonly findingsSeverityHistogram: Readonly<Record<FindingSeverity, number>>;
}

export interface CommunityTrend {
  readonly trend: RiskTrend;
  readonly projectedRisk30d: number;
  readonly currentRisk: number;
}

export interface RiskTrendsResult {
  readonly communities: Readonly<Record<string, CommunityTrend>>;
  readonly overallTrend: RiskTrend;
  readonly snapshotCount: number;
}

/**
 * Build a {@link RiskSnapshot} from an in-memory {@link KnowledgeGraph}.
 * Used by the ingestion phase where no persistent store has been written
 * yet. The timestamp is supplied so callers can pin it for tests.
 */
export function buildRiskSnapshotFromGraph(
  graph: KnowledgeGraph,
  commit: string,
  nowIso: string = new Date().toISOString(),
): RiskSnapshot {
  const perCommunityRisk: Record<string, CommunityRiskEntry> = {};
  let totalNodeCount = 0;
  let totalEdgeCount = 0;
  const findingsSeverityHistogram: Record<FindingSeverity, number> = {
    error: 0,
    warning: 0,
    note: 0,
  };
  for (const node of graph.nodes()) {
    totalNodeCount += 1;
    if (node.kind === "Community") {
      const community = node as CommunityNode;
      const symbolCount = community.symbolCount ?? 0;
      const cohesion = community.cohesion ?? 0;
      perCommunityRisk[community.id] = {
        risk: computeCommunityRisk(symbolCount, cohesion),
        nodeCount: symbolCount,
        ...(community.inferredLabel !== undefined && community.inferredLabel.length > 0
          ? { inferredLabel: community.inferredLabel }
          : {}),
      };
    } else if (node.kind === "Finding") {
      const severity = (node as { severity?: string }).severity;
      if (severity === "error" || severity === "warning" || severity === "note") {
        findingsSeverityHistogram[severity] += 1;
      }
    }
  }
  for (const _ of graph.edges()) {
    totalEdgeCount += 1;
  }
  return {
    timestamp: nowIso,
    commit,
    perCommunityRisk,
    totalNodeCount,
    totalEdgeCount,
    findingsSeverityHistogram,
  };
}

/**
 * Build a {@link RiskSnapshot} from a persistent store. The timestamp is
 * supplied so callers can pin it for tests (and so it matches the filename
 * it's persisted under).
 */
export async function buildRiskSnapshot(
  store: IGraphStore,
  commit: string,
  nowIso: string = new Date().toISOString(),
): Promise<RiskSnapshot> {
  const perCommunityRisk: Record<string, CommunityRiskEntry> = {};

  // Community node rows. We use a left join to COUNT(MEMBER_OF) relations
  // incoming to each community for the member count.
  try {
    const rows = await store.query(
      `SELECT n.id AS id,
              n.inferred_label AS label,
              n.symbol_count AS symbol_count,
              n.cohesion AS cohesion
         FROM nodes n
        WHERE n.kind = 'Community'
        ORDER BY n.id`,
    );
    for (const row of rows) {
      const id = stringField(row, "id");
      if (id.length === 0) continue;
      const symbolCount = numberField(row, "symbol_count");
      const cohesion = numberField(row, "cohesion");
      // Heuristic risk: larger community with weaker cohesion is riskier.
      // Normalised so single-member communities land at zero.
      const risk = computeCommunityRisk(symbolCount, cohesion);
      const label = stringField(row, "label");
      perCommunityRisk[id] = {
        risk,
        nodeCount: symbolCount,
        ...(label.length > 0 ? { inferredLabel: label } : {}),
      };
    }
  } catch {
    // Community nodes are optional.
  }

  let totalNodeCount = 0;
  let totalEdgeCount = 0;
  try {
    const nodeRows = await store.query("SELECT COUNT(*) AS c FROM nodes");
    totalNodeCount = numberField(nodeRows[0] ?? {}, "c");
  } catch {
    totalNodeCount = 0;
  }
  try {
    const edgeRows = await store.query("SELECT COUNT(*) AS c FROM relations");
    totalEdgeCount = numberField(edgeRows[0] ?? {}, "c");
  } catch {
    totalEdgeCount = 0;
  }

  const findingsSeverityHistogram: Record<FindingSeverity, number> = {
    error: 0,
    warning: 0,
    note: 0,
  };
  try {
    const rows = await store.query(
      "SELECT severity, COUNT(*) AS c FROM nodes WHERE kind = 'Finding' GROUP BY severity",
    );
    for (const row of rows) {
      const sev = stringField(row, "severity");
      const count = numberField(row, "c");
      if (sev === "error" || sev === "warning" || sev === "note") {
        findingsSeverityHistogram[sev] = count;
      }
    }
  } catch {
    // no findings table.
  }

  return {
    timestamp: nowIso,
    commit,
    perCommunityRisk,
    totalNodeCount,
    totalEdgeCount,
    findingsSeverityHistogram,
  };
}

/** Build the filename for a snapshot taken at `iso`. */
export function snapshotFilename(iso: string): string {
  // Sanitise the timestamp into a filesystem-safe token: strip colons and
  // dots so the lexicographic order still matches chronological order.
  const safe = iso.replace(/[:.]/g, "").replace(/-/g, "").toUpperCase();
  return `${SNAPSHOT_PREFIX}${safe}${SNAPSHOT_SUFFIX}`;
}

/**
 * Persist a snapshot atomically; rotates out oldest files once the retention
 * cap is exceeded. Returns the absolute path written.
 */
export async function persistRiskSnapshot(
  repoPath: string,
  snapshot: RiskSnapshot,
): Promise<string> {
  const dir = path.join(repoPath, HISTORY_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, snapshotFilename(snapshot.timestamp));
  await wfa(file, JSON.stringify(snapshot, null, 2));
  await rotateSnapshots(dir, SNAPSHOT_RETENTION);
  return file;
}

/** Load all snapshots from the history directory, sorted chronologically. */
export async function loadSnapshots(repoPath: string): Promise<readonly RiskSnapshot[]> {
  const dir = path.join(repoPath, HISTORY_DIR);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX))
    .sort();
  const out: RiskSnapshot[] = [];
  for (const name of files) {
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRiskSnapshot(parsed)) out.push(parsed);
    } catch {
      // Skip malformed snapshots.
    }
  }
  return out;
}

/**
 * Classify trends over the supplied snapshots (chronological order).
 *
 * Rules:
 *   - 3+ consecutive snapshots show risk strictly increasing → `accelerating_risk`.
 *   - last 2 snapshots trend up (not enough for accelerating) → `degrading`.
 *   - last 2 snapshots trend down → `improving`.
 *   - otherwise → `stable`.
 *
 * The 30-day projection is a linear extrapolation over the last 5 snapshot
 * deltas. When fewer than 2 snapshots exist we return the current risk
 * unchanged.
 */
export function computeRiskTrends(snapshots: readonly RiskSnapshot[]): RiskTrendsResult {
  if (snapshots.length === 0) {
    return { communities: {}, overallTrend: "stable", snapshotCount: 0 };
  }
  const communitiesSet = new Set<string>();
  for (const snap of snapshots) {
    for (const id of Object.keys(snap.perCommunityRisk)) communitiesSet.add(id);
  }
  const communities: Record<string, CommunityTrend> = {};
  for (const id of [...communitiesSet].sort()) {
    const series: number[] = [];
    for (const snap of snapshots) {
      const entry = snap.perCommunityRisk[id];
      series.push(entry?.risk ?? 0);
    }
    const currentRisk = series[series.length - 1] ?? 0;
    const trend = classifyTrend(series);
    const projectedRisk30d = projectLinear(series);
    communities[id] = { trend, projectedRisk30d, currentRisk };
  }
  const overallTrend = classifyTrend(snapshots.map((snap) => sumRisk(snap.perCommunityRisk)));
  return { communities, overallTrend, snapshotCount: snapshots.length };
}

function sumRisk(perCommunity: Readonly<Record<string, CommunityRiskEntry>>): number {
  let total = 0;
  for (const entry of Object.values(perCommunity)) total += entry.risk;
  return total;
}

function classifyTrend(series: readonly number[]): RiskTrend {
  if (series.length < 2) return "stable";
  // Consecutive strictly-increasing run from the end.
  let risingStreak = 0;
  for (let i = series.length - 1; i > 0; i -= 1) {
    const cur = series[i] ?? 0;
    const prev = series[i - 1] ?? 0;
    if (cur > prev) risingStreak += 1;
    else break;
  }
  if (risingStreak >= 3) return "accelerating_risk";
  // Fallback: inspect the last two transitions.
  const last = series[series.length - 1] ?? 0;
  const prev = series[series.length - 2] ?? 0;
  if (risingStreak >= 2 || last > prev) return "degrading";
  if (last < prev) return "improving";
  return "stable";
}

function projectLinear(series: readonly number[]): number {
  if (series.length < 2) return series[series.length - 1] ?? 0;
  const window = series.slice(-5);
  const deltas: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const cur = window[i] ?? 0;
    const prev = window[i - 1] ?? 0;
    deltas.push(cur - prev);
  }
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const last = window[window.length - 1] ?? 0;
  const projected = last + avgDelta * 30;
  return Math.round(projected * 1000) / 1000;
}

function computeCommunityRisk(symbolCount: number, cohesion: number): number {
  // A scalar risk signal in [0, infinity). Larger communities with lower
  // cohesion score higher. Formula: max(0, symbolCount * (1 - clamp(cohesion))).
  const c = Number.isFinite(cohesion) ? cohesion : 0;
  const bounded = Math.max(0, Math.min(1, c));
  const weight = Math.max(0, symbolCount) * (1 - bounded);
  return Math.round(weight * 1000) / 1000;
}

function isRiskSnapshot(value: unknown): value is RiskSnapshot {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["timestamp"] === "string" &&
    typeof record["commit"] === "string" &&
    typeof record["perCommunityRisk"] === "object" &&
    record["perCommunityRisk"] !== null &&
    typeof record["totalNodeCount"] === "number" &&
    typeof record["totalEdgeCount"] === "number" &&
    typeof record["findingsSeverityHistogram"] === "object" &&
    record["findingsSeverityHistogram"] !== null
  );
}

async function rotateSnapshots(dir: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const files = entries
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX))
    .sort();
  if (files.length <= keep) return;
  const toDrop = files.slice(0, files.length - keep);
  await Promise.all(
    toDrop.map((name) =>
      unlink(path.join(dir, name)).catch(() => {
        /* best-effort */
      }),
    ),
  );
}

function stringField(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function numberField(row: Record<string, unknown>, field: string): number {
  const v = row[field];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
