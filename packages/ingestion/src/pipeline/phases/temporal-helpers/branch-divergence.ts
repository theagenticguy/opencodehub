/**
 * Branch divergence — counts `ahead` and `behind` commits relative to the
 * configured base branch, plus the list of files uniquely touched by the
 * ahead commits.
 *
 * Uses two git subprocesses per branch:
 *   1. `git rev-list --left-right --count <base>...<ref>` → tab-separated
 *      pair "behind<TAB>ahead".
 *   2. `git log <base>..<ref> --name-only --format=` → newline-separated
 *      file paths, deduplicated in first-seen order.
 *
 * The caller supplies the base branch name (typically `main`) and the list
 * of candidate head refs. The function fails open: any git error leaves the
 * affected branch's entry absent from the returned map.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_OVERLAP_FILES = 100;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024; // 64 MB

export interface BranchDivergenceEntry {
  readonly ahead: number;
  readonly behind: number;
  readonly overlapFiles: readonly string[];
}

export interface BranchDivergenceResult {
  readonly entries: ReadonlyMap<string, BranchDivergenceEntry>;
}

export interface BranchDivergenceOptions {
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly branches: readonly string[];
  readonly maxOverlapFiles?: number;
}

/**
 * List local branches via `git for-each-ref refs/heads/`. Returns short ref
 * names sorted lexicographically so downstream iteration is deterministic.
 */
export async function listLocalBranches(repoPath: string): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      { cwd: repoPath, maxBuffer: DEFAULT_MAX_BUFFER },
    );
    const names = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return [...names].sort();
  } catch {
    return [];
  }
}

/**
 * Compute divergence for each branch relative to `baseBranch`.
 *
 * Branches equal to the base or failing to resolve are omitted from the
 * result map.
 */
export async function computeBranchDivergence(
  opts: BranchDivergenceOptions,
): Promise<BranchDivergenceResult> {
  const { repoPath, baseBranch, branches } = opts;
  const overlapCap = opts.maxOverlapFiles ?? DEFAULT_MAX_OVERLAP_FILES;
  const entries = new Map<string, BranchDivergenceEntry>();
  for (const ref of branches) {
    if (ref === baseBranch) continue;
    const count = await revListLeftRight(repoPath, baseBranch, ref);
    if (count === undefined) continue;
    const overlap = await aheadFiles(repoPath, baseBranch, ref, overlapCap);
    entries.set(ref, { ahead: count.ahead, behind: count.behind, overlapFiles: overlap });
  }
  return { entries };
}

async function revListLeftRight(
  repoPath: string,
  base: string,
  ref: string,
): Promise<{ ahead: number; behind: number } | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--left-right", "--count", `${base}...${ref}`],
      { cwd: repoPath, maxBuffer: DEFAULT_MAX_BUFFER },
    );
    const trimmed = stdout.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 2) return undefined;
    const behind = Number(parts[0]);
    const ahead = Number(parts[1]);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return undefined;
    return { ahead, behind };
  } catch {
    return undefined;
  }
}

async function aheadFiles(
  repoPath: string,
  base: string,
  ref: string,
  cap: number,
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `${base}..${ref}`, "--name-only", "--format="],
      { cwd: repoPath, maxBuffer: DEFAULT_MAX_BUFFER },
    );
    const seen = new Set<string>();
    for (const line of stdout.split("\n")) {
      const path = line.trim();
      if (path.length === 0) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      if (seen.size >= cap) break;
    }
    return [...seen].sort();
  } catch {
    return [];
  }
}
