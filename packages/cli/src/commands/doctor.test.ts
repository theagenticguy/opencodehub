/**
 * Unit tests for `codehub doctor`.
 *
 * We exercise the check runner end-to-end against a fake `$HOME` so the
 * registry/embedder probes hit a known filesystem layout. Native checks
 * (tree-sitter, duckdb) are skipped via `skipNative` because node --test
 * may run on a host without those prebuilds.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildChecks, runDoctor } from "./doctor.js";

test("runDoctor emits a non-empty report with --skip-native", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-"));
  try {
    // Seed a valid registry so that check flips to ok.
    await mkdir(join(home, ".codehub"), { recursive: true });
    await writeFile(join(home, ".codehub", "registry.json"), JSON.stringify({}));
    const prevExitCode = process.exitCode;
    const report = await runDoctor({ home, skipNative: true });
    process.exitCode = prevExitCode;
    assert.ok(report.rows.length >= 4);
    const names = report.rows.map((r) => r.name);
    assert.ok(names.includes("node >= 20"));
    assert.ok(names.includes("registry path"));
    assert.ok(report.exitCode === 0 || report.exitCode === 1 || report.exitCode === 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registry check reports ok when registry.json is an object", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-reg-"));
  try {
    await mkdir(join(home, ".codehub"), { recursive: true });
    await writeFile(
      join(home, ".codehub", "registry.json"),
      JSON.stringify({
        sample: {
          name: "sample",
          path: "/tmp/x",
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
        },
      }),
    );
    const checks = buildChecks({ home, skipNative: true });
    const registryCheck = checks.find((c) => c.name === "registry path");
    assert.ok(registryCheck);
    const result = await registryCheck.run();
    assert.equal(result.status, "ok");
    assert.match(result.message, /1 repo/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registry check reports warn when registry.json is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-miss-"));
  try {
    const checks = buildChecks({ home, skipNative: true });
    const registryCheck = checks.find((c) => c.name === "registry path");
    assert.ok(registryCheck);
    const result = await registryCheck.run();
    assert.equal(result.status, "warn");
    assert.ok(result.hint && result.hint.length > 0, "missing registry should suggest a fix");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registry check reports fail when registry.json is malformed", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-bad-"));
  try {
    await mkdir(join(home, ".codehub"), { recursive: true });
    await writeFile(join(home, ".codehub", "registry.json"), "[]");
    const checks = buildChecks({ home, skipNative: true });
    const registryCheck = checks.find((c) => c.name === "registry path");
    assert.ok(registryCheck);
    const result = await registryCheck.run();
    assert.equal(result.status, "fail");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("embedder weights check reports warn when no model present", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-emb-"));
  try {
    const checks = buildChecks({ home, skipNative: true });
    const embedderCheck = checks.find((c) => c.name === "embedder weights");
    assert.ok(embedderCheck);
    const result = await embedderCheck.run();
    assert.equal(result.status, "warn");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("embedder weights check reports ok when fp32 weights present", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-emb-ok-"));
  try {
    const base = join(home, ".codehub", "models", "arctic-embed-xs");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "model.onnx"), "fake weights");
    const checks = buildChecks({ home, skipNative: true });
    const embedderCheck = checks.find((c) => c.name === "embedder weights");
    assert.ok(embedderCheck);
    const result = await embedderCheck.run();
    assert.equal(result.status, "ok");
    assert.match(result.message, /fp32/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// DOC-E-002 — the int8 file on disk is `model_int8.onnx` (underscore),
// per `embedder/src/paths.ts:49`. The doctor check must use the same
// spelling; a hyphen-vs-underscore mismatch is how this historically
// false-negative'd.
test("embedder weights check reports ok when int8 weights present (underscore filename)", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-emb-int8-"));
  try {
    const base = join(home, ".codehub", "models", "arctic-embed-xs");
    await mkdir(base, { recursive: true });
    // Canonical filename from embedder/src/paths.ts:modelFileName("int8").
    await writeFile(join(base, "model_int8.onnx"), "fake int8 weights");
    const checks = buildChecks({ home, skipNative: true });
    const embedderCheck = checks.find((c) => c.name === "embedder weights");
    assert.ok(embedderCheck);
    const result = await embedderCheck.run();
    assert.equal(result.status, "ok");
    assert.match(result.message, /int8/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// DOC-E-002 (negative control) — the old hyphenated `model-int8.onnx`
// must NOT count as a match. If it did, we'd silently accept a stale
// artefact the embedder can't actually load.
test("embedder weights check reports warn when only hyphenated int8 file is present", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-emb-hyphen-"));
  try {
    const base = join(home, ".codehub", "models", "arctic-embed-xs");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "model-int8.onnx"), "wrong filename");
    const checks = buildChecks({ home, skipNative: true });
    const embedderCheck = checks.find((c) => c.name === "embedder weights");
    assert.ok(embedderCheck);
    const result = await embedderCheck.run();
    assert.equal(result.status, "warn");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// DOC-E-001 — the tree-sitter and duckdb checks resolve from the CLI's own
// node_modules first, then fall back to --repoRoot. In a workspace install
// the CLI's own resolution context already sees the dependencies (hoisted
// or otherwise), so passing a non-existent --repoRoot should still succeed
// when running inside the repo. This test guards against the failure mode
// where a user runs `codehub doctor` outside the monorepo layout: the
// `repoRoot` walk-four-dirs-up heuristic yields a path that doesn't
// contain the packages, but `createRequire(import.meta.url)` does.
test("native-binding checks tolerate a missing --repoRoot fallback (workspace install)", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-resolve-"));
  try {
    const bogusRoot = join(home, "does-not-exist");
    const checks = buildChecks({ home, repoRoot: bogusRoot });
    const ts = checks.find((c) => c.name === "tree-sitter native binding");
    const duck = checks.find((c) => c.name === "duckdb native binding");
    assert.ok(ts, "tree-sitter check must be registered when skipNative is false");
    assert.ok(duck, "duckdb check must be registered when skipNative is false");
    // Running the full check under node:test against a real dev install
    // should succeed — packages are resolvable via the CLI's own
    // node_modules even when the repoRoot fallback is broken. A `fail`
    // here would mean the CLI-first resolution path regressed.
    const tsResult = await ts.run();
    const duckResult = await duck.run();
    assert.notEqual(
      tsResult.status,
      "fail",
      `tree-sitter check should not fail when CLI node_modules resolves; got: ${tsResult.message}`,
    );
    assert.notEqual(
      duckResult.status,
      "fail",
      `duckdb check should not fail when CLI node_modules resolves; got: ${duckResult.message}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// DOC-E-001 (wiring) — runDoctor should thread `repoRoot` through
// DoctorOptions so the --repoRoot CLI flag has a visible effect on check
// construction. We don't need to actually execute the checks — just
// confirm the override is accepted and the report still comes back.
test("runDoctor accepts --repoRoot override via DoctorOptions", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-reporoot-"));
  try {
    await mkdir(join(home, ".codehub"), { recursive: true });
    await writeFile(join(home, ".codehub", "registry.json"), JSON.stringify({}));
    const prevExitCode = process.exitCode;
    const report = await runDoctor({ home, skipNative: true, repoRoot: home });
    process.exitCode = prevExitCode;
    assert.ok(report.rows.length >= 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
