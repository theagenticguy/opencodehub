/**
 * Standard filesystem locations for OpenCodeHub persistent state.
 *
 * These helpers are pure — they never touch the filesystem — so they are
 * trivially testable. Resolution rules:
 *   - Per-repo: `<repo>/.codehub/` holds the graph + temporal artifacts
 *     plus the meta sidecar. The exact filenames depend on the backend
 *     (see {@link describeArtifacts}).
 *   - Global : `~/.codehub/registry.json` holds the cross-repo registry.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { BackendKind } from "./interface.js";

export const META_DIR_NAME = ".codehub";
export const META_FILE_NAME = "meta.json";
export const REGISTRY_FILE_NAME = "registry.json";

/**
 * Canonical artifact filenames per backend. Used by:
 *
 *   - The `openStore` factory to construct the graph + temporal file
 *     paths from a single `<dir>/.codehub/` parent.
 *   - The `codehub list` indexed-status probe to decide whether a repo
 *     has any backend's artifact on disk.
 *   - The MCP error envelope to enumerate all candidate paths in the
 *     "store unreadable" message.
 *
 * Two-store backends (e.g. `lbug`) split the graph and temporal views
 * into siblings:
 *   - `graphFile`    → `graph.lbug` (graph-db engine owns this file)
 *   - `temporalFile` → `temporal.duckdb` (DuckDB sibling for time series)
 *
 * Single-store backends (`duck`) collapse to one file used as both the
 * graph and temporal view (one connection serves both).
 *
 * `schemaName` is the namespace used inside the graph artifact when the
 * backend supports schemas; for both `duck` and `lbug` we emit into the
 * default `main` schema.
 */
export function describeArtifacts(backend: BackendKind): {
  readonly graphFile: string;
  readonly temporalFile: string;
  readonly schemaName: string;
} {
  if (backend === "duck") {
    return { graphFile: "graph.duckdb", temporalFile: "graph.duckdb", schemaName: "main" };
  }
  if (backend === "lbug") {
    return { graphFile: "graph.lbug", temporalFile: "temporal.duckdb", schemaName: "main" };
  }
  // Community-adapter backends (`age`, `memgraph`, `neo4j`, `neptune`)
  // declare their on-disk layout via separate path resolution; the
  // generic fallback derives the graph filename from the backend id and
  // pairs it with a sibling DuckDB temporal file.
  return { graphFile: `graph.${backend}`, temporalFile: "temporal.duckdb", schemaName: "main" };
}

/** Resolve the `<repo>/.codehub` directory (repo path may be relative). */
export function resolveRepoMetaDir(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME);
}

/**
 * Resolve the legacy DuckDB graph artifact path
 * (`<repo>/.codehub/graph.duckdb`). Retained as the canonical entry
 * point for callers that pass a single path into the `openStore`
 * factory; the factory rewrites the filename when the resolved backend
 * is not `duck`. New callers should prefer {@link describeArtifacts}
 * combined with {@link resolveRepoMetaDir} when they need a specific
 * backend's artifact path.
 */
export function resolveDbPath(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME, describeArtifacts("duck").graphFile);
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
