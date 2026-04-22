/**
 * Resolve a repo path — from `--repo <name>` if given, else from the CWD —
 * and open the DuckDB store in read-only mode. Used by `query`, `context`,
 * `impact`, and `sql`.
 */

import { resolve } from "node:path";
import { DuckDbStore, resolveDbPath } from "@opencodehub/storage";
import { readRegistry } from "../registry.js";

export interface OpenStoreOptions {
  readonly repo?: string;
  readonly home?: string;
}

export interface OpenStoreResult {
  readonly repoPath: string;
  readonly store: DuckDbStore;
}

export async function openStoreForCommand(opts: OpenStoreOptions): Promise<OpenStoreResult> {
  const repoPath = await resolveRepoPath(opts);
  const store = new DuckDbStore(resolveDbPath(repoPath), { readOnly: true });
  await store.open();
  return { repoPath, store };
}

async function resolveRepoPath(opts: OpenStoreOptions): Promise<string> {
  if (opts.repo !== undefined) {
    const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
    const registry = await readRegistry(registryOpts);
    const hit = registry[opts.repo];
    if (hit) return resolve(hit.path);
    // Accept a raw path too.
    return resolve(opts.repo);
  }
  return resolve(process.cwd());
}
