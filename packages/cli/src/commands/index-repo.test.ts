/**
 * Unit tests for `codehub index`.
 *
 * Covers:
 *   1. Path with a valid `.codehub/meta.json` is upserted into the registry.
 *   2. Missing meta.json fails without `--force`, succeeds with `--force`
 *      (and the forced path ends up with a stamped meta.json carrying HEAD).
 *   3. Non-git directory fails by default, succeeds with `--allow-non-git`.
 *   4. Multi-path run: one bad path flips the exit code but the remaining
 *      paths are still registered.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { readStoreMeta, writeStoreMeta } from "@opencodehub/storage";
import { readRegistry } from "../registry.js";
import { runIndexRepo } from "./index-repo.js";

async function scratchHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-cli-index-home-"));
}

async function makeGitRepo(parent: string, name: string): Promise<string> {
  const repoPath = resolve(parent, name);
  await mkdir(join(repoPath, ".git"), { recursive: true });
  return repoPath;
}

async function seedMeta(repoPath: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(resolve(repoPath, ".codehub"), { recursive: true });
  await writeStoreMeta(repoPath, {
    schemaVersion: "1.1.0",
    indexedAt: "2026-04-18T00:00:00Z",
    nodeCount: 42,
    edgeCount: 99,
    lastCommit: "deadbeef12345678deadbeef12345678deadbeef",
    ...overrides,
  });
}

function preserveExitCode(): () => void {
  const prev = process.exitCode;
  return () => {
    process.exitCode = prev;
  };
}

test("runIndexRepo: registers a path with .codehub/meta.json", async () => {
  const home = await scratchHome();
  const parent = await mkdtemp(join(tmpdir(), "och-cli-index-repo-"));
  const restore = preserveExitCode();
  try {
    const repo = await makeGitRepo(parent, "sample");
    await seedMeta(repo);

    const result = await runIndexRepo([repo], { home });
    assert.equal(result.successCount, 1);
    assert.equal(result.failureCount, 0);
    assert.equal(process.exitCode, undefined);

    const registry = await readRegistry({ home });
    const entry = registry["sample"];
    assert.ok(entry, "registry should contain the sample entry");
    assert.equal(entry.name, "sample");
    assert.equal(entry.path, repo);
    assert.equal(entry.nodeCount, 42);
    assert.equal(entry.edgeCount, 99);
    assert.equal(entry.lastCommit, "deadbeef12345678deadbeef12345678deadbeef");
    assert.equal(entry.indexedAt, "2026-04-18T00:00:00Z");
  } finally {
    restore();
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("runIndexRepo: missing meta.json fails without --force", async () => {
  const home = await scratchHome();
  const parent = await mkdtemp(join(tmpdir(), "och-cli-index-repo-"));
  const restore = preserveExitCode();
  try {
    const repo = await makeGitRepo(parent, "no-meta");

    const result = await runIndexRepo([repo], { home });
    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 1);
    assert.equal(process.exitCode, 1);

    const registry = await readRegistry({ home });
    assert.deepEqual(Object.keys(registry), []);
  } finally {
    restore();
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("runIndexRepo: --force stamps a minimal meta.json and registers", async () => {
  const home = await scratchHome();
  const parent = await mkdtemp(join(tmpdir(), "och-cli-index-repo-"));
  const restore = preserveExitCode();
  try {
    const repo = await makeGitRepo(parent, "forced");

    const result = await runIndexRepo([repo], {
      home,
      force: true,
      readGitHead: async () => "cafef00dcafef00dcafef00dcafef00dcafef00d",
    });
    assert.equal(result.successCount, 1);
    assert.equal(result.failureCount, 0);
    assert.equal(process.exitCode, undefined);

    // Meta sidecar was stamped with HEAD and zero counts.
    const meta = await readStoreMeta(repo);
    assert.ok(meta);
    assert.equal(meta.nodeCount, 0);
    assert.equal(meta.edgeCount, 0);
    assert.equal(meta.lastCommit, "cafef00dcafef00dcafef00dcafef00dcafef00d");

    const registry = await readRegistry({ home });
    assert.ok(registry["forced"]);
    assert.equal(registry["forced"]?.lastCommit, "cafef00dcafef00dcafef00dcafef00dcafef00d");
    assert.equal(registry["forced"]?.nodeCount, 0);
  } finally {
    restore();
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("runIndexRepo: non-git dir fails without --allow-non-git", async () => {
  const home = await scratchHome();
  const parent = await mkdtemp(join(tmpdir(), "och-cli-index-repo-"));
  const restore = preserveExitCode();
  try {
    const repo = resolve(parent, "not-a-repo");
    await mkdir(repo, { recursive: true });
    await seedMeta(repo);

    const result = await runIndexRepo([repo], { home });
    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 1);
    assert.equal(process.exitCode, 1);

    const registry = await readRegistry({ home });
    assert.deepEqual(Object.keys(registry), []);
  } finally {
    restore();
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("runIndexRepo: --allow-non-git registers a folder without .git", async () => {
  const home = await scratchHome();
  const parent = await mkdtemp(join(tmpdir(), "och-cli-index-repo-"));
  const restore = preserveExitCode();
  try {
    const repo = resolve(parent, "bare");
    await mkdir(repo, { recursive: true });
    await seedMeta(repo);

    const result = await runIndexRepo([repo], { home, allowNonGit: true });
    assert.equal(result.successCount, 1);
    assert.equal(result.failureCount, 0);
    assert.equal(process.exitCode, undefined);

    const registry = await readRegistry({ home });
    assert.ok(registry[basename(repo)]);
  } finally {
    restore();
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("runIndexRepo: multi-path run — one failure does not skip the others", async () => {
  const home = await scratchHome();
  const parent = await mkdtemp(join(tmpdir(), "och-cli-index-repo-"));
  const restore = preserveExitCode();
  try {
    const good1 = await makeGitRepo(parent, "good1");
    await seedMeta(good1, { nodeCount: 10, edgeCount: 5 });
    const bad = await makeGitRepo(parent, "bad"); // missing meta.json
    const good2 = await makeGitRepo(parent, "good2");
    await seedMeta(good2, { nodeCount: 7, edgeCount: 3 });

    const result = await runIndexRepo([good1, bad, good2], { home });
    assert.equal(result.successCount, 2);
    assert.equal(result.failureCount, 1);
    assert.equal(process.exitCode, 1);

    const registry = await readRegistry({ home });
    assert.ok(registry["good1"]);
    assert.ok(registry["good2"]);
    assert.equal(registry["bad"], undefined);
    assert.equal(registry["good1"]?.nodeCount, 10);
    assert.equal(registry["good2"]?.nodeCount, 7);
  } finally {
    restore();
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
