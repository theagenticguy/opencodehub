/**
 * `codehub status [path]` — show the recorded index state for a repo.
 *
 * Reads `<repo>/.codehub/meta.json` and prints schemaVersion, lastCommit,
 * node/edge counts, and a best-effort staleness envelope. Staleness is
 * computed by `@opencodehub/analysis` when available; otherwise we fall back
 * to a simple `lastCommit` / registry check.
 */

import { resolve } from "node:path";
import { readStoreMeta } from "@opencodehub/storage";
import { listGroups } from "../groups.js";
import { readRegistry } from "../registry.js";

export interface StatusOptions {
  readonly home?: string;
}

export async function runStatus(path: string, opts: StatusOptions = {}): Promise<void> {
  const repoPath = resolve(path);
  const meta = await readStoreMeta(repoPath);
  if (!meta) {
    console.warn(`No index found at ${repoPath}. Run \`codehub analyze\`.`);
    return;
  }

  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const registry = await readRegistry(registryOpts);
  const registryHit = Object.values(registry).find((e) => resolve(e.path) === repoPath);

  console.log(`path:           ${repoPath}`);
  console.log(`schemaVersion:  ${meta.schemaVersion}`);
  console.log(`indexedAt:      ${meta.indexedAt}`);
  console.log(`lastCommit:     ${meta.lastCommit ?? "-"}`);
  console.log(`nodes:          ${meta.nodeCount}`);
  console.log(`edges:          ${meta.edgeCount}`);
  if (registryHit === undefined) {
    console.log("registry:       missing — run `codehub analyze` to re-register");
  } else {
    console.log("registry:       ok");
  }

  // Surface every group the current repo belongs to, alphabetically.
  if (registryHit !== undefined) {
    const groups = await listGroups(registryOpts);
    const memberOf = groups
      .filter((g) => g.repos.some((r) => r.name === registryHit.name))
      .map((g) => g.name)
      .sort();
    console.log(`groups:         ${memberOf.length > 0 ? memberOf.join(", ") : "(none)"}`);
  }

  // Optional deeper staleness check via @opencodehub/analysis if wired.
  const staleness = await tryComputeStaleness(repoPath, meta.lastCommit);
  if (staleness !== undefined) {
    console.log(`stale:          ${staleness.isStale ? "yes" : "no"}`);
    if (staleness.hint) {
      console.log(`hint:           ${staleness.hint}`);
    }
  }
}

async function tryComputeStaleness(
  repoPath: string,
  lastCommit: string | undefined,
): Promise<{ isStale: boolean; hint?: string } | undefined> {
  try {
    const specifier = "@opencodehub/analysis";
    const mod = (await import(specifier)) as unknown as {
      computeStaleness?: (
        repoPath: string,
        lastCommit: string | undefined,
      ) => Promise<{ isStale: boolean; hint?: string } | undefined>;
    };
    if (typeof mod.computeStaleness === "function") {
      return await mod.computeStaleness(repoPath, lastCommit);
    }
  } catch {
    // Analysis package not built yet or export missing; fall through.
  }
  return undefined;
}
