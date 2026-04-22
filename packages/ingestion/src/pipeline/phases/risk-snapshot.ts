/**
 * Risk-snapshot phase (Stream F.2).
 *
 * Persists a per-community risk snapshot to
 * `.codehub/history/risk_<ISOTS>.json` after `annotate` has finalised the
 * community + finding counts. The snapshot captures the state of the graph
 * for trend analysis across successive analyze runs.
 *
 * Dependencies: `[annotate]` — we want the finished community + finding
 * node set.
 *
 * Determinism: snapshot filenames are derived from the run's wall-clock
 * timestamp; callers that want byte-stable output should inject a clock via
 * `options.riskSnapshotNow`. The snapshot itself is deterministic given a
 * pinned timestamp because both `perCommunityRisk` and the histogram keys
 * are sorted before serialisation.
 */

import { buildRiskSnapshotFromGraph, persistRiskSnapshot } from "@opencodehub/analysis";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { ANNOTATE_PHASE_NAME, type AnnotateOutput } from "./annotate.js";

export const RISK_SNAPSHOT_PHASE_NAME = "risk-snapshot" as const;

export interface RiskSnapshotOptions {
  /** When true, do not persist the snapshot. Default false (persist). */
  readonly riskSnapshotSkipPersist?: boolean;
  /** Override the timestamp used for the filename + snapshot field. */
  readonly riskSnapshotNow?: string;
}

export interface RiskSnapshotOutput {
  readonly filePath: string | null;
  readonly communityCount: number;
  readonly totalNodeCount: number;
  readonly totalEdgeCount: number;
  readonly persisted: boolean;
}

export const riskSnapshotPhase: PipelinePhase<RiskSnapshotOutput> = {
  name: RISK_SNAPSHOT_PHASE_NAME,
  deps: [ANNOTATE_PHASE_NAME],
  async run(ctx, deps): Promise<RiskSnapshotOutput> {
    return runRiskSnapshot(ctx, deps);
  },
};

async function runRiskSnapshot(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): Promise<RiskSnapshotOutput> {
  const annotate = deps.get(ANNOTATE_PHASE_NAME) as AnnotateOutput | undefined;
  const options = ctx.options as RiskSnapshotOptions & Record<string, unknown>;
  const nowIso = options.riskSnapshotNow ?? new Date().toISOString();
  const commit = annotate?.currentCommit ?? "unknown";
  const snapshot = buildRiskSnapshotFromGraph(ctx.graph, commit, nowIso);

  const communityCount = Object.keys(snapshot.perCommunityRisk).length;
  if (options.riskSnapshotSkipPersist === true) {
    return {
      filePath: null,
      communityCount,
      totalNodeCount: snapshot.totalNodeCount,
      totalEdgeCount: snapshot.totalEdgeCount,
      persisted: false,
    };
  }

  let filePath: string | null = null;
  try {
    filePath = await persistRiskSnapshot(ctx.repoPath, snapshot);
  } catch (err) {
    ctx.onProgress?.({
      phase: RISK_SNAPSHOT_PHASE_NAME,
      kind: "warn",
      message: `risk-snapshot: persist failed (${(err as Error).message})`,
    });
  }

  return {
    filePath,
    communityCount,
    totalNodeCount: snapshot.totalNodeCount,
    totalEdgeCount: snapshot.totalEdgeCount,
    persisted: filePath !== null,
  };
}
