/**
 * `codehub clean [path]` — delete the `.codehub/` directory for a repo, and
 * remove the registry entry.
 *
 * `--all` clears every repo listed in the registry, then truncates the
 * registry file.
 */

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRepoMetaDir } from "@opencodehub/storage";
import {
  clearRegistry,
  findRegistryEntryByPath,
  readRegistry,
  removeFromRegistry,
} from "../registry.js";

export interface CleanOptions {
  readonly all?: boolean;
  readonly home?: string;
}

export async function runClean(path: string, opts: CleanOptions = {}): Promise<void> {
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};

  if (opts.all) {
    const registry = await readRegistry(registryOpts);
    let count = 0;
    for (const entry of Object.values(registry)) {
      try {
        await rm(resolveRepoMetaDir(entry.path), { recursive: true, force: true });
        count += 1;
      } catch (err) {
        console.warn(`codehub clean: failed for ${entry.path}: ${(err as Error).message}`);
      }
    }
    await clearRegistry(registryOpts);
    console.warn(`codehub clean --all: removed ${count} index(es).`);
    return;
  }

  const repoPath = resolve(path);
  await rm(resolveRepoMetaDir(repoPath), { recursive: true, force: true });
  const entry = await findRegistryEntryByPath(repoPath, registryOpts);
  if (entry !== undefined) {
    await removeFromRegistry(entry.name, registryOpts);
  }
  console.warn(`codehub clean: removed index at ${repoPath}`);
}
