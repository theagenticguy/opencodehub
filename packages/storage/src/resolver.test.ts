/**
 * AC-A-9: tests for the async backend resolver + dual-artifact detection.
 *
 * The sync `resolveStoreBackend` env-var resolution lives next door in
 * `graphdb-adapter.test.ts:141-161`. This file covers the new surface:
 *
 *   - `resolveStoreBackendAsync` — the AC-A-9 default-flip resolver.
 *   - `detectDualArtifacts` — the newer-mtime-wins helper.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  _resetStoreResolverCache,
  detectDualArtifacts,
  resolveStoreBackendAsync,
} from "./index.js";

beforeEach(() => {
  _resetStoreResolverCache();
});

afterEach(() => {
  _resetStoreResolverCache();
});

// ---------------------------------------------------------------------------
// resolveStoreBackendAsync
// ---------------------------------------------------------------------------

test("resolveStoreBackendAsync: explicit backend bypasses the probe", async () => {
  let probeCalls = 0;
  const probe = async () => {
    probeCalls++;
    return true;
  };
  assert.equal(await resolveStoreBackendAsync("duck", {}, probe), "duck");
  assert.equal(await resolveStoreBackendAsync("lbug", {}, probe), "lbug");
  assert.equal(probeCalls, 0);
});

test("resolveStoreBackendAsync: env CODEHUB_STORE wins over probe", async () => {
  let probeCalls = 0;
  const probe = async () => {
    probeCalls++;
    return true;
  };
  assert.equal(await resolveStoreBackendAsync("auto", { CODEHUB_STORE: "duck" }, probe), "duck");
  assert.equal(await resolveStoreBackendAsync("auto", { CODEHUB_STORE: "lbug" }, probe), "lbug");
  assert.equal(probeCalls, 0);
});

test("resolveStoreBackendAsync: auto + unset + probe success → lbug", async () => {
  const probe = async () => true;
  assert.equal(await resolveStoreBackendAsync("auto", {}, probe), "lbug");
  // undefined backend is treated as auto.
  assert.equal(await resolveStoreBackendAsync(undefined, {}, probe), "lbug");
});

test("resolveStoreBackendAsync: auto + unset + probe failure → duck (silent in non-TTY)", async () => {
  const probe = async () => false;
  // No TTY, no OCH_VERBOSE → no stderr emitted, just falls back.
  assert.equal(await resolveStoreBackendAsync("auto", {}, probe), "duck");
});

test("resolveStoreBackendAsync: invalid CODEHUB_STORE rejects", async () => {
  const probe = async () => true;
  await assert.rejects(
    () => resolveStoreBackendAsync("auto", { CODEHUB_STORE: "sqlite" }, probe),
    /Invalid CODEHUB_STORE/,
  );
});

test("resolveStoreBackendAsync: rejects in-tree-unsupported community backends", async () => {
  const probe = async () => true;
  await assert.rejects(
    () => resolveStoreBackendAsync("age" as never, {}, probe),
    /reserved for community adapters/,
  );
});

// ---------------------------------------------------------------------------
// detectDualArtifacts
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "och-dual-artifact-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function touch(file: string, mtime: Date): void {
  writeFileSync(file, "");
  utimesSync(file, mtime, mtime);
}

test("detectDualArtifacts: in-memory paths short-circuit", async () => {
  assert.equal(await detectDualArtifacts(":memory:", ":memory:", "duck", {}), "duck");
  assert.equal(await detectDualArtifacts(":memory:", ":memory:", "lbug", {}), "lbug");
});

test("detectDualArtifacts: only one file present → backend unchanged", async () => {
  const duckPath = join(tmpDir, "graph.duckdb");
  touch(duckPath, new Date(2026, 0, 1));
  // Backend resolved to lbug; lbug file does not exist; respect the
  // resolution. The factory will create the lbug file later.
  assert.equal(await detectDualArtifacts(duckPath, duckPath, "lbug", {}), "lbug");
});

test("detectDualArtifacts: both present, duckdb newer → wins", async () => {
  const duckPath = join(tmpDir, "graph.duckdb");
  const lbugPath = join(tmpDir, "graph.lbug");
  // duck mtime newer than lbug.
  touch(lbugPath, new Date(2026, 0, 1));
  touch(duckPath, new Date(2026, 0, 5));
  assert.equal(
    await detectDualArtifacts(lbugPath, join(tmpDir, "temporal.duckdb"), "lbug", {}),
    "duck",
  );
});

test("detectDualArtifacts: both present, lbug newer → wins", async () => {
  const duckPath = join(tmpDir, "graph.duckdb");
  const lbugPath = join(tmpDir, "graph.lbug");
  // lbug mtime newer than duck.
  touch(duckPath, new Date(2026, 0, 1));
  touch(lbugPath, new Date(2026, 0, 5));
  assert.equal(await detectDualArtifacts(duckPath, duckPath, "duck", {}), "lbug");
});

test("detectDualArtifacts: both present, override emits one-shot advisory under OCH_VERBOSE=1", async () => {
  const duckPath = join(tmpDir, "graph.duckdb");
  const lbugPath = join(tmpDir, "graph.lbug");
  touch(lbugPath, new Date(2026, 0, 1));
  touch(duckPath, new Date(2026, 0, 5));

  let captured = "";
  const original = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: stderr.write monkey-patch needs a cast
  (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
    captured += chunk.toString();
    return true;
  };
  try {
    assert.equal(
      await detectDualArtifacts(lbugPath, lbugPath, "lbug", { OCH_VERBOSE: "1" }),
      "duck",
    );
    // Second call must not double-emit (one-shot guard).
    assert.equal(
      await detectDualArtifacts(lbugPath, lbugPath, "lbug", { OCH_VERBOSE: "1" }),
      "duck",
    );
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore monkey-patch
    (process.stderr as any).write = original;
  }
  assert.match(captured, /both graph\.duckdb and graph\.lbug found/);
  // Single occurrence.
  assert.equal(captured.match(/found in/g)?.length, 1);
});
