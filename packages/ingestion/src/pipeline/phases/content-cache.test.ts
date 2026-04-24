import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  CACHE_VERSION,
  type CacheEntry,
  cacheFilePath,
  computeCacheSize,
  deriveCacheKey,
  readCacheEntry,
  writeCacheEntry,
} from "./content-cache.js";

const SAMPLE_SHA = "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";
const GRAMMAR_SHA = "deadbeefcafe1234567890abcdef1234567890abcdef1234567890abcdef1234";
const PIPELINE_VERSION = "1.0.0";

function sampleEntry(): CacheEntry {
  return {
    cacheVersion: CACHE_VERSION,
    grammarSha: GRAMMAR_SHA,
    pipelineVersion: PIPELINE_VERSION,
    extractions: {
      definitions: [
        {
          kind: "Function",
          name: "f",
          qualifiedName: "f",
          filePath: "a.ts",
          startLine: 1,
          endLine: 1,
          isExported: true,
        },
      ],
      calls: [],
      imports: [],
      heritage: [],
    },
    metadata: {
      language: "typescript",
      byteSize: 42,
    },
  };
}

describe("content-cache", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "och-content-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("deriveCacheKey is deterministic", () => {
    const k1 = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const k2 = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    assert.deepEqual(k1, k2);
    assert.equal(k1.contentSha, SAMPLE_SHA);
    assert.equal(k1.grammarSha, GRAMMAR_SHA);
    assert.equal(k1.pipelineVersion, PIPELINE_VERSION);
  });

  it("cacheFilePath uses 2-char sharding + grammar + pipeline suffix", () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const p = cacheFilePath(cacheDir, key);
    // Shard dir is the 2-char prefix of contentSha.
    assert.equal(path.dirname(p), path.join(cacheDir, SAMPLE_SHA.slice(0, 2)));
    // Filename contains full contentSha, 6-char grammar prefix, pipelineVersion.
    assert.equal(
      path.basename(p),
      `${SAMPLE_SHA}-${GRAMMAR_SHA.slice(0, 6)}-${PIPELINE_VERSION}.json`,
    );
  });

  it("cacheFilePath is a pure function of the key (no side effects)", () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const a = cacheFilePath(cacheDir, key);
    const b = cacheFilePath(cacheDir, key);
    assert.equal(a, b);
  });

  it("different grammar SHAs produce different filenames", () => {
    const k1 = deriveCacheKey(SAMPLE_SHA, "a".repeat(64), PIPELINE_VERSION);
    const k2 = deriveCacheKey(SAMPLE_SHA, "b".repeat(64), PIPELINE_VERSION);
    assert.notEqual(cacheFilePath(cacheDir, k1), cacheFilePath(cacheDir, k2));
  });

  it("different pipeline versions produce different filenames", () => {
    const k1 = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, "1.0.0");
    const k2 = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, "1.1.0");
    assert.notEqual(cacheFilePath(cacheDir, k1), cacheFilePath(cacheDir, k2));
  });

  it("readCacheEntry returns null on missing file", async () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const result = await readCacheEntry(cacheDir, key);
    assert.equal(result, null);
  });

  it("readCacheEntry returns null on malformed JSON", async () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const filePath = cacheFilePath(cacheDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ this is not valid json ]");
    const result = await readCacheEntry(cacheDir, key);
    assert.equal(result, null);
  });

  it("readCacheEntry returns null on shape mismatch", async () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const filePath = cacheFilePath(cacheDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ cacheVersion: 999 }));
    const result = await readCacheEntry(cacheDir, key);
    assert.equal(result, null);
  });

  it("readCacheEntry returns null if grammarSha in envelope disagrees with key", async () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const filePath = cacheFilePath(cacheDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const bad: CacheEntry = { ...sampleEntry(), grammarSha: "x".repeat(64) };
    await fs.writeFile(filePath, JSON.stringify(bad));
    const result = await readCacheEntry(cacheDir, key);
    assert.equal(result, null);
  });

  it("writeCacheEntry + readCacheEntry round-trip preserves all fields", async () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const entry = sampleEntry();
    await writeCacheEntry(cacheDir, key, entry);
    const back = await readCacheEntry(cacheDir, key);
    assert.ok(back);
    assert.deepEqual(back, entry);
  });

  it("writeCacheEntry creates shard parent directories recursively", async () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const entry = sampleEntry();
    await writeCacheEntry(cacheDir, key, entry);
    const shardDir = path.join(cacheDir, SAMPLE_SHA.slice(0, 2));
    const stat = await fs.stat(shardDir);
    assert.ok(stat.isDirectory());
  });

  it("writeCacheEntry tolerates an already-existing shard directory", async () => {
    const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const shardDir = path.join(cacheDir, SAMPLE_SHA.slice(0, 2));
    await fs.mkdir(shardDir, { recursive: true });
    await writeCacheEntry(cacheDir, key, sampleEntry());
    // second write to same shard should also succeed.
    await writeCacheEntry(cacheDir, key, sampleEntry());
    const back = await readCacheEntry(cacheDir, key);
    assert.ok(back);
  });

  it("computeCacheSize reports zero for missing cache dir", async () => {
    const ghost = path.join(cacheDir, "does", "not", "exist");
    const { fileCount, bytes } = await computeCacheSize(ghost);
    assert.equal(fileCount, 0);
    assert.equal(bytes, 0);
  });

  it("computeCacheSize sums file count and total bytes", async () => {
    const k1 = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
    const k2 = deriveCacheKey(`${"f".repeat(62)}aa`, GRAMMAR_SHA, PIPELINE_VERSION);
    await writeCacheEntry(cacheDir, k1, sampleEntry());
    await writeCacheEntry(cacheDir, k2, sampleEntry());
    const { fileCount, bytes } = await computeCacheSize(cacheDir);
    assert.equal(fileCount, 2);
    assert.ok(bytes > 0);
  });
});
