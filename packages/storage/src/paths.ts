/**
 * Standard filesystem locations for OpenCodeHub persistent state.
 *
 * These helpers are pure — they never touch the filesystem — so they are
 * trivially testable. Resolution rules:
 *   - Per-repo: `<repo>/.codehub/` holds the single `store.sqlite` index
 *     (graph nodes/edges, embeddings, and the temporal cochange +
 *     symbol-summary tables — ADR 0019) plus the meta sidecar `meta.json`.
 *   - Global : `~/.codehub/registry.json` holds the cross-repo registry.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export const META_DIR_NAME = ".codehub";
export const META_FILE_NAME = "meta.json";
export const REGISTRY_FILE_NAME = "registry.json";

/**
 * Canonical artifact filename. Used by:
 *
 *   - The `codehub list` indexed-status probe to decide whether a repo
 *     has any artifact on disk.
 *   - The MCP error envelope to name the candidate path in the
 *     "store unreadable" message.
 *
 * Post-ADR 0019 the entire index is one `<repo>/.codehub/store.sqlite`
 * file (node:sqlite, WAL) — there is no separate graph / temporal file.
 * `graphFile` and `temporalFile` both resolve to that single store so the
 * historical two-field shape keeps callers (and the conformance harness)
 * compiling without a churned signature. `schemaName` stays `main` — the
 * default SQLite schema the tables live in.
 */
export function describeArtifacts(): {
  readonly graphFile: string;
  readonly temporalFile: string;
  readonly schemaName: string;
} {
  return { graphFile: "store.sqlite", temporalFile: "store.sqlite", schemaName: "main" };
}

/** Resolve the `<repo>/.codehub` directory (repo path may be relative). */
export function resolveRepoMetaDir(repoPath: string): string {
  return resolve(repoPath, META_DIR_NAME);
}

/**
 * Resolve the canonical store path (`<repo>/.codehub/store.sqlite`).
 * Post-ADR 0019 this single file is the whole index; {@link openStore}
 * takes this path and serves both the graph and temporal views from it.
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
