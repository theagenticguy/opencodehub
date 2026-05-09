/**
 * Backend-aware check for whether a repo has been indexed by `codehub
 * analyze`. Replaces hard-coded `existsSync('.codehub/graph.duckdb')` probes
 * that pre-date the M3 graph-db backend split.
 *
 * Truthy when ANY of the following exist under `<repoPath>/.codehub`:
 *   - `meta.json` — written by every backend after a successful analyze
 *     (preferred signal — explicit and backend-agnostic).
 *   - The `graphFile` for any in-tree backend (currently `duck` →
 *     `graph.duckdb`, `lbug` → `graph.lbug`). Filenames come from the
 *     storage `describeArtifacts` helper so two-store deployments share a
 *     single source of truth.
 *
 * Returns a plain boolean — UI surfaces (e.g. `codehub list`) want to
 * render a single column without leaking which backend produced the
 * index. Pair with the typed labels in `is-indexed.label` if you need
 * the specific backend; today every consumer just needs the boolean.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeArtifacts } from "@opencodehub/storage";

/** Backends whose artifacts the `codehub` CLI knows how to produce in-tree. */
const IN_TREE_BACKENDS = ["duck", "lbug"] as const;

export function codehubIsIndexed(repoPath: string): boolean {
  const codehubDir = join(repoPath, ".codehub");
  if (existsSync(join(codehubDir, "meta.json"))) return true;
  for (const backend of IN_TREE_BACKENDS) {
    const { graphFile } = describeArtifacts(backend);
    if (existsSync(join(codehubDir, graphFile))) return true;
  }
  return false;
}
