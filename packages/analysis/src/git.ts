/**
 * Narrow `git` helpers used by detect-changes and staleness.
 *
 * We shell out via `child_process.execFile` (no shell interpolation, argv
 * passed as array) and fail open on any error: non-zero exit, missing git,
 * or a non-repo working directory all yield `undefined` / empty collections
 * so downstream consumers can treat "not a git repo" the same as "no
 * changes". A stricter mode would surface the error, but this package is
 * consumed by read-only tools that should never block on git misconfig.
 */

import { execFile } from "node:child_process";
import type { ChangedHunk } from "./types.js";

interface RunResult {
  readonly stdout: string;
  readonly code: number;
}

function runGit(cwd: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const code =
          typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (err as NodeJS.ErrnoException & { code: number }).code
            : 1;
        resolve({ stdout: String(stdout ?? ""), code });
        return;
      }
      resolve({ stdout: String(stdout), code: 0 });
    });
  });
}

/** Return a list of changed file paths (relative to repo root). */
export async function gitDiffNames(
  repoPath: string,
  args: readonly string[],
): Promise<readonly string[]> {
  const { stdout, code } = await runGit(repoPath, ["diff", "--name-only", ...args]);
  if (code !== 0) return [];
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse `git diff -U0 ...` output into a map of filePath → hunk ranges.
 * Only the new-side coordinates are retained — rename/impact consumers want
 * to know which lines in the current working copy were touched, not the
 * pre-image line numbers.
 */
export async function gitDiffHunks(
  repoPath: string,
  args: readonly string[],
): Promise<ReadonlyMap<string, readonly ChangedHunk[]>> {
  const { stdout, code } = await runGit(repoPath, ["diff", "-U0", ...args]);
  if (code !== 0) return new Map();
  return parseDiffHunks(stdout);
}

/**
 * Pure parser for `git diff -U0`. Exposed so tests can feed canned fixtures
 * without spawning git.
 */
export function parseDiffHunks(diff: string): ReadonlyMap<string, readonly ChangedHunk[]> {
  const out = new Map<string, ChangedHunk[]>();
  let currentFile: string | undefined;
  const lines = diff.split("\n");
  // Match the "+++ b/<path>" header. Handle the rare "+++ /dev/null" case
  // (file deleted) by clearing currentFile so subsequent hunks don't land
  // under a stale path.
  const plusPlus = /^\+\+\+\s+(?:b\/)?(.+)$/;
  // Hunk header: @@ -OLDSTART[,OLDCOUNT] +NEWSTART[,NEWCOUNT] @@
  const hunkRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
  for (const line of lines) {
    const headerMatch = plusPlus.exec(line);
    if (headerMatch) {
      const path = headerMatch[1];
      if (path && path !== "/dev/null") {
        currentFile = path;
        if (!out.has(path)) out.set(path, []);
      } else {
        currentFile = undefined;
      }
      continue;
    }
    const hunkMatch = hunkRe.exec(line);
    if (hunkMatch && currentFile) {
      const start = Number(hunkMatch[1]);
      const countRaw = hunkMatch[2];
      const count = countRaw === undefined ? 1 : Number(countRaw);
      // `-U0` emits count=0 for pure deletions; treat those as a zero-width
      // change at `start` so downstream overlap checks still see the line.
      const hunk: ChangedHunk = { start, count: count === 0 ? 0 : count };
      const bucket = out.get(currentFile);
      if (bucket) bucket.push(hunk);
    }
  }
  // Widen to readonly view.
  const result = new Map<string, readonly ChangedHunk[]>();
  for (const [k, v] of out) result.set(k, v);
  return result;
}

export async function gitRevParseHead(repoPath: string): Promise<string | undefined> {
  const { stdout, code } = await runGit(repoPath, ["rev-parse", "HEAD"]);
  if (code !== 0) return undefined;
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Count commits in `<range>`. Returns undefined if the range can't be
 * resolved (e.g. unknown commit, shallow clone, non-git directory).
 */
export async function gitRevListCount(
  repoPath: string,
  range: string,
): Promise<number | undefined> {
  const { stdout, code } = await runGit(repoPath, ["rev-list", "--count", range]);
  if (code !== 0) return undefined;
  const n = Number(stdout.trim());
  return Number.isFinite(n) ? n : undefined;
}
