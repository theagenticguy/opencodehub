/**
 * Unit tests for the scip-dart adapter (Workiva/scip-dart@1.6.2).
 *
 * These tests assert on the shell plan + skip semantics without spawning the
 * real indexer. A missing-binary skip test exercises `runIndexer` with a bogus
 * `$PATH` so `spawn` returns ENOENT, validating a clean skip when the indexer
 * is absent.
 *
 * CLI shape is VERIFIED against the 1.6.2 `pubspec.yaml` + `bin/scip_dart.dart`
 * source:
 *   - The installed binary is `scip_dart` (UNDERSCORE), per the pubspec
 *     `executables:` block — NOT `scip-dart`. The spawn literal matches.
 *   - ArgParser: `addOption('output', abbr: 'o', defaultsTo: 'index.scip')` plus
 *     a positional project root → `scip_dart --output <scipPath> <cwd>`.
 * dart is gated behind allowBuildScripts (`dart pub get` resolves the pubspec).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SCIP_PROVENANCE_PREFIXES,
  SCIP_UNOFFICIAL_PROVENANCE_PREFIXES,
} from "@opencodehub/core-types";
import { scipUnofficialProvenanceReason } from "../provenance.js";
import { buildCommand, detectLanguages, runIndexer } from "./index.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "och-scip-dart-"));
}

test("detectLanguages: pubspec.yaml at root adds 'dart'", () => {
  const root = makeRoot();
  writeFileSync(join(root, "pubspec.yaml"), "name: my_app\n");
  assert.deepEqual(detectLanguages(root), ["dart"]);
});

test("detectLanguages: empty root does not add 'dart'", () => {
  const root = makeRoot();
  assert.deepEqual(detectLanguages(root), []);
});

test("detectLanguages: a TypeScript project alongside a pubspec.yaml surfaces both, ts first", () => {
  const root = makeRoot();
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "pubspec.yaml"), "name: my_app\n");
  // Deterministic positional order: typescript first, dart last.
  assert.deepEqual(detectLanguages(root), ["typescript", "dart"]);
});

test("detectLanguages: php + dart manifests surface in fixed order (php before dart)", () => {
  const root = makeRoot();
  writeFileSync(join(root, "composer.json"), '{"name":"acme/app"}\n');
  writeFileSync(join(root, "pubspec.yaml"), "name: my_app\n");
  assert.deepEqual(detectLanguages(root), ["php", "dart"]);
});

test("buildCommand('dart', allowBuildScripts: false): skips with allowBuildScripts hint", () => {
  const root = makeRoot();
  const scipPath = join(root, ".codehub", "scip", "dart.scip");
  const plan = buildCommand(
    "dart",
    { projectRoot: root, outputDir: join(root, ".codehub", "scip"), allowBuildScripts: false },
    scipPath,
  );
  // The real binary is `scip_dart` (underscore); `tool` keeps the display name.
  assert.equal(plan.cmd, "scip_dart");
  assert.equal(plan.tool, "scip-dart");
  assert.deepEqual(plan.args, []);
  assert.match(plan.skipReason ?? "", /allowBuildScripts=true/);
});

test("buildCommand('dart', allowBuildScripts: true): emits `scip_dart --output <scipPath> <cwd>`", () => {
  const root = makeRoot();
  const scipPath = join(root, ".codehub", "scip", "dart.scip");
  const plan = buildCommand(
    "dart",
    { projectRoot: root, outputDir: join(root, ".codehub", "scip"), allowBuildScripts: true },
    scipPath,
  );
  // VERIFIED upstream: scip_dart supports `--output <path>` and a positional
  // project root, so output IS directed to dart.scip (unlike scip-php).
  assert.equal(plan.cmd, "scip_dart");
  assert.equal(plan.tool, "scip-dart");
  assert.equal(plan.cwd, root);
  assert.deepEqual(plan.args, ["--output", scipPath, root]);
  assert.equal(plan.skipReason, undefined, "opted-in dart plan must not carry a skipReason");
});

test("runIndexer('dart'): returns `skipped` when scip_dart is missing from PATH", async () => {
  const root = makeRoot();
  const emptyBin = mkdtempSync(join(tmpdir(), "och-empty-bin-"));
  const result = await runIndexer("dart", {
    projectRoot: root,
    outputDir: join(root, ".codehub", "scip"),
    allowBuildScripts: true,
    envOverlay: { PATH: emptyBin },
  });
  assert.equal(result.kind, "dart");
  assert.equal(result.skipped, true);
  assert.equal(result.tool, "scip-dart");
  // The missing-binary message names the spawned literal (`scip_dart`).
  assert.match(result.skipReason ?? "", /indexer binary not found: scip_dart/);
});

test("scipUnofficialProvenanceReason('scip-dart'): emits the Tier-1.5 prefix, NOT first-party scip:", () => {
  const reason = scipUnofficialProvenanceReason("scip-dart", "1.6.2");
  assert.equal(reason, "scip-unofficial:scip-dart@1.6.2");
  assert.ok(
    SCIP_UNOFFICIAL_PROVENANCE_PREFIXES.some((p) => reason.startsWith(p)),
    "must match a scip-unofficial prefix",
  );
  assert.ok(
    !SCIP_PROVENANCE_PREFIXES.some((p) => reason.startsWith(p)),
    "must NOT match a first-party scip: prefix",
  );
});
