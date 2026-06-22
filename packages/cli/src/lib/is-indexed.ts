/**
 * Check whether a repo has been indexed by `codehub analyze`. Truthy when
 * either signal exists under `<repoPath>/.codehub`:
 *
 *   - `meta.json` — written by every successful analyze run.
 *   - `store.sqlite` — the single-file index (ADR 0019; the only backend).
 *
 * Returns a plain boolean — UI surfaces (e.g. `codehub list`) want a single
 * column rendering.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeArtifacts } from "@opencodehub/storage";

export function codehubIsIndexed(repoPath: string): boolean {
  const codehubDir = join(repoPath, ".codehub");
  if (existsSync(join(codehubDir, "meta.json"))) return true;
  const { graphFile } = describeArtifacts();
  return existsSync(join(codehubDir, graphFile));
}
