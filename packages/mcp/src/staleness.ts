/**
 * Thin wrappers around `@opencodehub/analysis.computeStaleness`.
 *
 * Tool handlers want a simple `Promise<StalenessEnvelope | undefined>`;
 * the analysis package returns a slightly wider shape. We adapt and, as
 * a cheap optimization, fall back to a meta-only envelope when the
 * caller explicitly asks to skip the git probe (resources/read, for
 * example, fires many times and should not shell out each time).
 */

import { computeStaleness } from "@opencodehub/analysis";
import type { StalenessEnvelope } from "@opencodehub/core-types";
import type { StoreMeta } from "@opencodehub/storage";

export async function stalenessFor(
  repoPath: string,
  meta: StoreMeta | undefined,
): Promise<StalenessEnvelope | undefined> {
  if (!meta) return undefined;
  const result = await computeStaleness(repoPath, meta.lastCommit);
  const envelope: StalenessEnvelope = {
    isStale: result.isStale,
    commitsBehind: result.commitsBehind,
    ...(result.hint !== undefined ? { hint: result.hint } : {}),
    ...(result.lastIndexedCommit !== undefined
      ? { lastIndexedCommit: result.lastIndexedCommit }
      : {}),
    ...(result.currentCommit !== undefined ? { currentCommit: result.currentCommit } : {}),
  };
  return envelope;
}

/**
 * Non-async fallback used in hot paths where we want to skip the git
 * probe. Emits a 0-behind envelope carrying just the last-indexed commit
 * from the sidecar.
 */
export function stalenessFromMeta(meta: StoreMeta | undefined): StalenessEnvelope | undefined {
  if (!meta) return undefined;
  return {
    isStale: false,
    commitsBehind: 0,
    ...(meta.lastCommit !== undefined ? { lastIndexedCommit: meta.lastCommit } : {}),
  };
}
