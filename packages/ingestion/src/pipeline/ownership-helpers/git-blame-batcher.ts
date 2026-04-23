/**
 * Batch-blame helper for the ownership phase.
 *
 * `git` exposes no native multi-file blame command, so we parallelise per-file
 * `git blame --porcelain` invocations behind a bounded concurrency pool. Two
 * one-time set-up steps precede the fleet to minimise per-file cost:
 *   1. `git commit-graph write --reachable --changed-paths` materialises Bloom
 *      filters the blame engine uses to skip unrelated commits (2-6× speedup).
 *   2. We resolve parallelism to `max(2, availableParallelism - 2)` capped at
 *      32 — past that, I/O contention dominates.
 *
 * The porcelain format is deterministic line-by-line:
 *   <commit-sha> <orig-line> <final-line> [<group-size>]
 *   author <name>
 *   author-mail <<email>>
 *   ... other headers, terminated by a `\t<literal source line>` marker.
 *
 * A commit-sha repeats its headers only on the first line of each group, so a
 * cache of sha → author metadata short-circuits repeat headers. Output is a
 * deterministic `Map<relPath, LineOwner[]>`; the map preserves caller-provided
 * insertion order but each `LineOwner[]` is ordered by line number.
 */

import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 256 * 1024 * 1024; // 256 MB; large files still fit.
const BLAME_POOL_CAP = 32;

/**
 * Per-line attribution emitted by `git blame --porcelain`. The email is
 * lowercased at parse time for consistent hashing downstream.
 */
export interface LineOwner {
  readonly line: number;
  readonly email: string;
  readonly authorName: string;
  readonly sha: string;
}

export interface BatchBlameResult {
  /** Per-file line-by-line attribution map. */
  readonly byFile: ReadonlyMap<string, readonly LineOwner[]>;
  /** Number of `git blame` subprocesses spawned (excludes the commit-graph warm-up). */
  readonly subprocessCount: number;
  /** Number of files skipped because blame failed (never-committed, binary, etc). */
  readonly skippedCount: number;
}

export interface BatchBlameOptions {
  /** Override concurrency; defaults to `max(2, availableParallelism - 2)` capped at 32. */
  readonly concurrency?: number;
  /**
   * If `false`, skip the `git commit-graph write` warm-up. Useful when callers
   * know the graph is already current or when running against a shallow clone
   * where `--reachable` would fail.
   */
  readonly warmCommitGraph?: boolean;
  /** Optional sink for per-file warnings. */
  readonly onWarn?: (relPath: string, message: string) => void;
}

/**
 * Run `git blame --porcelain` against each `relPaths` entry in parallel and
 * return the aggregated attribution map.
 *
 * Determinism: outputs are inserted into the map in sorted `relPath` order
 * regardless of completion order, and each per-file `LineOwner[]` is sorted
 * by line number.
 */
export async function batchBlame(
  repoPath: string,
  relPaths: readonly string[],
  opts: BatchBlameOptions = {},
): Promise<BatchBlameResult> {
  if (relPaths.length === 0) {
    return { byFile: new Map(), subprocessCount: 0, skippedCount: 0 };
  }
  if (opts.warmCommitGraph !== false) {
    try {
      await execFileAsync("git", ["commit-graph", "write", "--reachable", "--changed-paths"], {
        cwd: repoPath,
        maxBuffer: GIT_MAX_BUFFER,
      });
    } catch {
      // Shallow clones, no commits, or missing bloom-filter support all
      // surface as non-zero exit here. Blame still works without the warm-up.
    }
  }

  const poolSize = resolvePoolSize(opts.concurrency);
  const sortedPaths = [...relPaths].sort();
  const results = new Map<string, LineOwner[]>();
  let subprocessCount = 0;
  let skippedCount = 0;

  const queue = [...sortedPaths];
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(poolSize, queue.length); i += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const relPath = queue.shift();
          if (relPath === undefined) return;
          try {
            const { stdout } = await execFileAsync("git", ["blame", "--porcelain", "--", relPath], {
              cwd: repoPath,
              maxBuffer: GIT_MAX_BUFFER,
              encoding: "utf8",
            });
            subprocessCount += 1;
            const lines = parsePorcelainBlame(stdout);
            if (lines.length > 0) {
              results.set(relPath, lines);
            } else {
              skippedCount += 1;
            }
          } catch (err) {
            subprocessCount += 1;
            skippedCount += 1;
            opts.onWarn?.(relPath, (err as Error).message);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  // Re-materialise the map in sorted path order so downstream iteration is
  // deterministic even if worker completion order was not.
  const ordered = new Map<string, LineOwner[]>();
  for (const relPath of sortedPaths) {
    const entry = results.get(relPath);
    if (entry !== undefined) ordered.set(relPath, entry);
  }
  return { byFile: ordered, subprocessCount, skippedCount };
}

function resolvePoolSize(overrideMaybe: number | undefined): number {
  if (overrideMaybe !== undefined) {
    const clamped = Math.floor(Math.max(1, Math.min(overrideMaybe, BLAME_POOL_CAP)));
    return clamped;
  }
  const cpus = availableParallelism();
  const target = Math.max(2, cpus - 2);
  return Math.min(target, BLAME_POOL_CAP);
}

/**
 * Parse `git blame --porcelain` output into per-line owners.
 *
 * The format groups consecutive lines attributed to the same commit; only the
 * first line of each group includes the `author` / `author-mail` headers. We
 * cache per-sha author metadata across groups so later groups can reuse the
 * first group's headers.
 */
export function parsePorcelainBlame(stdout: string): LineOwner[] {
  if (stdout.length === 0) return [];
  const out: LineOwner[] = [];
  const authorBySha = new Map<string, { name: string; email: string }>();
  const lines = stdout.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = lines[i] ?? "";
    i += 1;
    // Header line: `<sha> <origLine> <finalLine> [<groupSize>]`.
    const headerMatch = /^([0-9a-f]{7,40}) (\d+) (\d+)(?: (\d+))?$/.exec(header);
    if (headerMatch === null) continue;
    const sha = headerMatch[1] ?? "";
    // Position 3 is the final (post-move) line number — that's the blame
    // output we care about. Position 2 is the commit-time origin line.
    const finalLine = Number(headerMatch[3] ?? "0");
    if (!Number.isFinite(finalLine) || finalLine <= 0) continue;
    let currentName = authorBySha.get(sha)?.name ?? "";
    let currentEmail = authorBySha.get(sha)?.email ?? "";
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (line.startsWith("\t")) {
        // Tab-prefixed line is the source text of the current record.
        i += 1;
        break;
      }
      if (line.startsWith("author ")) {
        currentName = line.slice("author ".length);
      } else if (line.startsWith("author-mail ")) {
        const raw = line.slice("author-mail ".length).trim();
        currentEmail = normaliseEmail(raw);
      }
      i += 1;
    }
    if (sha.length > 0 && currentEmail.length > 0) {
      const cached = authorBySha.get(sha);
      if (cached === undefined) {
        authorBySha.set(sha, { name: currentName, email: currentEmail });
      }
      out.push({
        line: finalLine,
        email: currentEmail,
        authorName: currentName,
        sha,
      });
    }
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

function normaliseEmail(rawWithBrackets: string): string {
  const trimmed = rawWithBrackets.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim().toLowerCase();
  }
  return trimmed.toLowerCase();
}
