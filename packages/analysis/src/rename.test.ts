import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runRename } from "./rename.js";
import { FakeFs, FakeStore } from "./test-utils.js";

const REPO_ROOT = "/repo";

function abs(rel: string): string {
  return join(REPO_ROOT, rel);
}

test("runRename: dry-run emits graph edits for definition + internal caller", async () => {
  const store = new FakeStore();
  const filePath = "src/a.ts";
  store.addNode({ id: `File:${filePath}:a.ts`, kind: "File", name: "a.ts", filePath });
  store.addNode({
    id: `Function:${filePath}:foo#0`,
    kind: "Function",
    name: "foo",
    filePath,
    startLine: 1,
    endLine: 3,
  });
  store.addNode({
    id: `Function:${filePath}:bar#0`,
    kind: "Function",
    name: "bar",
    filePath,
    startLine: 5,
    endLine: 7,
  });
  store.addEdge({
    fromId: `Function:${filePath}:bar#0`,
    toId: `Function:${filePath}:foo#0`,
    type: "CALLS",
    confidence: 0.9,
  });

  const source = [
    "function foo() {",
    "  return 1;",
    "}",
    "",
    "function bar() {",
    "  return foo();",
    "}",
    "",
  ].join("\n");
  const fs = new FakeFs({ [abs(filePath)]: source });

  const res = await runRename(store, { symbolName: "foo", newName: "foo2" }, fs, REPO_ROOT);

  assert.equal(res.applied, false);
  assert.equal(res.ambiguous, false);
  // Two graph edits: the definition on line 1 and the call inside bar on line 6.
  assert.equal(res.edits.length, 2);
  for (const edit of res.edits) {
    assert.equal(edit.source, "graph");
    assert.equal(edit.confidence, 1.0);
    assert.equal(edit.before, "foo");
    assert.equal(edit.after, "foo2");
  }
  const lines = res.edits.map((e) => e.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [1, 6]);
  // File on disk must not have changed in dry-run mode.
  assert.equal(fs.files.get(abs(filePath)), source);
});

test("runRename: text fallback emits confidence-0.5 edits in uncovered files", async () => {
  const store = new FakeStore();
  // Declare the graph-known symbol in file `a.ts` so the text sweep targets a
  // sibling file `b.ts` that merely mentions the name in a comment.
  const fileA = "src/a.ts";
  const fileB = "src/b.ts";
  store.addNode({ id: `File:${fileA}:a.ts`, kind: "File", name: "a.ts", filePath: fileA });
  store.addNode({ id: `File:${fileB}:b.ts`, kind: "File", name: "b.ts", filePath: fileB });
  store.addNode({
    id: `Function:${fileA}:fooHelper#0`,
    kind: "Function",
    name: "fooHelper",
    filePath: fileA,
    startLine: 1,
    endLine: 2,
  });

  const aSrc = "function fooHelper() {}\n";
  const bSrc = "// mentions fooHelper in a comment\nexport const x = 1;\n";
  const fs = new FakeFs({ [abs(fileA)]: aSrc, [abs(fileB)]: bSrc });

  const res = await runRename(
    store,
    { symbolName: "fooHelper", newName: "fooHelperV2" },
    fs,
    REPO_ROOT,
  );

  const textEdits = res.edits.filter((e) => e.source === "text");
  const graphEdits = res.edits.filter((e) => e.source === "graph");
  assert.equal(graphEdits.length, 1, "definition site is graph-backed");
  assert.equal(graphEdits[0]?.filePath, fileA);
  assert.equal(textEdits.length, 1, "the comment hit in b.ts should be text-backed");
  assert.equal(textEdits[0]?.filePath, fileB);
  assert.equal(textEdits[0]?.confidence, 0.5);
  assert.ok(res.hint?.includes("text-only"));
});

test("runRename: apply mode writes rewritten content atomically", async () => {
  const store = new FakeStore();
  const filePath = "src/a.ts";
  store.addNode({ id: `File:${filePath}:a.ts`, kind: "File", name: "a.ts", filePath });
  store.addNode({
    id: `Function:${filePath}:foo#0`,
    kind: "Function",
    name: "foo",
    filePath,
    startLine: 1,
    endLine: 1,
  });

  const source = "function foo() { return 1; }\n";
  const fs = new FakeFs({ [abs(filePath)]: source });

  const res = await runRename(
    store,
    { symbolName: "foo", newName: "bar", dryRun: false },
    fs,
    REPO_ROOT,
  );

  assert.equal(res.applied, true);
  assert.equal(res.skipped.length, 0);
  assert.equal(fs.files.get(abs(filePath)), "function bar() { return 1; }\n");
});

test("runRename: apply mode handles multiple edits on the same line in right-to-left order", async () => {
  const store = new FakeStore();
  const filePath = "src/a.ts";
  store.addNode({ id: `File:${filePath}:a.ts`, kind: "File", name: "a.ts", filePath });
  store.addNode({
    id: `Function:${filePath}:x#0`,
    kind: "Function",
    name: "x",
    filePath,
    startLine: 1,
    endLine: 1,
  });

  const source = "function x() { return x() + x(); }\n";
  const fs = new FakeFs({ [abs(filePath)]: source });

  const res = await runRename(
    store,
    { symbolName: "x", newName: "xx", dryRun: false },
    fs,
    REPO_ROOT,
  );

  assert.equal(res.applied, true);
  assert.equal(fs.files.get(abs(filePath)), "function xx() { return xx() + xx(); }\n");
});

test("runRename: ambiguous target without scope returns hint and zero edits", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "Function:src/a.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 1,
  });
  store.addNode({
    id: "Function:src/b.ts:foo#0",
    kind: "Function",
    name: "foo",
    filePath: "src/b.ts",
    startLine: 1,
    endLine: 1,
  });
  const fs = new FakeFs();

  const res = await runRename(store, { symbolName: "foo", newName: "foo2" }, fs, REPO_ROOT);

  assert.equal(res.ambiguous, true);
  assert.equal(res.edits.length, 0);
  assert.ok(res.hint?.includes("scope.filePath"));
});

test("runRename: symbol not found returns empty result with hint", async () => {
  const store = new FakeStore();
  const fs = new FakeFs();
  const res = await runRename(store, { symbolName: "nope", newName: "never" }, fs, REPO_ROOT);
  assert.equal(res.edits.length, 0);
  assert.equal(res.applied, false);
  assert.ok(res.hint?.includes("not found"));
});
