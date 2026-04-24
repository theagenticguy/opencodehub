/**
 * Process-grouping no-op.
 *
 * Real process detection (entrypoint walks, PROCESS_STEP edges) runs in the
 * processes phase. This module is the no-op grouping used when the caller
 * has not wired in PROCESS_STEP lookup yet: every hit is returned in a
 * single `"ungrouped"` bucket, so the CLI and MCP server can call this
 * function today without any conditional branches.
 */

import type { SymbolHit } from "./types.js";

export interface ProcessBucket {
  readonly process: string;
  readonly hits: readonly SymbolHit[];
}

/**
 * Group hits by the process they participate in. MVP stub: every hit gets
 * its own `"ungrouped"` bucket in input order.
 */
export function groupByProcess(hits: readonly SymbolHit[]): readonly ProcessBucket[] {
  const out: ProcessBucket[] = [];
  for (const hit of hits) {
    out.push({ process: "ungrouped", hits: [hit] });
  }
  return out;
}
