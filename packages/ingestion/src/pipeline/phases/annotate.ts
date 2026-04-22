/**
 * Annotate phase — terminal step that computes final graph statistics for
 * the orchestrator. Does not touch storage; the CLI in Wave 8b is
 * responsible for persisting the resulting envelope.
 *
 * Outputs:
 *   - `schemaVersion` (pinned by `@opencodehub/core-types`)
 *   - `currentCommit` (captured by scan when not `skipGit`)
 *   - counts per NodeKind + RelationType
 *
 * No staleness decision is made here because the previous-run metadata is
 * owned by the storage package; we will thread it through in Wave 8b.
 */

import { SCHEMA_VERSION } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { COCHANGE_PHASE_NAME } from "./cochange.js";
import { PROCESSES_PHASE_NAME } from "./processes.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import { TEMPORAL_PHASE_NAME } from "./temporal.js";

export const ANNOTATE_PHASE_NAME = "annotate";

export interface AnnotateStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly byKind: Record<string, number>;
  readonly byRelation: Record<string, number>;
}

export interface AnnotateOutput {
  readonly schemaVersion: string;
  readonly currentCommit?: string;
  readonly stats: AnnotateStats;
}

export const annotatePhase: PipelinePhase<AnnotateOutput> = {
  name: ANNOTATE_PHASE_NAME,
  deps: [PROCESSES_PHASE_NAME, TEMPORAL_PHASE_NAME, COCHANGE_PHASE_NAME],
  async run(ctx) {
    return runAnnotate(ctx);
  },
};

function runAnnotate(ctx: PipelineContext): AnnotateOutput {
  const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;

  const byKind: Record<string, number> = {};
  for (const n of ctx.graph.nodes()) {
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  }
  const byRelation: Record<string, number> = {};
  for (const e of ctx.graph.edges()) {
    byRelation[e.type] = (byRelation[e.type] ?? 0) + 1;
  }
  // Canonicalise key order for byte-identical JSON serialisation if the
  // caller persists the output.
  const byKindSorted = sortRecord(byKind);
  const byRelationSorted = sortRecord(byRelation);

  const stats: AnnotateStats = {
    nodeCount: ctx.graph.nodeCount(),
    edgeCount: ctx.graph.edgeCount(),
    byKind: byKindSorted,
    byRelation: byRelationSorted,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    ...(scan?.gitHead !== undefined ? { currentCommit: scan.gitHead } : {}),
    stats,
  };
}

function sortRecord(rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(rec).sort()) {
    out[key] = rec[key] ?? 0;
  }
  return out;
}
