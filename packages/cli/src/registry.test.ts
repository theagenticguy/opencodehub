import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearRegistry,
  findRegistryEntryByPath,
  type RepoEntry,
  readRegistry,
  removeFromRegistry,
  resolveRegistryFile,
  upsertRegistry,
} from "./registry.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-cli-registry-"));
}

function entry(overrides: Partial<RepoEntry> = {}): RepoEntry {
  return {
    name: overrides.name ?? "demo",
    path: overrides.path ?? "/tmp/demo",
    indexedAt: overrides.indexedAt ?? "2026-04-18T10:00:00Z",
    nodeCount: overrides.nodeCount ?? 10,
    edgeCount: overrides.edgeCount ?? 20,
    ...(overrides.lastCommit !== undefined ? { lastCommit: overrides.lastCommit } : {}),
  };
}

test("readRegistry returns {} when the file is absent", async () => {
  const home = await scratch();
  const result = await readRegistry({ home });
  assert.deepEqual(result, {});
});

test("upsertRegistry creates the file and round-trips entries", async () => {
  const home = await scratch();
  const a = entry({ name: "alpha", path: "/tmp/alpha" });
  const b = entry({ name: "bravo", path: "/tmp/bravo", lastCommit: "abc1234" });
  await upsertRegistry(a, { home });
  await upsertRegistry(b, { home });

  const round = await readRegistry({ home });
  assert.equal(Object.keys(round).length, 2);
  assert.deepEqual(round["alpha"], a);
  assert.deepEqual(round["bravo"], b);
});

test("upsertRegistry replaces an existing entry in place", async () => {
  const home = await scratch();
  await upsertRegistry(entry({ name: "x", nodeCount: 1 }), { home });
  await upsertRegistry(entry({ name: "x", nodeCount: 99 }), { home });
  const round = await readRegistry({ home });
  assert.equal(round["x"]?.nodeCount, 99);
});

test("registry file is sorted by key for deterministic output", async () => {
  const home = await scratch();
  await upsertRegistry(entry({ name: "zulu" }), { home });
  await upsertRegistry(entry({ name: "alpha" }), { home });
  await upsertRegistry(entry({ name: "mike" }), { home });
  const raw = await readFile(resolveRegistryFile({ home }), "utf8");
  const alphaIdx = raw.indexOf('"alpha"');
  const mikeIdx = raw.indexOf('"mike"');
  const zuluIdx = raw.indexOf('"zulu"');
  assert.ok(alphaIdx < mikeIdx && mikeIdx < zuluIdx, "keys should be alphabetical");
});

test("removeFromRegistry drops exactly one entry", async () => {
  const home = await scratch();
  await upsertRegistry(entry({ name: "keep" }), { home });
  await upsertRegistry(entry({ name: "drop" }), { home });
  await removeFromRegistry("drop", { home });
  const round = await readRegistry({ home });
  assert.ok(round["keep"]);
  assert.equal(round["drop"], undefined);
});

test("removeFromRegistry is a no-op when the key is absent", async () => {
  const home = await scratch();
  await upsertRegistry(entry({ name: "keep" }), { home });
  await removeFromRegistry("ghost", { home });
  const round = await readRegistry({ home });
  assert.equal(Object.keys(round).length, 1);
});

test("clearRegistry empties the file", async () => {
  const home = await scratch();
  await upsertRegistry(entry({ name: "a" }), { home });
  await upsertRegistry(entry({ name: "b" }), { home });
  await clearRegistry({ home });
  const round = await readRegistry({ home });
  assert.deepEqual(round, {});
});

test("findRegistryEntryByPath matches exact paths", async () => {
  const home = await scratch();
  const path = "/tmp/match-me";
  await upsertRegistry(entry({ name: "match", path }), { home });
  const hit = await findRegistryEntryByPath(path, { home });
  assert.equal(hit?.name, "match");
});

test("readRegistry tolerates concurrent upserts by serializing at the call site", async () => {
  // This asserts that sequential awaits don't corrupt the file — the simplest
  // safety net for our use case. We don't promise per-key concurrent writes.
  const home = await scratch();
  for (let i = 0; i < 5; i += 1) {
    await upsertRegistry(entry({ name: `entry${i}`, nodeCount: i }), { home });
  }
  const round = await readRegistry({ home });
  assert.equal(Object.keys(round).length, 5);
});
