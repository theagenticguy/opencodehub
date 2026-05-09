/**
 * Resolve a repo path — from `--repo <name>` if given, else from the CWD —
 * and open a read-only `Store` (composed graph + temporal). Used by
 * `query`, `context`, `impact`, `sql`, and `detect-changes`.
 *
 * Returns the canonical {@link Store} envelope from `@opencodehub/storage`
 * so callers can route graph-tier queries through `store.graph` and
 * temporal-tier queries (cochanges, summaries, `--sql` escape hatch)
 * through `store.temporal`. Backend selection follows the standard
 * `openStore` resolution (env-driven `CODEHUB_STORE`, defaulting to
 * `"duck"` until AC-A-9 flips the default).
 */

import { resolve } from "node:path";
import { openStore, resolveDbPath, type Store } from "@opencodehub/storage";
import { readRegistry } from "../registry.js";

export interface OpenStoreOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly readOnly?: boolean;
  readonly backend?: "auto" | "duck" | "lbug";
}

export interface OpenStoreResult {
  readonly repoPath: string;
  readonly store: Store;
}

export async function openStoreForCommand(opts: OpenStoreOptions): Promise<OpenStoreResult> {
  const repoPath = await resolveRepoPath(opts);
  const dbPath = resolveDbPath(repoPath);
  const store = await openStore({
    path: dbPath,
    backend: opts.backend ?? "auto",
    readOnly: opts.readOnly ?? true,
  });
  // The legacy CLI entry point opened the DuckDB connection eagerly and
  // every command consumed an already-open store. The `openStore` factory
  // only constructs adapters; opening is the lifecycle owner's job. Keep
  // that contract by opening both views here so command handlers stay a
  // simple try/finally pair around the work.
  await store.graph.open();
  if (store.graphFile !== store.temporalFile) {
    await store.temporal.open();
  }
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
