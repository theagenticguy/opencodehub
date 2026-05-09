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
  evictIfOverCap,
  parseHumanSizeBytes,
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

describe("parseHumanSizeBytes", () => {
  it("parses binary units (GiB, MiB, KiB)", () => {
    assert.equal(parseHumanSizeBytes("1GiB"), 1024 ** 3);
    assert.equal(parseHumanSizeBytes("2MiB"), 2 * 1024 ** 2);
    assert.equal(parseHumanSizeBytes("4KiB"), 4 * 1024);
  });

  it("parses decimal units (GB, MB, KB) distinct from binary", () => {
    assert.equal(parseHumanSizeBytes("1GB"), 1_000_000_000);
    assert.equal(parseHumanSizeBytes("500MB"), 500_000_000);
    assert.equal(parseHumanSizeBytes("1KB"), 1_000);
  });

  it("parses bare bytes and the explicit B unit", () => {
    assert.equal(parseHumanSizeBytes("1024"), 1024);
    assert.equal(parseHumanSizeBytes("1024B"), 1024);
  });

  it("treats 0 and malformed input as 0", () => {
    assert.equal(parseHumanSizeBytes("0"), 0);
    assert.equal(parseHumanSizeBytes(""), 0);
    assert.equal(parseHumanSizeBytes("abc"), 0);
    assert.equal(parseHumanSizeBytes("-5MB"), 0);
  });

  it("clamps negative numeric input to 0 and floors fractional bytes", () => {
    assert.equal(parseHumanSizeBytes(-1), 0);
    assert.equal(parseHumanSizeBytes(123.7), 123);
    assert.equal(parseHumanSizeBytes("0.5KiB"), 512);
  });
});

describe("evictIfOverCap", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "och-evict-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  /**
   * Build N fake cache files of exactly `byteSize` bytes each, with
   * monotonically increasing mtimes (oldest = index 0). Files land in
   * the standard shard layout so {@link evictIfOverCap}'s walker finds
   * them. Returns the absolute paths in oldest-first order.
   */
  async function seedEntries(n: number, byteSize: number): Promise<string[]> {
    const buf = Buffer.alloc(byteSize, "x");
    const paths: string[] = [];
    const baseMs = 1_700_000_000_000; // arbitrary stable epoch
    for (let i = 0; i < n; i++) {
      // Distinct contentSha → distinct shard prefixes spread across buckets.
      const sha = `${i.toString(16).padStart(2, "0")}${"a".repeat(62)}`;
      const shard = sha.slice(0, 2);
      const filename = `${sha}-${"b".repeat(6)}-1.0.0.json`;
      const dir = path.join(cacheDir, shard);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, filename);
      await fs.writeFile(filePath, buf);
      // Force a deterministic mtime — older index → older mtime.
      const t = (baseMs + i * 1000) / 1000; // utimes takes seconds
      await fs.utimes(filePath, t, t);
      paths.push(filePath);
    }
    return paths;
  }

  async function existing(paths: readonly string[]): Promise<boolean[]> {
    return Promise.all(
      paths.map((p) =>
        fs
          .access(p)
          .then(() => true)
          .catch(() => false),
      ),
    );
  }

  it("evicts oldest entries until total ≤ 0.9 × cap (12 × 100 KiB under 1 MiB)", async () => {
    const ENTRY_SIZE = 100 * 1024; // 102_400
    const CAP = 1 << 20; // 1 MiB
    const paths = await seedEntries(12, ENTRY_SIZE);
    // Sanity: pre-eviction we are over cap.
    const before = await computeCacheSize(cacheDir);
    assert.equal(before.fileCount, 12);
    assert.equal(before.bytes, 12 * ENTRY_SIZE);

    await evictIfOverCap(cacheDir, CAP);

    // 0.9 × 1 MiB = 943_718. Max kept entries = floor(943_718 / 102_400) = 9.
    const present = await existing(paths);
    const keptCount = present.filter(Boolean).length;
    assert.equal(keptCount, 9);
    // Oldest 3 (indices 0..2) deleted; youngest 9 (indices 3..11) survive.
    for (let i = 0; i < 3; i++) {
      assert.equal(present[i], false, `expected oldest entry ${i} to be evicted`);
    }
    for (let i = 3; i < 12; i++) {
      assert.equal(present[i], true, `expected youngest entry ${i} to survive`);
    }
    const after = await computeCacheSize(cacheDir);
    assert.ok(after.bytes <= Math.floor(0.9 * CAP), "post-eviction total must be ≤ 0.9 × cap");
  });

  it("is idempotent — second call under cap does nothing", async () => {
    const ENTRY_SIZE = 100 * 1024;
    const CAP = 1 << 20;
    const paths = await seedEntries(12, ENTRY_SIZE);
    await evictIfOverCap(cacheDir, CAP);
    const firstPass = await computeCacheSize(cacheDir);

    await evictIfOverCap(cacheDir, CAP);
    const secondPass = await computeCacheSize(cacheDir);

    assert.equal(secondPass.fileCount, firstPass.fileCount);
    assert.equal(secondPass.bytes, firstPass.bytes);
    // Still the same 9 youngest entries.
    const present = await existing(paths);
    assert.equal(present.filter(Boolean).length, 9);
  });

  it("manual delete then re-evict does not delete more (still under cap)", async () => {
    const ENTRY_SIZE = 100 * 1024;
    const CAP = 1 << 20;
    const paths = await seedEntries(12, ENTRY_SIZE);
    await evictIfOverCap(cacheDir, CAP);
    // Manually delete one survivor (index 11 = newest).
    await fs.unlink(paths[11] as string);
    const before = await computeCacheSize(cacheDir);
    assert.equal(before.fileCount, 8);

    await evictIfOverCap(cacheDir, CAP);

    const after = await computeCacheSize(cacheDir);
    assert.equal(after.fileCount, 8, "no further eviction expected when under cap");
    assert.equal(after.bytes, before.bytes);
  });

  it("cap = 0 short-circuits — no entries removed", async () => {
    const ENTRY_SIZE = 100 * 1024;
    const paths = await seedEntries(12, ENTRY_SIZE);
    await evictIfOverCap(cacheDir, 0);
    const present = await existing(paths);
    assert.equal(present.filter(Boolean).length, 12);
  });

  it("missing cache dir is a silent no-op", async () => {
    const ghost = path.join(cacheDir, "does", "not", "exist");
    await assert.doesNotReject(() => evictIfOverCap(ghost, 1 << 20));
  });

  it("writeCacheEntry triggers LRU sweep when CODEHUB_PARSE_CACHE_MAX_BYTES is exceeded", async () => {
    const prev = process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"];
    // Tiny cap — every write past the first should trigger eviction.
    process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"] = "1KiB";
    try {
      // Pre-seed many large entries directly (bypass writeCacheEntry's own evict).
      const paths = await seedEntries(8, 1024);
      // Now do a writeCacheEntry — its post-write hook should sweep.
      const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
      await writeCacheEntry(cacheDir, key, sampleEntry());
      // Cap is 1024; target is 921. The freshly-written entry is youngest,
      // so after sweep at least the oldest seeded entries must be gone.
      const present = await existing(paths);
      assert.ok(
        present.filter(Boolean).length < 8,
        "expected at least some seeded entries to be evicted",
      );
      // Freshly-written entry must still be present (it is the newest).
      const back = await readCacheEntry(cacheDir, key);
      assert.ok(back, "newly-written entry must survive its own eviction sweep");
    } finally {
      if (prev === undefined) delete process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"];
      else process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"] = prev;
    }
  });

  it("CODEHUB_PARSE_CACHE_MAX_BYTES=0 disables sweep on writeCacheEntry", async () => {
    const prev = process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"];
    process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"] = "0";
    try {
      // Seed 8 KiB of fake entries, then write a real one. Disabled sweep
      // means everything stays.
      const paths = await seedEntries(8, 1024);
      const key = deriveCacheKey(SAMPLE_SHA, GRAMMAR_SHA, PIPELINE_VERSION);
      await writeCacheEntry(cacheDir, key, sampleEntry());
      const present = await existing(paths);
      assert.equal(present.filter(Boolean).length, 8, "all seeded entries must survive");
    } finally {
      if (prev === undefined) delete process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"];
      else process.env["CODEHUB_PARSE_CACHE_MAX_BYTES"] = prev;
    }
  });
});
