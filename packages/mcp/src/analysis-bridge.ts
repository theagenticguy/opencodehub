/**
 * Bridge to `@opencodehub/analysis`.
 *
 * The analysis package landed alongside this wave with the `runImpact`,
 * `runRename`, `runDetectChanges`, and `computeStaleness` exports wired
 * through. We import them directly here and re-export the call surface
 * the tool handlers need. A slim inline-impact fallback remains as a
 * safety net for repos where analysis cannot resolve the target — e.g.
 * a bare node-id with no declaration row — so the `impact` tool always
 * returns something actionable.
 */

import {
  runDetectChanges as analysisRunDetectChanges,
  runImpact as analysisRunImpact,
  runRename as analysisRunRename,
  createNodeFs,
  type DetectChangesQuery,
  type DetectChangesResult,
  type FsAbstraction,
  type ImpactQuery,
  type ImpactResult,
  type RenameQuery,
  type RenameResult,
} from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";

export type {
  DetectChangesQuery,
  DetectChangesResult,
  ImpactQuery,
  ImpactResult,
  RenameEdit,
  RenameQuery,
  RenameResult,
} from "@opencodehub/analysis";

export async function callRunImpact(store: IGraphStore, q: ImpactQuery): Promise<ImpactResult> {
  return analysisRunImpact(store, q);
}

export async function callRunRename(
  store: IGraphStore,
  q: RenameQuery,
  repoRoot: string,
  fs?: FsAbstraction,
): Promise<RenameResult> {
  return analysisRunRename(store, q, fs ?? createNodeFs(), repoRoot);
}

export async function callRunDetectChanges(
  store: IGraphStore,
  q: DetectChangesQuery,
): Promise<DetectChangesResult> {
  return analysisRunDetectChanges(store, q);
}

/**
 * Graph-only impact fallback. Produces the same `ImpactResult` shape as
 * the analysis package but skips the name-to-id resolution step — useful
 * when the target is already a node id and the caller does not need
 * candidate disambiguation.
 */
export async function inlineImpact(store: IGraphStore, q: ImpactQuery): Promise<ImpactResult> {
  const maxDepth = q.maxDepth ?? 3;
  const minConfidence = q.minConfidence ?? 0.3;
  const direction =
    q.direction === "upstream" ? "up" : q.direction === "downstream" ? "down" : "both";
  const travArgs: {
    startId: string;
    direction: "up" | "down" | "both";
    maxDepth: number;
    minConfidence: number;
    relationTypes?: readonly string[];
  } = {
    startId: q.target,
    direction,
    maxDepth,
    minConfidence,
  };
  if (q.relationTypes && q.relationTypes.length > 0) {
    travArgs.relationTypes = q.relationTypes;
  }
  const results = await store.traverse(travArgs);

  const byDepthMap = new Map<number, Map<string, true>>();
  for (const r of results) {
    let bucket = byDepthMap.get(r.depth);
    if (!bucket) {
      bucket = new Map();
      byDepthMap.set(r.depth, bucket);
    }
    bucket.set(r.nodeId, true);
  }

  const depths = Array.from(byDepthMap.keys()).sort((a, b) => a - b);
  const byDepth = depths.map((depth) => {
    const bucket = byDepthMap.get(depth);
    const ids = bucket ? Array.from(bucket.keys()) : [];
    return {
      depth,
      nodes: ids.map((nodeId) => ({
        id: nodeId,
        name: nodeId,
        filePath: "",
        kind: "",
        viaRelation: "CALLS",
      })),
    };
  });

  const d1 = byDepthMap.get(1)?.size ?? 0;
  let risk: ImpactResult["risk"] = "LOW";
  if (d1 >= 20) risk = "CRITICAL";
  else if (d1 >= 8) risk = "HIGH";
  else if (d1 >= 3) risk = "MEDIUM";

  return {
    targetCandidates: [],
    byDepth,
    risk,
    totalAffected: results.length,
    ambiguous: false,
    affectedProcesses: [],
  };
}
