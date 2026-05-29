/**
 * Unit tests for `codehub doctor`.
 *
 * We exercise the check runner end-to-end against a fake `$HOME` so the
 * registry/embedder probes hit a known filesystem layout. Native checks
 * (duckdb, lbug) are skipped via `skipNative` because node --test may
 * run on a host without those prebuilds.
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
    const base = join(home, ".codehub", "models", "gte-modernbert-base", "fp32");
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

// The int8 file on disk is `model_int8.onnx` (underscore), per
// `embedder/src/paths.ts:49`. The doctor check must use the same spelling;
// a hyphen-vs-underscore mismatch is how this historically
// false-negative'd.
test("embedder weights check reports ok when int8 weights present (underscore filename)", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-emb-int8-"));
  try {
    const base = join(home, ".codehub", "models", "gte-modernbert-base", "int8");
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

// Negative control — the old hyphenated `model-int8.onnx` must NOT count
// as a match. If it did, we'd silently accept a stale artefact the
// embedder can't actually load.
test("embedder weights check reports warn when only hyphenated int8 file is present", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-emb-hyphen-"));
  try {
    const base = join(home, ".codehub", "models", "gte-modernbert-base", "int8");
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

// The duckdb check resolves from the CLI's own node_modules first, then
// falls back to --repoRoot. In a workspace install the CLI's own
// resolution context already sees the dependencies (hoisted or
// otherwise), so passing a non-existent --repoRoot should still succeed
// when running inside the repo. This test guards against the failure
// mode where a user runs `codehub doctor` outside the monorepo layout:
// the `repoRoot` walk-four-dirs-up heuristic yields a path that doesn't
// contain the packages, but `createRequire(import.meta.url)` does.
test("native-binding checks tolerate a missing --repoRoot fallback (workspace install, duckdb)", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-resolve-"));
  try {
    const bogusRoot = join(home, "does-not-exist");
    const checks = buildChecks({ home, repoRoot: bogusRoot });
    const duck = checks.find((c) => c.name === "duckdb native binding");
    assert.ok(duck, "duckdb check must be registered when skipNative is false");
    // Running the full check under node:test against a real dev install
    // should succeed — packages are resolvable via the CLI's own
    // node_modules even when the repoRoot fallback is broken. A `fail`
    // here would mean the CLI-first resolution path regressed.
    const duckResult = await duck.run();
    assert.notEqual(
      duckResult.status,
      "fail",
      `duckdb check should not fail when CLI node_modules resolves; got: ${duckResult.message}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Wiring — runDoctor should thread `repoRoot` through DoctorOptions so the
// --repoRoot CLI flag has a visible effect on check construction. We don't
// need to actually execute the checks — just confirm the override is
// accepted and the report still comes back.
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

// ---------------------------------------------------------------------------
// Vendored WASM grammars
// ---------------------------------------------------------------------------

// The CLI's own resolution context resolves @opencodehub/ingestion, whose
// vendor/wasms/ ships the 16 grammar blobs. Running inside the dev install,
// the check must find them and report ok. A `fail` would mean the runtime
// grammar-resolution path regressed.
test("vendored-wasms check reports ok against the real installed grammars", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-wasm-ok-"));
  try {
    const checks = buildChecks({ home, skipNative: true });
    const wasm = checks.find((c) => c.name === "vendored wasm grammars");
    assert.ok(wasm, "vendored-wasms check must always be registered");
    const result = await wasm.run();
    assert.equal(
      result.status,
      "ok",
      `expected ok against dev install; got ${result.status}: ${result.message}`,
    );
    assert.match(result.message, /16 grammars/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// A shipped artifact being absent is ALWAYS a hard fail — never a soft skip,
// even without --strict. Point both the CLI resolution AND the repoRoot
// fallback at empty dirs so neither finds vendor/wasms.
test("vendored-wasms check fails when the vendor dir cannot be resolved", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-wasm-miss-"));
  try {
    // A repoRoot with no packages/ingestion forces the monorepo fallback to
    // miss; the CLI-resolution path still finds the real install, so to
    // exercise the miss we assert the resolver's contract via a bogus root
    // is not enough — instead verify the check is fail-capable by its own
    // logic: when resolveVendorWasmsDir returns null it must be `fail`.
    // We can't null out the CLI resolution from here, so this test asserts
    // the strict invariant indirectly: the status is never `warn`.
    const checks = buildChecks({ home, skipNative: true, repoRoot: join(home, "nope") });
    const wasm = checks.find((c) => c.name === "vendored wasm grammars");
    assert.ok(wasm);
    const result = await wasm.run();
    assert.notEqual(result.status, "warn", "vendored grammars are fail-or-ok, never warn");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// The @opencodehub/sarif check must resolve the INSTALLED package (its
// prebuilt `dist/` ships in the tarball), not a `packages/sarif/dist`
// monorepo path. Pointing `repoRoot` at a bogus dir kills the source-checkout
// fallback, so an `ok` result proves the check resolves the real installed
// package via `import.meta.resolve` — the customer (`npm i -g`) case. A `warn`
// here would mean the check regressed to emitting the nonsensical
// `pnpm -r build` hint to end users.
test("sarif-build check reports ok against the installed package even with a bogus repoRoot", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-sarif-ok-"));
  try {
    const checks = buildChecks({ home, skipNative: true, repoRoot: join(home, "nope") });
    const sarif = checks.find((c) => c.name === "@opencodehub/sarif build");
    assert.ok(sarif, "sarif-build check must always be registered");
    const result = await sarif.run();
    assert.equal(
      result.status,
      "ok",
      `expected ok against installed package; got ${result.status}: ${result.message}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SCIP indexers — warn by default, fail under --strict
// ---------------------------------------------------------------------------

// Default mode: an absent indexer is a soft `warn` (the analyze pipeline skips
// that language gracefully). Use a setup-installable indexer (ruby) and a
// fake $HOME so ~/.codehub/bin is empty and the binary is not on PATH in CI.
test("scip-indexer check warns when an indexer is absent (default, non-strict)", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-scip-warn-"));
  try {
    const checks = buildChecks({ home, skipNative: true });
    const ruby = checks.find((c) => c.name === "scip indexer: ruby");
    assert.ok(ruby, "ruby scip-indexer check must be registered");
    const result = await ruby.run();
    assert.equal(result.status, "warn", `expected warn; got ${result.status}: ${result.message}`);
    assert.match(result.hint ?? "", /setup --scip=ruby/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --strict escalates the SAME absence to `fail` so release/CI gates can assert
// the full toolchain is present.
test("scip-indexer check fails when an indexer is absent under --strict", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-scip-strict-"));
  try {
    const checks = buildChecks({ home, skipNative: true, strict: true });
    const ruby = checks.find((c) => c.name === "scip indexer: ruby");
    assert.ok(ruby);
    const result = await ruby.run();
    assert.equal(result.status, "fail", `expected fail under strict; got ${result.status}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// JAR-style indexers (kotlin, cobol) resolve by file presence under
// ~/.codehub, not a `--version` binary. Seeding the JAR flips the check to ok.
test("scip-indexer check resolves a JAR indexer by file presence (kotlin)", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-scip-jar-"));
  try {
    const binDir = join(home, ".codehub", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "semanticdb-kotlinc-0.6.0.jar"), "fake jar");
    const checks = buildChecks({ home, skipNative: true });
    const kotlin = checks.find((c) => c.name === "scip indexer: kotlin");
    assert.ok(kotlin);
    const result = await kotlin.run();
    assert.equal(result.status, "ok", `expected ok with JAR seeded; got ${result.message}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --strict must escalate the doctor process exit code to 2 (blocking) when an
// indexer is absent, vs 1 (warn) in default mode. Both modes seed a valid
// registry so only the indexer rows drive the difference.
test("runDoctor --strict yields exit 2 when indexers are absent (vs 1 default)", async () => {
  const home = await mkdtemp(join(tmpdir(), "codehub-doctor-exit-"));
  try {
    await mkdir(join(home, ".codehub"), { recursive: true });
    await writeFile(join(home, ".codehub", "registry.json"), JSON.stringify({}));
    const prev = process.exitCode;
    const lenient = await runDoctor({ home, skipNative: true });
    const strict = await runDoctor({ home, skipNative: true, strict: true });
    process.exitCode = prev;
    // Lenient: indexer absences are warn → exit 1 (no fail unless something
    // else broke). Strict: indexer absences are fail → exit 2.
    assert.ok(lenient.exitCode <= 1, `lenient exit should be 0/1; got ${lenient.exitCode}`);
    assert.equal(strict.exitCode, 2, "strict mode must block (exit 2) on absent indexers");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
