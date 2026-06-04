/**
 * Tests for the cobol-proleap gating logic.
 *
 * We cannot spawn a JVM in CI, so these tests exercise the gating surface:
 *   - Without `--allow-build-scripts=proleap` the runner skips with a
 *     clear "falling back to regex" reason.
 *   - With the flag but no JAR installed, the runner skips with the
 *     missing-jar hint pointing at `codehub setup --cobol-proleap`.
 *   - With flag + JAR present, the runner activates (skipped=false).
 *
 * The scip-java / rust / python / go branches are already covered by the
 * broader test suite; this file focuses only on the new kind.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALLOWED_COMMANDS,
  defaultCobolProleapPaths,
  detectVersionManagerShimFailure,
  isAllowedCommand,
  runIndexer,
} from "./index.js";

test("isAllowedCommand: every command buildCommand emits is on the spawn allowlist", () => {
  // The spawn boundary (runCommand) refuses anything outside ALLOWED_COMMANDS.
  // These are the exact executables buildCommand / the dotnet probe / the
  // Kotlin `sh -c` chain hand off to it. If buildCommand gains a new indexer
  // without allowlisting it, runCommand would reject it at runtime — this
  // test pins the contract so that surfaces here first.
  for (const cmd of [
    "scip-typescript",
    "scip-python",
    "scip-go",
    "scip-java",
    "scip-clang",
    "scip-ruby",
    "scip-dotnet",
    "cobol-proleap",
    "kotlinc",
    "rust-analyzer",
    "dotnet",
    "sh",
  ]) {
    assert.equal(isAllowedCommand(cmd), true, `${cmd} must be allowlisted`);
  }
});

test("isAllowedCommand: rejects an arbitrary or injected command", () => {
  for (const bad of ["bash", "rm", "/bin/sh", "scip-typescript; rm -rf /", "", "node"]) {
    assert.equal(isAllowedCommand(bad), false, `${bad} must be rejected`);
  }
  // The allowlist is a closed set, not a prefix/substring match.
  assert.equal(ALLOWED_COMMANDS.has("scip-typescript "), false);
});

test("runIndexer(cobol-proleap): skips with fallback message when opt-in is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scip-ingest-"));
  const res = await runIndexer("cobol-proleap", {
    projectRoot: dir,
    outputDir: dir,
  });
  assert.equal(res.kind, "cobol-proleap");
  assert.equal(res.skipped, true);
  assert.match(res.skipReason ?? "", /--allow-build-scripts=proleap/);
  assert.match(res.skipReason ?? "", /falling back to regex/);
});

test("runIndexer(cobol-proleap): skips with missing-JAR hint when opted in but not installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scip-ingest-"));
  const res = await runIndexer("cobol-proleap", {
    projectRoot: dir,
    outputDir: dir,
    allowedBuildScripts: ["proleap"],
    cobolProleapJarPath: "/definitely-not-installed.jar",
  });
  assert.equal(res.skipped, true);
  assert.match(res.skipReason ?? "", /JAR not found/);
  assert.match(res.skipReason ?? "", /codehub setup --cobol-proleap/);
});

test("runIndexer(cobol-proleap): activates when opted in and JAR exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scip-ingest-"));
  const jarPath = join(dir, "proleap-cobol-parser.jar");
  // Content is irrelevant — the runner only checks for existence.
  writeFileSync(jarPath, "JAR");
  const res = await runIndexer("cobol-proleap", {
    projectRoot: dir,
    outputDir: dir,
    allowedBuildScripts: ["proleap"],
    cobolProleapJarPath: jarPath,
  });
  assert.equal(res.skipped, false);
  assert.equal(res.kind, "cobol-proleap");
  assert.equal(res.tool, "cobol-proleap");
});

test("runIndexer(cobol-proleap): legacy allowBuildScripts=true also activates (with JAR)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scip-ingest-"));
  const jarPath = join(dir, "proleap-cobol-parser.jar");
  writeFileSync(jarPath, "JAR");
  const res = await runIndexer("cobol-proleap", {
    projectRoot: dir,
    outputDir: dir,
    allowBuildScripts: true,
    cobolProleapJarPath: jarPath,
  });
  assert.equal(res.skipped, false);
});

test("runIndexer: a timed-out indexer becomes a graceful skip, not a crash", {
  skip: process.platform === "win32" ? "POSIX shim shell only" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "scip-ingest-"));
  const bin = mkdtempSync(join(tmpdir(), "scip-ingest-bin-"));
  // Shim a `scip-go` that exits fast for the `--version` probe but hangs
  // for the index invocation, so the spawn timer is the only thing that
  // can end it.
  const shim = join(bin, "scip-go");
  // Hang for the index invocation using ONLY shell builtins, so the shim needs
  // no external binary on PATH. A pure-`sh` busy `while`-loop blocks until the
  // spawn timer SIGTERMs it (~50 ms), which is the behavior under test.
  //
  // Why not `sleep 30`: CI runners whose `/bin/sh` is dash, with an overlaid
  // PATH that excludes coreutils, hit `sleep: not found` → the shim exited 127
  // before the timer fired, so the timeout path was never exercised (it failed
  // as a crash). Why not `read < /dev/stdin`: `runCommand` spawns with
  // `stdio: ["ignore", …]`, so stdin is /dev/null and `read` returns instantly
  // on EOF — racing the timer instead of blocking on it.
  writeFileSync(
    shim,
    '#!/bin/sh\ncase "$1" in\n  --version) echo "scip-go 0.0.0-test"; exit 0 ;;\nesac\nwhile :; do :; done\n',
  );
  chmodSync(shim, 0o755);

  const res = await runIndexer("go", {
    projectRoot: dir,
    outputDir: dir,
    timeoutMs: 50,
    envOverlay: { PATH: bin },
  });

  assert.equal(res.kind, "go");
  assert.equal(res.skipped, true);
  assert.match(res.skipReason ?? "", /exceeded 50ms/);
  assert.match(res.skipReason ?? "", /terminated/);
});

test("defaultCobolProleapPaths: resolves under ~/.codehub/vendor/proleap", () => {
  const home = "/Users/alice";
  const paths = defaultCobolProleapPaths(home);
  // Build expectations with `join` (the impl uses it), so the separator
  // matches the platform — a hardcoded forward-slash literal fails on Windows.
  const wrapperDir = join(home, ".codehub", "vendor", "proleap");
  assert.equal(paths.jarPath, join(wrapperDir, "proleap-cobol-parser.jar"));
  assert.equal(paths.wrapperDir, wrapperDir);
});

test("detectVersionManagerShimFailure: matches the mise no-version-set shim error", () => {
  const stderr =
    "mise ERROR No version is set for shim: scip-python\n" +
    "Set a global default version with one of the following:\n" +
    "mise use -g node@22.22.0\n" +
    "mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information";
  const reason = detectVersionManagerShimFailure("scip-python", stderr);
  assert.ok(reason !== undefined, "should detect the mise shim failure");
  assert.match(reason ?? "", /version-manager shim/);
  assert.match(reason ?? "", /mise use scip-python@latest/);
  assert.match(reason ?? "", /Skipping scip-python/);
});

test("detectVersionManagerShimFailure: matches an asdf no-version-set error", () => {
  const reason = detectVersionManagerShimFailure(
    "scip-python",
    "No version is set for command scip-python\nConsider adding one of the following...",
  );
  assert.ok(reason !== undefined);
  assert.match(reason ?? "", /version-manager shim/);
});

test("detectVersionManagerShimFailure: ignores a genuine indexer crash", () => {
  // A real scip-python crash (traceback) must NOT be treated as a shim
  // failure — it should still throw upstream so the operator sees it.
  const stderr =
    "Traceback (most recent call last):\n" +
    '  File "scip_python/main.py", line 42, in <module>\n' +
    "SyntaxError: invalid syntax in module foo.py";
  assert.equal(detectVersionManagerShimFailure("scip-python", stderr), undefined);
});
