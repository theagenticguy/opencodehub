import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { computeStaleness } from "./staleness.js";

const execFileP = promisify(execFile);

async function hasGit(): Promise<boolean> {
  try {
    await execFileP("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

test("computeStaleness: non-git directory fail-opens to not-stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "och-analysis-staleness-non-git-"));
  const res = await computeStaleness(dir, "deadbeef");
  assert.equal(res.isStale, false);
  assert.equal(res.commitsBehind, 0);
});

test("computeStaleness: lastIndexedCommit equal to HEAD → not stale", async (t) => {
  if (!(await hasGit())) {
    t.skip("git binary unavailable");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "och-analysis-staleness-synced-"));
  await execFileP("git", ["init", "-q"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "T"], { cwd: dir });
  await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README"), "hello\n", "utf8");
  await execFileP("git", ["add", "."], { cwd: dir });
  await execFileP("git", ["commit", "-q", "-m", "first"], { cwd: dir });
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  const head = stdout.trim();

  const res = await computeStaleness(dir, head);
  assert.equal(res.isStale, false);
  assert.equal(res.commitsBehind, 0);
  assert.equal(res.lastIndexedCommit, head);
  assert.equal(res.currentCommit, head);
});

test("computeStaleness: drifted HEAD surfaces commitsBehind + hint", async (t) => {
  if (!(await hasGit())) {
    t.skip("git binary unavailable");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "och-analysis-staleness-drift-"));
  await execFileP("git", ["init", "-q"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "T"], { cwd: dir });
  await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README"), "hello\n", "utf8");
  await execFileP("git", ["add", "."], { cwd: dir });
  await execFileP("git", ["commit", "-q", "-m", "c1"], { cwd: dir });
  const { stdout: firstSha } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  const firstCommit = firstSha.trim();

  await writeFile(join(dir, "README"), "hello again\n", "utf8");
  await execFileP("git", ["add", "."], { cwd: dir });
  await execFileP("git", ["commit", "-q", "-m", "c2"], { cwd: dir });

  const res = await computeStaleness(dir, firstCommit);
  assert.equal(res.isStale, true);
  assert.equal(res.commitsBehind, 1);
  assert.ok(res.hint?.includes("codehub analyze --force"));
});

test("computeStaleness: undefined lastIndexedCommit returns not stale with currentCommit", async (t) => {
  if (!(await hasGit())) {
    t.skip("git binary unavailable");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "och-analysis-staleness-never-"));
  await execFileP("git", ["init", "-q"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "T"], { cwd: dir });
  await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README"), "hi\n", "utf8");
  await execFileP("git", ["add", "."], { cwd: dir });
  await execFileP("git", ["commit", "-q", "-m", "c"], { cwd: dir });

  const res = await computeStaleness(dir, undefined);
  assert.equal(res.isStale, false);
  assert.equal(res.commitsBehind, 0);
  assert.ok(res.currentCommit);
});
