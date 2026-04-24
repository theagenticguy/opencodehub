import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoreMeta } from "./interface.js";
import { readStoreMeta, writeStoreMeta } from "./meta.js";
import { resolveMetaFilePath } from "./paths.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-storage-meta-"));
}

test("readStoreMeta returns undefined when meta.json is absent", async () => {
  const dir = await scratch();
  const result = await readStoreMeta(dir);
  assert.equal(result, undefined);
});

test("writeStoreMeta → readStoreMeta round-trips all fields", async () => {
  const dir = await scratch();
  const meta: StoreMeta = {
    schemaVersion: "1.0.0",
    lastCommit: "abc123",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 42,
    edgeCount: 128,
    stats: { files: 7, functions: 21 },
  };
  await writeStoreMeta(dir, meta);
  const roundTripped = await readStoreMeta(dir);
  assert.deepEqual(roundTripped, meta);
});

test("writeStoreMeta omits lastCommit and stats when absent", async () => {
  const dir = await scratch();
  const meta: StoreMeta = {
    schemaVersion: "1.0.0",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 0,
    edgeCount: 0,
  };
  await writeStoreMeta(dir, meta);
  const raw = await readFile(resolveMetaFilePath(dir), "utf8");
  assert.ok(!raw.includes("lastCommit"), "lastCommit should be absent");
  assert.ok(!raw.includes("stats"), "stats should be absent");
  const roundTripped = await readStoreMeta(dir);
  assert.deepEqual(roundTripped, meta);
});

test("writeStoreMeta is atomic: no stray temp file is left behind", async () => {
  const dir = await scratch();
  await writeStoreMeta(dir, {
    schemaVersion: "1.0.0",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 1,
    edgeCount: 0,
  });
  const contents = await readdir(join(dir, ".codehub"));
  const tmpLeftovers = contents.filter((entry) => entry.includes(".tmp-"));
  assert.deepEqual(tmpLeftovers, [], "no .tmp- files should remain");
});

test("writeStoreMeta sorts the stats object keys for byte-stable output", async () => {
  const dir = await scratch();
  await writeStoreMeta(dir, {
    schemaVersion: "1.0.0",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 1,
    edgeCount: 0,
    stats: { zeta: 1, alpha: 2, mu: 3 },
  });
  const raw = await readFile(resolveMetaFilePath(dir), "utf8");
  const statsIdx = raw.indexOf('"stats"');
  const statsBlock = raw.slice(statsIdx);
  const alphaIdx = statsBlock.indexOf("alpha");
  const muIdx = statsBlock.indexOf("mu");
  const zetaIdx = statsBlock.indexOf("zeta");
  assert.ok(alphaIdx < muIdx && muIdx < zetaIdx, "stats keys should be alphabetized");
});

test("readStoreMeta throws on invalid payload", async () => {
  const dir = await scratch();
  const target = resolveMetaFilePath(dir);
  // Pre-create the directory so writeFile doesn't ENOENT.
  await writeStoreMeta(dir, {
    schemaVersion: "1.0.0",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 0,
    edgeCount: 0,
  });
  await writeFile(target, JSON.stringify({ foo: 1 }));
  await assert.rejects(async () => {
    await readStoreMeta(dir);
  }, /meta\.json/);
});

test("writeStoreMeta → readStoreMeta round-trips v1.1 cache fields", async () => {
  const dir = await scratch();
  const meta: StoreMeta = {
    schemaVersion: "1.1.0",
    lastCommit: "deadbeef",
    indexedAt: "2026-04-18T12:00:00Z",
    nodeCount: 99,
    edgeCount: 200,
    stats: { files: 5 },
    cacheHitRatio: 0.82,
    cacheSizeBytes: 2048576,
    lastCompaction: "2026-04-18T10:00:00Z",
  };
  await writeStoreMeta(dir, meta);
  const roundTripped = await readStoreMeta(dir);
  assert.deepEqual(roundTripped, meta);
});

test("writeStoreMeta omits cache fields when absent (v1.0 payload stays byte-stable)", async () => {
  const dir = await scratch();
  const meta: StoreMeta = {
    schemaVersion: "1.1.0",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 1,
    edgeCount: 2,
  };
  await writeStoreMeta(dir, meta);
  const raw = await readFile(resolveMetaFilePath(dir), "utf8");
  assert.ok(!raw.includes("cacheHitRatio"), "cacheHitRatio should be absent");
  assert.ok(!raw.includes("cacheSizeBytes"), "cacheSizeBytes should be absent");
  assert.ok(!raw.includes("lastCompaction"), "lastCompaction should be absent");
});

test("writeStoreMeta preserves canonical field ordering with v1.1 cache fields", async () => {
  const dir = await scratch();
  await writeStoreMeta(dir, {
    schemaVersion: "1.1.0",
    lastCommit: "abc",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 3,
    edgeCount: 4,
    stats: { a: 1 },
    cacheHitRatio: 0.5,
    cacheSizeBytes: 123,
    lastCompaction: "2026-04-18T09:00:00Z",
  });
  const raw = await readFile(resolveMetaFilePath(dir), "utf8");
  const expected = [
    '"schemaVersion"',
    '"lastCommit"',
    '"indexedAt"',
    '"nodeCount"',
    '"edgeCount"',
    '"stats"',
    '"cacheHitRatio"',
    '"cacheSizeBytes"',
    '"lastCompaction"',
  ];
  let prev = -1;
  for (const key of expected) {
    const idx = raw.indexOf(key);
    assert.ok(idx !== -1, `${key} missing from payload`);
    assert.ok(idx > prev, `${key} must follow previous field in canonical order`);
    prev = idx;
  }
});

test("readStoreMeta rejects wrong types for v1.1 cache fields", async () => {
  const dir = await scratch();
  const target = resolveMetaFilePath(dir);
  await writeStoreMeta(dir, {
    schemaVersion: "1.1.0",
    indexedAt: "2026-04-18T10:00:00Z",
    nodeCount: 0,
    edgeCount: 0,
  });
  await writeFile(
    target,
    JSON.stringify({
      schemaVersion: "1.1.0",
      indexedAt: "2026-04-18T10:00:00Z",
      nodeCount: 0,
      edgeCount: 0,
      cacheHitRatio: "not-a-number",
    }),
  );
  await assert.rejects(async () => {
    await readStoreMeta(dir);
  }, /cacheHitRatio/);
});
