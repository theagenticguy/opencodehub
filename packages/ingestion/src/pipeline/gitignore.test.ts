/**
 * Nested `.gitignore` regression suite — DET-E-004 and DET-U-003.
 *
 * Builds a 3-level fixture where each layer either ignores or re-includes
 * paths the parent layer decided. The loader must stack rules from repo
 * root downward and the resolver must honour negation across files.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadGitignoreChain, parseGitignore, shouldIgnore } from "./gitignore.js";

test("loadGitignoreChain: root file only — returns a single-entry map", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "och-gi-root-"));
  try {
    await fs.writeFile(path.join(repo, ".gitignore"), "*.log\n");
    const chain = await loadGitignoreChain(repo);
    assert.ok(chain.get("") !== undefined, "root layer must be present");
    assert.equal(chain.size, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("loadGitignoreChain: 3-level nested fixture with negation edge cases", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "och-gi-nested-"));
  try {
    // Layer 0 (repo root): ignore *.draft.md everywhere.
    await fs.writeFile(path.join(repo, ".gitignore"), "*.draft.md\n");
    // Layer 1 (docs/): re-include *.draft.md, and ignore scratch/.
    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", ".gitignore"), "!*.draft.md\nscratch/\n");
    // Layer 2 (docs/archive/): ignore KEEP-secret.md specifically.
    await fs.mkdir(path.join(repo, "docs", "archive"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", "archive", ".gitignore"), "KEEP-secret.md\n");

    // Add the files the rules operate on.
    await fs.writeFile(path.join(repo, "top.draft.md"), "top");
    await fs.writeFile(path.join(repo, "docs", "intro.draft.md"), "intro");
    await fs.writeFile(path.join(repo, "docs", "archive", "note.draft.md"), "note");
    await fs.writeFile(path.join(repo, "docs", "archive", "KEEP-secret.md"), "secret");
    await fs.mkdir(path.join(repo, "docs", "scratch"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", "scratch", "todo.md"), "todo");

    const chain = await loadGitignoreChain(repo);

    // Root-level `.draft.md` file: root layer says ignore, no deeper
    // layer touches it → ignored.
    assert.equal(shouldIgnore("top.draft.md", chain), true, "root-level draft is ignored");

    // docs/intro.draft.md: root says ignore, docs layer re-includes via
    // `!*.draft.md` → not ignored.
    assert.equal(
      shouldIgnore("docs/intro.draft.md", chain),
      false,
      "docs layer re-includes draft files",
    );

    // docs/archive/note.draft.md: root → ignored; docs → re-included;
    // archive has no rule that touches drafts → final state: re-included.
    assert.equal(
      shouldIgnore("docs/archive/note.draft.md", chain),
      false,
      "archive inherits docs' negation",
    );

    // docs/archive/KEEP-secret.md: root and docs say nothing; archive
    // ignores it → ignored.
    assert.equal(
      shouldIgnore("docs/archive/KEEP-secret.md", chain),
      true,
      "archive layer ignores KEEP-secret",
    );

    // docs/scratch (directory): docs layer marks `scratch/` directory-only
    // as ignored → ignored.
    assert.equal(
      shouldIgnore("docs/scratch", chain, { isDirectory: true }),
      true,
      "docs scratch/ dir is ignored",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("parseGitignore: negation, directory-only, anchored all parse correctly", () => {
  const rules = parseGitignore(
    ["# comment", "*.log", "!keep.log", "/root-only", "build/"].join("\n"),
  );
  assert.equal(rules.length, 4);
  const [starLog, keep, rootOnly, buildDir] = rules;
  assert.equal(starLog?.negate, false);
  assert.equal(keep?.negate, true);
  assert.equal(rootOnly?.anchored, true);
  assert.equal(buildDir?.directoryOnly, true);
});

test("shouldIgnore: flat-rules overload remains backward compatible", () => {
  const rules = parseGitignore("*.log\n!keep.log\n");
  assert.equal(shouldIgnore("random.log", rules), true);
  assert.equal(shouldIgnore("keep.log", rules), false);
});
