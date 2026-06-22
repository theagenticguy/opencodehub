/**
 * Tests for `runCodePack` (the `codehub code-pack` subcommand handler).
 *
 * Strategy: inject `_generatePack` and `_runRepomix` test seams so the
 * unit tests assert wiring without opening a real store or shelling out
 * to `npx repomix`. Engine routing, default values, and
 * the `<repo>/.codehub/packs/<packHash>/` path layout are all asserted
 * here.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PackManifest } from "@opencodehub/pack";
import type { IGraphStore } from "@opencodehub/storage";
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_ENGINE,
  DEFAULT_TOKENIZER_ID,
  runCodePack,
} from "./code-pack.js";

function makeFakeManifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    commit: "0".repeat(40),
    repoOriginUrl: null,
    tokenizerId: DEFAULT_TOKENIZER_ID,
    determinismClass: "strict",
    budgetTokens: DEFAULT_BUDGET_TOKENS,
    pins: { chonkieVersion: "0.0.9", grammarCommits: {} },
    files: [
      { kind: "skeleton", path: "skeleton.jsonl", fileHash: "a".repeat(64) },
      { kind: "file-tree", path: "file-tree.jsonl", fileHash: "b".repeat(64) },
      { kind: "deps", path: "deps.jsonl", fileHash: "c".repeat(64) },
      { kind: "ast-chunks", path: "ast-chunks.jsonl", fileHash: "d".repeat(64) },
      { kind: "xrefs", path: "xrefs.jsonl", fileHash: "e".repeat(64) },
      { kind: "findings", path: "findings.jsonl", fileHash: "f".repeat(64) },
      { kind: "licenses", path: "licenses.md", fileHash: "1".repeat(64) },
    ],
    packHash: "deadbeef".repeat(8),
    schemaVersion: 1,
    ...overrides,
  };
}

const FAKE_STORE: IGraphStore = {} as unknown as IGraphStore;

test("DEFAULT_ENGINE is 'pack'", () => {
  assert.equal(DEFAULT_ENGINE, "pack");
});

test("DEFAULT_BUDGET_TOKENS is 100_000", () => {
  assert.equal(DEFAULT_BUDGET_TOKENS, 100_000);
});

test("DEFAULT_TOKENIZER_ID matches the spec pin", () => {
  assert.equal(DEFAULT_TOKENIZER_ID, "openai:o200k_base@tiktoken-0.8.0");
});

test("runCodePack defaults to engine=pack and dispatches to generatePack", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "codehub-codepack-default-"));
  try {
    let captured: { repoPath?: string; outDir?: string; budget?: number; tokenizer?: string } = {};
    const fakeGenerate = (async (
      opts: { repoPath: string; outDir: string; budgetTokens: number; tokenizerId: string },
      _internal: unknown,
    ) => {
      captured = {
        repoPath: opts.repoPath,
        outDir: opts.outDir,
        budget: opts.budgetTokens,
        tokenizer: opts.tokenizerId,
      };
      // Write a sentinel file to the staging dir so the rename is meaningful.
      await mkdir(opts.outDir, { recursive: true });
      await writeFile(join(opts.outDir, "manifest.json"), "{}");
      return makeFakeManifest({ packHash: "abc123" });
      // biome-ignore lint/suspicious/noExplicitAny: cross-package generic narrowing in test injection
    }) as any;

    const result = await runCodePack({
      repo: repoPath,
      _generatePack: fakeGenerate,
      _store: FAKE_STORE,
    });

    assert.equal(result.engine, "pack");
    assert.equal(result.packHash, "abc123");
    assert.equal(result.bomItemCount, 8); // 7 mandatory items + manifest
    assert.equal(captured.repoPath, repoPath);
    assert.equal(captured.budget, DEFAULT_BUDGET_TOKENS);
    assert.equal(captured.tokenizer, DEFAULT_TOKENIZER_ID);
    assert.equal(result.outDir, resolve(repoPath, ".codehub", "packs", "abc123"));
    // The manifest file we staged should now live at finalOutDir.
    const onDisk = await readFile(join(result.outDir, "manifest.json"), "utf8");
    assert.equal(onDisk, "{}");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("runCodePack honors --budget and --tokenizer overrides", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "codehub-codepack-override-"));
  try {
    let capturedBudget = 0;
    let capturedTokenizer = "";
    const fakeGenerate = (async (
      opts: { repoPath: string; outDir: string; budgetTokens: number; tokenizerId: string },
      _internal: unknown,
    ) => {
      capturedBudget = opts.budgetTokens;
      capturedTokenizer = opts.tokenizerId;
      await mkdir(opts.outDir, { recursive: true });
      await writeFile(join(opts.outDir, "manifest.json"), "{}");
      return makeFakeManifest({ packHash: "f".repeat(64) });
      // biome-ignore lint/suspicious/noExplicitAny: cross-package generic narrowing in test injection
    }) as any;

    await runCodePack({
      repo: repoPath,
      budget: 50_000,
      tokenizer: "anthropic:claude-3-7@1.0.0",
      _generatePack: fakeGenerate,
      _store: FAKE_STORE,
    });

    assert.equal(capturedBudget, 50_000);
    assert.equal(capturedTokenizer, "anthropic:claude-3-7@1.0.0");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("runCodePack engine='pack' resolves a relative repo path against process.cwd()", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codehub-codepack-cwd-"));
  const original = process.cwd();
  try {
    process.chdir(cwd);
    // After chdir, read the cwd back: on macOS `tmpdir()` yields `/tmp/...`
    // but `/tmp` is a symlink to `/private/tmp`, so `process.cwd()` (and the
    // production code that resolves against it) returns the realpath form.
    // Assert against that, not the raw mkdtemp string, or the comparison is
    // a symlink artifact rather than a real check.
    const resolvedCwd = process.cwd();
    const fakeGenerate = (async (
      opts: { repoPath: string; outDir: string; budgetTokens: number; tokenizerId: string },
      _internal: unknown,
    ) => {
      // The point of this test is to assert the resolved repo path equals
      // the absolute form of the cwd, NOT a relative `./` form.
      assert.equal(opts.repoPath, resolvedCwd);
      await mkdir(opts.outDir, { recursive: true });
      await writeFile(join(opts.outDir, "manifest.json"), "{}");
      return makeFakeManifest({ packHash: "1234" });
      // biome-ignore lint/suspicious/noExplicitAny: cross-package generic narrowing in test injection
    }) as any;

    const result = await runCodePack({
      _generatePack: fakeGenerate,
      _store: FAKE_STORE,
    });

    assert.equal(result.engine, "pack");
    assert.equal(result.outDir, resolve(resolvedCwd, ".codehub", "packs", "1234"));
  } finally {
    process.chdir(original);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runCodePack engine='pack' honors a custom --out-dir", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "codehub-codepack-customout-"));
  const customOut = await mkdtemp(join(tmpdir(), "codehub-codepack-customout-target-"));
  try {
    // Pre-clean the target dir so rename has a clean landing zone.
    await rm(customOut, { recursive: true, force: true });
    const fakeGenerate = (async (
      opts: { repoPath: string; outDir: string; budgetTokens: number; tokenizerId: string },
      _internal: unknown,
    ) => {
      await mkdir(opts.outDir, { recursive: true });
      await writeFile(join(opts.outDir, "manifest.json"), "{}");
      return makeFakeManifest({ packHash: "abc123" });
      // biome-ignore lint/suspicious/noExplicitAny: cross-package generic narrowing in test injection
    }) as any;

    const result = await runCodePack({
      repo: repoPath,
      outDir: customOut,
      _generatePack: fakeGenerate,
      _store: FAKE_STORE,
    });

    // Custom out-dir wins over the .codehub/packs/<hash>/ default.
    assert.equal(result.outDir, resolve(customOut));
    const onDisk = await readFile(join(result.outDir, "manifest.json"), "utf8");
    assert.equal(onDisk, "{}");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
    await rm(customOut, { recursive: true, force: true });
  }
});

test("runCodePack engine='repomix' delegates to runPack and does NOT call generatePack", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "codehub-codepack-repomix-"));
  try {
    // Write a fake repomix output so the SHA pass succeeds.
    const fakeOut = join(repoPath, ".codehub", "pack", "repo.xml");
    await mkdir(join(repoPath, ".codehub", "pack"), { recursive: true });
    await writeFile(fakeOut, "<repomix>fake</repomix>");

    let generateCalled = false;
    const fakeGenerate = (async () => {
      generateCalled = true;
      return makeFakeManifest();
      // biome-ignore lint/suspicious/noExplicitAny: cross-package generic narrowing in test injection
    }) as any;
    let repomixCalled = false;
    const fakeRunPack = (async (path: string) => {
      repomixCalled = true;
      assert.equal(path, repoPath);
      return { outputPath: fakeOut, bytes: 22, durationMs: 1 };
      // biome-ignore lint/suspicious/noExplicitAny: cross-package generic narrowing in test injection
    }) as any;

    const result = await runCodePack({
      repo: repoPath,
      engine: "repomix",
      _generatePack: fakeGenerate,
      _runRepomix: fakeRunPack,
    });

    assert.equal(generateCalled, false, "generatePack should not be called on engine=repomix");
    assert.equal(repomixCalled, true);
    assert.equal(result.engine, "repomix");
    assert.equal(result.bomItemCount, 1);
    assert.equal(result.repomixOutputPath, fakeOut);
    assert.equal(result.manifest, null);
    // packHash is sha256 of the file contents.
    assert.match(result.packHash, /^[0-9a-f]{64}$/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("runCodePack engine='pack' raises when the graph index is missing and no _store is injected", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "codehub-codepack-missing-"));
  try {
    // No _store, no _generatePack — the existsSync(dbPath) gate must fire.
    await assert.rejects(
      runCodePack({ repo: repoPath }),
      /no graph index|codehub analyze/,
      "expected a clear error pointing at codehub analyze",
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
