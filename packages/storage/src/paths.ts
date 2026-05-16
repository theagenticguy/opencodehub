/**
 * Standard filesystem locations for OpenCodeHub persistent state.
 *
 * These helpers are pure — they never touch the filesystem — so they are
 * trivially testable. Resolution rules:
 *   - Per-repo: `<repo>/.codehub/` holds `graph.lbug` (graph artifact)
 *     and `temporal.duckdb` (cochange + symbol-summary sidecar) plus the
 *     meta sidecar `meta.json`.
 *   - Global : `~/.codehub/registry.json` holds the cross-repo registry.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export const META_DIR_NAME = ".codehub";
export const META_FILE_NAME = "meta.json";
export const REGISTRY_FILE_NAME = "registry.json";

/**
 * Canonical artifact filenames. Used by:
 *
 *   - The `openStore` factory to construct the graph + temporal file
 *     paths from a single `<dir>/.codehub/` parent.
 *   - The `codehub list` indexed-status probe to decide whether a repo
 *     has any artifact on disk.
 *   - The MCP error envelope to enumerate candidate paths in the
 *     "store unreadable" message.
 *
 * `schemaName` is the namespace used inside the graph artifact when the
 * backend supports schemas; lbug emits into the default `main` schema.
 */
export function describeArtifacts(): {
  readonly graphFile: string;
  readonly temporalFile: string;
  readonly schemaName: string;
} {
  return { graphFile: "graph.lbug", temporalFile: "temporal.duckdb", schemaName: "main" };
}

/** Resolve the `<repo>/.codehub` directory (repo path may be relative). */
export function resolveRepoMetaDir(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME);
}

/**
 * Resolve the canonical graph artifact path
 * (`<repo>/.codehub/graph.lbug`). The {@link openStore} factory derives
 * the sibling temporal artifact path automatically.
 */
export function resolveGraphPath(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME, describeArtifacts().graphFile);
}

/** Resolve the `<repo>/.codehub/meta.json` sidecar path. */
export function resolveMetaFilePath(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME, META_FILE_NAME);
}

/**
 * Resolve the global `~/.codehub/registry.json` path. Accepts an optional
 * homedir override for testing.
 */
export function resolveRegistryPath(home: string = homedir()): string {
  return resolve(home, META_DIR_NAME, REGISTRY_FILE_NAME);
}
