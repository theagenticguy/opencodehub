/**
 * Tests for the BOM manifest builder.
 *
 * Covers four core invariants:
 *   A. Byte-identity: two runs on the same opts produce === manifest JSON.
 *   B. Hash sensitivity: each input field propagates to packHash.
 *   C. packHash is not part of its own preimage.
 *   D. Tokenizer-vendor differences produce different hashes.
 * Plus:
 *   E. Serializer emits snake_case keys in canonical order.
 *   F. `files` array preserves insertion order.
 *   G. schemaVersion is pinned to 1.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalJson, sha256Hex } from "@opencodehub/core-types";
import { buildManifest, serializeManifest } from "./manifest.js";
import type { BomItem, PackPins } from "./types.js";

const FIXTURE_PINS: PackPins = {
  chonkieVersion: "0.3.0",
  duckdbVersion: "1.1.3",
  grammarCommits: {
    python: "a".repeat(40),
    typescript: "b".repeat(40),
  },
};

const FIXTURE_FILES: readonly BomItem[] = [
  { kind: "skeleton", path: "skeleton.jsonl", fileHash: "c".repeat(64) },
  { kind: "file-tree", path: "file-tree.jsonl", fileHash: "d".repeat(64) },
  { kind: "deps", path: "deps.jsonl", fileHash: "e".repeat(64) },
];

function fixtureOpts() {
  return {
    commit: "0".repeat(40),
    repoOriginUrl: "https://github.com/example/repo",
    tokenizerId: "openai:o200k_base@0.8.0",
    determinismClass: "strict" as const,
    budgetTokens: 100_000,
    pins: FIXTURE_PINS,
    files: FIXTURE_FILES,
  };
}

test("A. buildManifest is deterministic: two runs produce byte-identical JSON", () => {
  const m1 = buildManifest(fixtureOpts());
  const m2 = buildManifest(fixtureOpts());
  assert.equal(m1.packHash, m2.packHash);
  assert.equal(serializeManifest(m1), serializeManifest(m2));
});

test("B. changing commit changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const alt = buildManifest({ ...fixtureOpts(), commit: "1".repeat(40) });
  assert.notEqual(base.packHash, alt.packHash);
});

test("B. changing tokenizerId changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const alt = buildManifest({ ...fixtureOpts(), tokenizerId: "openai:o200k_base@0.9.0" });
  assert.notEqual(base.packHash, alt.packHash);
});

test("B. changing budgetTokens changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const alt = buildManifest({ ...fixtureOpts(), budgetTokens: 200_000 });
  assert.notEqual(base.packHash, alt.packHash);
});

test("B. mutating files[0].fileHash changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const files: readonly BomItem[] = [
    { kind: "skeleton", path: "skeleton.jsonl", fileHash: "1".repeat(64) },
    ...FIXTURE_FILES.slice(1),
  ];
  const alt = buildManifest({ ...fixtureOpts(), files });
  assert.notEqual(base.packHash, alt.packHash);
});

test("B. changing pins.chonkieVersion changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const alt = buildManifest({
    ...fixtureOpts(),
    pins: { ...FIXTURE_PINS, chonkieVersion: "0.4.0" },
  });
  assert.notEqual(base.packHash, alt.packHash);
});

test("B. changing a single grammar commit changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const alt = buildManifest({
    ...fixtureOpts(),
    pins: {
      ...FIXTURE_PINS,
      grammarCommits: { ...FIXTURE_PINS.grammarCommits, python: "f".repeat(40) },
    },
  });
  assert.notEqual(base.packHash, alt.packHash);
});

test("B. changing repoOriginUrl changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const alt = buildManifest({ ...fixtureOpts(), repoOriginUrl: null });
  assert.notEqual(base.packHash, alt.packHash);
});

test("B. changing determinismClass changes packHash", () => {
  const base = buildManifest(fixtureOpts());
  const alt = buildManifest({ ...fixtureOpts(), determinismClass: "best_effort" });
  assert.notEqual(base.packHash, alt.packHash);
});

test("C. packHash is not part of its own preimage (round-trip)", () => {
  const m = buildManifest(fixtureOpts());
  // Rebuild the exact preimage the builder saw: same manifest shape but with
  // packHash set to "" as placeholder. Hashing that must reproduce m.packHash.
  const preimagePayload = {
    budget_tokens: m.budgetTokens,
    commit: m.commit,
    determinism_class: m.determinismClass,
    files: m.files.map((f) => ({
      file_hash: f.fileHash,
      kind: f.kind,
      path: f.path,
    })),
    pack_hash: "",
    pins: {
      chonkie_version: m.pins.chonkieVersion,
      duckdb_version: m.pins.duckdbVersion,
      grammar_commits: m.pins.grammarCommits,
    },
    repo_origin_url: m.repoOriginUrl,
    schema_version: m.schemaVersion,
    tokenizer_id: m.tokenizerId,
  };
  const recomputed = sha256Hex(canonicalJson(preimagePayload));
  assert.equal(recomputed, m.packHash);
});

test("D. tokenizer-vendor change flips packHash (openai vs anthropic)", () => {
  const openai = buildManifest({
    ...fixtureOpts(),
    tokenizerId: "openai:o200k_base@0.8.0",
  });
  const anthropic = buildManifest({
    ...fixtureOpts(),
    tokenizerId: "anthropic:claude-opus-4-7@2026-04",
  });
  assert.notEqual(openai.packHash, anthropic.packHash);
});

test("E. serializeManifest emits snake_case keys in canonical order", () => {
  const m = buildManifest(fixtureOpts());
  const s = serializeManifest(m);
  // No camelCase survives at the wire surface.
  assert.ok(!s.includes("repoOriginUrl"), "camelCase key leaked into JSON");
  assert.ok(!s.includes("tokenizerId"), "camelCase key leaked into JSON");
  assert.ok(!s.includes("packHash"), "camelCase key leaked into JSON");
  // Snake_case keys are present.
  assert.ok(s.includes('"repo_origin_url"'));
  assert.ok(s.includes('"tokenizer_id"'));
  assert.ok(s.includes('"pack_hash"'));
  assert.ok(s.includes('"schema_version":1'));
  assert.ok(s.includes('"pins"'));
  assert.ok(s.includes('"chonkie_version"'));
  assert.ok(s.includes('"grammar_commits"'));
  // First key in canonical order is `budget_tokens` (alphabetic UTF-16 sort).
  assert.ok(s.startsWith('{"budget_tokens":'));
});

test("F. files array preserves insertion order on the wire", () => {
  const m = buildManifest(fixtureOpts());
  const s = serializeManifest(m);
  const skeletonIdx = s.indexOf('"skeleton"');
  const fileTreeIdx = s.indexOf('"file-tree"');
  const depsIdx = s.indexOf('"deps"');
  assert.ok(skeletonIdx < fileTreeIdx, "files[0] should serialize before files[1]");
  assert.ok(fileTreeIdx < depsIdx, "files[1] should serialize before files[2]");
});

test("G. schemaVersion is pinned to 1 regardless of opts", () => {
  const m = buildManifest(fixtureOpts());
  assert.equal(m.schemaVersion, 1);
});

test("empty files array still produces a valid manifest", () => {
  const m = buildManifest({ ...fixtureOpts(), files: [] });
  assert.equal(m.files.length, 0);
  assert.match(m.packHash, /^[0-9a-f]{64}$/);
});

test("repoOriginUrl null serializes to JSON null, not absent", () => {
  const m = buildManifest({ ...fixtureOpts(), repoOriginUrl: null });
  const s = serializeManifest(m);
  assert.ok(s.includes('"repo_origin_url":null'));
});
