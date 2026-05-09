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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultCobolProleapPaths, runIndexer } from "./index.js";

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

test("defaultCobolProleapPaths: resolves under ~/.codehub/vendor/proleap", () => {
  const paths = defaultCobolProleapPaths("/Users/alice");
  assert.equal(paths.jarPath, "/Users/alice/.codehub/vendor/proleap/proleap-cobol-parser.jar");
  assert.equal(paths.wrapperDir, "/Users/alice/.codehub/vendor/proleap");
});
