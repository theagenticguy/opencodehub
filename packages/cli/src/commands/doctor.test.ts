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
