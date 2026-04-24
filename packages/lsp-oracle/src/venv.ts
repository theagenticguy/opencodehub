/**
 * Python venv detection — mirrors what the pyright-oracle spike did.
 *
 * pyright can run without a pythonPath, but it only sees its bundled
 * stdlib knowledge. For a workspace with third-party deps (boto3,
 * pydantic, etc.) we want pyright to crawl the project's venv so
 * cross-module references resolve correctly. We probe the two conventional
 * venv paths and return the one that exists.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export interface VenvDetection {
  readonly pythonPath: string | null;
  readonly mode: "venv" | "bundled-stdlib";
  readonly label: string;
}

/**
 * Look for a Python executable at `${workspaceRoot}/.venv/bin/python` or
 * `${workspaceRoot}/venv/bin/python`. Returns the first match, or null
 * plus a `"bundled-stdlib"` mode flag if neither exists.
 *
 * Downstream callers should record `mode` on edge provenance so consumers
 * know whether the oracle had third-party visibility.
 */
export function detectPythonEnv(workspaceRoot: string): VenvDetection {
  const candidates = [
    path.join(workspaceRoot, ".venv", "bin", "python"),
    path.join(workspaceRoot, "venv", "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        pythonPath: candidate,
        mode: "venv",
        label: candidate,
      };
    }
  }
  return {
    pythonPath: null,
    mode: "bundled-stdlib",
    label: "none — bundled stdlib only",
  };
}
