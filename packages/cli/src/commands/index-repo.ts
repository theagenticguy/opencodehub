/**
 * `codehub index [path...]` — register an existing `.codehub/` folder.
 *
 * Unlike `codehub analyze`, this command performs no ingestion. It reads
 * `<path>/.codehub/meta.json` and upserts a registry entry keyed by the repo
 * basename. Useful when a pre-built `.codehub/` directory is already present
 * (shared team index, restore from backup, CI artifact download, etc.).
 *
 * Flag semantics:
 *   --force           If `.codehub/meta.json` is missing but the path looks
 *                     indexable, stamp a minimal meta sidecar using
 *                     `git rev-parse HEAD` (when available) and register
 *                     with zero node/edge counts. Without `--force`, a
 *                     missing meta.json is a hard failure for that path.
 *   --allow-non-git   Skip the `.git/` presence check so folders that carry
 *                     only a `.codehub/` (e.g. synthetic fixtures) can still
 *                     be registered.
 *
 * Multi-path behavior:
 *   Every path is processed independently. A failure on one path sets
 *   `process.exitCode = 1` but does not abort the remaining paths; all
 *   successful paths are still upserted into the registry.
 */

import { access, mkdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { SCHEMA_VERSION } from "@opencodehub/core-types";
import { readStoreMeta, resolveRepoMetaDir, writeStoreMeta } from "@opencodehub/storage";
import { type RepoEntry, upsertRegistry } from "../registry.js";

export interface IndexRepoOptions {
  readonly force?: boolean;
  readonly allowNonGit?: boolean;
  /** Test hook: override the home dir used for the registry. */
  readonly home?: string;
  /** Test hook: override the git HEAD reader (pure, no spawn). */
  readonly readGitHead?: (repoPath: string) => Promise<string | undefined>;
}

export interface IndexRepoResult {
  readonly successCount: number;
  readonly failureCount: number;
  readonly entries: readonly RepoEntry[];
}

export async function runIndexRepo(
  paths: readonly string[],
  opts: IndexRepoOptions = {},
): Promise<IndexRepoResult> {
  const targets = paths.length === 0 ? [process.cwd()] : paths;
  const entries: RepoEntry[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (const rawPath of targets) {
    try {
      const entry = await indexOne(rawPath, opts);
      entries.push(entry);
      successCount += 1;
      console.warn(
        `codehub index: registered ${entry.name} at ${entry.path} ` +
          `(${entry.nodeCount} nodes, ${entry.edgeCount} edges)`,
      );
    } catch (err) {
      failureCount += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`codehub index: ${resolve(rawPath)}: ${message}`);
    }
  }

  if (failureCount > 0) {
    process.exitCode = 1;
  }

  return { successCount, failureCount, entries };
}

async function indexOne(rawPath: string, opts: IndexRepoOptions): Promise<RepoEntry> {
  const repoPath = resolve(rawPath);

  // Path must exist and be a directory.
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(repoPath);
  } catch {
    throw new Error("path does not exist");
  }
  if (!st.isDirectory()) {
    throw new Error("path is not a directory");
  }

  // `.git/` gate, unless explicitly bypassed.
  if (opts.allowNonGit !== true) {
    const gitDir = resolve(repoPath, ".git");
    try {
      await access(gitDir);
    } catch {
      throw new Error("not a git repository (use --allow-non-git to override)");
    }
  }

  const metaDir = resolveRepoMetaDir(repoPath);
  let meta = await readStoreMeta(repoPath);

  if (meta === undefined) {
    if (opts.force !== true) {
      throw new Error(
        ".codehub/meta.json not found (use --force to stamp a minimal stub, " +
          "or run `codehub analyze` to build the index)",
      );
    }
    // --force: stamp a minimal meta sidecar so the registry entry is coherent.
    // Node/edge counts are zero because we genuinely don't know them; consumers
    // (`codehub status`, MCP resources) treat that as "not yet analyzed".
    await mkdir(metaDir, { recursive: true });
    const readHead = opts.readGitHead ?? readGitHeadViaSpawn;
    const head = opts.allowNonGit === true ? undefined : await readHead(repoPath);
    meta = {
      schemaVersion: SCHEMA_VERSION,
      indexedAt: new Date().toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      ...(head !== undefined ? { lastCommit: head } : {}),
    };
    await writeStoreMeta(repoPath, meta);
  }

  const entry: RepoEntry = {
    name: basename(repoPath),
    path: repoPath,
    indexedAt: meta.indexedAt,
    nodeCount: meta.nodeCount,
    edgeCount: meta.edgeCount,
    ...(meta.lastCommit !== undefined ? { lastCommit: meta.lastCommit } : {}),
  };
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  await upsertRegistry(entry, registryOpts);
  return entry;
}

/**
 * Default git HEAD reader. Returns `undefined` when git is unavailable,
 * the directory is not a git repo, or HEAD cannot be resolved (detached
 * work trees on a fresh init with zero commits). Never throws.
 */
async function readGitHeadViaSpawn(repoPath: string): Promise<string | undefined> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveP) => {
    let stdout = "";
    let settled = false;
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolveP(undefined);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        const trimmed = stdout.trim();
        resolveP(trimmed.length > 0 ? trimmed : undefined);
      } else {
        resolveP(undefined);
      }
    });
  });
}
