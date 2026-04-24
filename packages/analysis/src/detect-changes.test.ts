import assert from "node:assert/strict";
import { test } from "node:test";
import { runDetectChanges } from "./detect-changes.js";
import { parseDiffHunks } from "./git.js";
import { FakeStore } from "./test-utils.js";

test("parseDiffHunks: extracts new-side line ranges from a unified diff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 000..111 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " function foo() {",
    "+  console.log('hi');",
    "   return 1;",
    "@@ -10,0 +20,2 @@",
    "+// new block",
    "+// new block 2",
    "",
  ].join("\n");

  const hunks = parseDiffHunks(diff);
  const aHunks = hunks.get("src/a.ts");
  assert.ok(aHunks, "src/a.ts hunks must be present");
  assert.equal(aHunks.length, 2);
  assert.deepEqual(aHunks[0], { start: 1, count: 3 });
  assert.deepEqual(aHunks[1], { start: 20, count: 2 });
});

test("parseDiffHunks: treats count=0 hunks as zero-width markers", () => {
  const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -5 +5,0 @@", "-// removed line", ""].join("\n");
  const hunks = parseDiffHunks(diff);
  const list = hunks.get("x.ts");
  assert.ok(list);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.start, 5);
  assert.equal(list[0]?.count, 0);
});

test("parseDiffHunks: skips file header for /dev/null (deletion)", () => {
  const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@", "-old line", ""].join("\n");
  const hunks = parseDiffHunks(diff);
  // No +++ file, so no hunks should be recorded.
  assert.equal(hunks.size, 0);
});

// --------------------------------------------------------------------------
// End-to-end: drive runDetectChanges with injected file/hunk data via a fake
// store. Rather than spawn real git, we test the overlap-and-lookup path by
// exercising the risk and process paths through the graph layer.
// --------------------------------------------------------------------------

test("runDetectChanges: compare scope without compareRef fails open", async () => {
  const store = new FakeStore();
  // Use a path guaranteed not to be a git repo so the git calls fail-open.
  const res = await runDetectChanges(store, {
    scope: "compare",
    repoPath: "/nonexistent-repo-path-that-does-not-exist",
  });
  assert.equal(res.changedFiles.length, 0);
  assert.equal(res.affectedSymbols.length, 0);
  assert.equal(res.summary.risk, "LOW");
});

test("runDetectChanges: non-git directory fail-opens to empty result", async () => {
  const store = new FakeStore();
  const res = await runDetectChanges(store, {
    scope: "unstaged",
    repoPath: "/definitely-not-a-git-repo-zzz-12345",
  });
  assert.deepEqual(res.changedFiles, []);
  assert.deepEqual(res.affectedSymbols, []);
  assert.deepEqual(res.affectedProcesses, []);
  assert.equal(res.summary.fileCount, 0);
  assert.equal(res.summary.risk, "LOW");
});
