/**
 * Standard filesystem locations for OpenCodeHub persistent state.
 *
 * These helpers are pure — they never touch the filesystem — so they are
 * trivially testable. Resolution rules:
 *   - Per-repo: `<repo>/.codehub/` holds the DuckDB database + meta sidecar.
 *   - Global : `~/.codehub/registry.json` holds the cross-repo registry.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export const META_DIR_NAME = ".codehub";
export const DB_FILE_NAME = "graph.duckdb";
export const META_FILE_NAME = "meta.json";
export const REGISTRY_FILE_NAME = "registry.json";

/** Resolve the `<repo>/.codehub` directory (repo path may be relative). */
export function resolveRepoMetaDir(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME);
}

/** Resolve the `<repo>/.codehub/graph.duckdb` database path. */
export function resolveDbPath(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME, DB_FILE_NAME);
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
