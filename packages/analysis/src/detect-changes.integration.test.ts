import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runDetectChanges } from "./detect-changes.js";
import { FakeStore } from "./test-utils.js";

const execFileP = promisify(execFile);

async function hasGit(): Promise<boolean> {
  try {
    await execFileP("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "och-analysis-gitrepo-"));
  await execFileP("git", ["init", "-q"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}

test("runDetectChanges: unstaged change intersects function 1 only", async (t) => {
  if (!(await hasGit())) {
    t.skip("git binary unavailable");
    return;
  }
  const repo = await makeRepo();
  const relPath = "src/a.ts";
  await execFileP("mkdir", ["-p", join(repo, "src")]);
  const initial = [
    "function foo() {", // line 1
    "  return 1;", // line 2
    "}", // line 3
    "", // line 4
    "function bar() {", // line 5
    "  return 2;", // line 6
    "}", // line 7
    "",
  ].join("\n");
  await writeFile(join(repo, relPath), initial, "utf8");
  await execFileP("git", ["add", "."], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  // Unstaged edit inside foo only.
  const edited = [
    "function foo() {",
    "  return 999;", // modified line 2
    "}",
    "",
    "function bar() {",
    "  return 2;",
    "}",
    "",
  ].join("\n");
  await writeFile(join(repo, relPath), edited, "utf8");

  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: relPath,
    startLine: 1,
    endLine: 3,
  });
  store.addNode({
    id: "Function:src/a.ts:bar#0",
    kind: "Function",
    name: "bar",
    filePath: relPath,
    startLine: 5,
    endLine: 7,
  });

  const res = await runDetectChanges(store, { scope: "unstaged", repoPath: repo });
  assert.deepEqual(res.changedFiles, [relPath]);
  assert.equal(res.affectedSymbols.length, 1, "only foo should overlap the hunk");
  assert.equal(res.affectedSymbols[0]?.name, "foo");
  assert.equal(res.summary.fileCount, 1);
  assert.equal(res.summary.symbolCount, 1);
  assert.equal(res.summary.risk, "MEDIUM"); // 1 * 3 = 3 → MEDIUM
});
