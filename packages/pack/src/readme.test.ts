/**
 * Tests for the BOM README renderer (item 9 partial).
 *
 * Covers:
 *   - A. Pure-function determinism: same inputs → same bytes.
 *   - B. Manifest fields are interpolated.
 *   - C. BOM item paths are alpha-sorted regardless of input order.
 *   - D. Empty grammar_commits renders "(none)".
 *   - E. null repo_origin_url renders "(none)".
 *   - F. Output is LF-only with a single trailing newline.
 *   - G. Determinism contract paragraphs are present.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildReadme } from "./readme.js";
import type { PackManifest } from "./types.js";

const FIXTURE_MANIFEST: PackManifest = {
  commit: "0".repeat(40),
  repoOriginUrl: "https://github.com/example/repo",
  tokenizerId: "openai:o200k_base@0.8.0",
  determinismClass: "strict",
  budgetTokens: 100_000,
  pins: {
    chonkieVersion: "0.0.9",
    grammarCommits: {
      python: "a".repeat(40),
      typescript: "b".repeat(40),
    },
  },
  files: [
    { kind: "skeleton", path: "skeleton.jsonl", fileHash: "c".repeat(64) },
    { kind: "manifest", path: "manifest.json", fileHash: "d".repeat(64) },
  ],
  contextBomHash: "f".repeat(64),
  packHash: "e".repeat(64),
  schemaVersion: 2,
};

test("A. buildReadme is pure: same inputs produce byte-identical output", () => {
  const md1 = buildReadme({
    manifest: FIXTURE_MANIFEST,
    bomItemPaths: ["skeleton.jsonl", "manifest.json"],
  });
  const md2 = buildReadme({
    manifest: FIXTURE_MANIFEST,
    bomItemPaths: ["skeleton.jsonl", "manifest.json"],
  });
  assert.equal(md1, md2);
});

test("B. manifest fields are interpolated into the README", () => {
  const md = buildReadme({
    manifest: FIXTURE_MANIFEST,
    bomItemPaths: ["skeleton.jsonl"],
  });
  assert.ok(md.includes(FIXTURE_MANIFEST.commit));
  assert.ok(md.includes(FIXTURE_MANIFEST.tokenizerId));
  assert.ok(md.includes(FIXTURE_MANIFEST.packHash));
  assert.ok(md.includes("100000"));
  assert.ok(md.includes("strict"));
  assert.ok(md.includes(FIXTURE_MANIFEST.pins.chonkieVersion));
});

test("C. BOM item paths are alpha-sorted regardless of input order", () => {
  const md = buildReadme({
    manifest: FIXTURE_MANIFEST,
    bomItemPaths: ["zzz.md", "aaa.jsonl", "manifest.json"],
  });
  const aaaIdx = md.indexOf("aaa.jsonl");
  const manifestIdx = md.indexOf("`manifest.json`");
  const zzzIdx = md.indexOf("zzz.md");
  assert.ok(aaaIdx > 0 && manifestIdx > aaaIdx && zzzIdx > manifestIdx);
});

test("D. empty grammar_commits renders '(none)'", () => {
  const md = buildReadme({
    manifest: { ...FIXTURE_MANIFEST, pins: { ...FIXTURE_MANIFEST.pins, grammarCommits: {} } },
    bomItemPaths: [],
  });
  assert.ok(md.includes("grammar_commits: (none)"));
});

test("E. null repo_origin_url renders '(none)'", () => {
  const md = buildReadme({
    manifest: { ...FIXTURE_MANIFEST, repoOriginUrl: null },
    bomItemPaths: [],
  });
  assert.ok(md.includes("repo_origin_url: (none)"));
});

test("F. output is LF-only with a single trailing newline", () => {
  const md = buildReadme({
    manifest: FIXTURE_MANIFEST,
    bomItemPaths: ["skeleton.jsonl"],
  });
  assert.ok(!md.includes("\r\n"));
  assert.ok(md.endsWith("\n"));
  assert.ok(!md.endsWith("\n\n"));
});

test("G. determinism contract paragraphs are present", () => {
  const md = buildReadme({
    manifest: FIXTURE_MANIFEST,
    bomItemPaths: [],
  });
  assert.ok(md.includes("## Determinism contract"));
  assert.ok(md.includes("strict"));
  assert.ok(md.includes("best_effort"));
  assert.ok(md.includes("degraded"));
  assert.ok(md.includes("LF"));
});

test("H. caller's bomItemPaths array is not mutated", () => {
  const input = ["zzz.md", "aaa.jsonl"];
  const before = [...input];
  buildReadme({ manifest: FIXTURE_MANIFEST, bomItemPaths: input });
  assert.deepEqual(input, before);
});
