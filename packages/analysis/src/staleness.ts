/**
 * Compute whether the on-disk index is stale relative to the current git
 * HEAD. Strictly fail-open: a directory that isn't a git repo, a missing
 * `git` binary, or a `lastIndexedCommit` that no longer exists all resolve
 * to "not stale, 0 behind" so callers never error out of a read path.
 */

import { gitRevListCount, gitRevParseHead } from "./git.js";
import type { StalenessResult } from "./types.js";

export async function computeStaleness(
  repoPath: string,
  lastIndexedCommit: string | undefined,
): Promise<StalenessResult> {
  const currentCommit = await gitRevParseHead(repoPath);
  if (currentCommit === undefined) {
    return { isStale: false, commitsBehind: 0 };
  }

  if (lastIndexedCommit === undefined) {
    return {
      isStale: false,
      commitsBehind: 0,
      currentCommit,
    };
  }

  if (lastIndexedCommit === currentCommit) {
    return {
      isStale: false,
      commitsBehind: 0,
      lastIndexedCommit,
      currentCommit,
    };
  }

  const behind = await gitRevListCount(repoPath, `${lastIndexedCommit}..HEAD`);
  if (behind === undefined) {
    // Couldn't resolve the range — most likely the recorded commit was
    // garbage-collected or lives on a pruned branch. Surface that as
    // stale with an actionable hint rather than hiding it.
    return {
      isStale: true,
      commitsBehind: 0,
      lastIndexedCommit,
      currentCommit,
      hint: "Unable to compare HEAD with the last indexed commit. Run `codehub analyze --force` to reindex.",
    };
  }

  if (behind === 0) {
    return {
      isStale: false,
      commitsBehind: 0,
      lastIndexedCommit,
      currentCommit,
    };
  }

  return {
    isStale: true,
    commitsBehind: behind,
    lastIndexedCommit,
    currentCommit,
    hint: `Index is ${behind} commit${behind === 1 ? "" : "s"} behind HEAD. Run \`codehub analyze --force\` to reindex.`,
  };
}
