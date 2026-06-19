/**
 * Unit tests for the scip-php adapter (davidrjenni/scip-php@v0.0.2).
 *
 * These tests assert on the shell plan + skip semantics without spawning the
 * real `scip-php` binary. A missing-binary skip test exercises `runIndexer`
 * with a bogus `$PATH` so `spawn` returns ENOENT, validating that when the
 * indexer binary is absent, analyze skips cleanly.
 *
 * CLI shape is VERIFIED against the v0.0.2 `bin/scip-php` source: argv is parsed
 * with `getopt('h', ['help', 'memory-limit:'])` — there is NO `index` subcommand
 * and NO output flag. Output is hardcoded to `index.scip` in the cwd. The plan
 * therefore carries NO args, and php is gated behind allowBuildScripts (Composer
 * autoload generation runs build scripts).
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
  return mkdtempSync(join(tmpdir(), "och-scip-php-"));
}

test("detectLanguages: composer.json at root adds 'php'", () => {
  const root = makeRoot();
  writeFileSync(join(root, "composer.json"), '{"name":"acme/app"}\n');
  assert.deepEqual(detectLanguages(root), ["php"]);
});

test("detectLanguages: empty root does not add 'php'", () => {
  const root = makeRoot();
  assert.deepEqual(detectLanguages(root), []);
});

test("detectLanguages: a TypeScript project alongside a composer.json surfaces both, ts first", () => {
  const root = makeRoot();
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "composer.json"), '{"name":"acme/app"}\n');
  // Deterministic positional order: typescript is detected first, php last.
  assert.deepEqual(detectLanguages(root), ["typescript", "php"]);
});

test("buildCommand('php', allowBuildScripts: false): skips with allowBuildScripts hint", () => {
  const root = makeRoot();
  const scipPath = join(root, ".codehub", "scip", "php.scip");
  const plan = buildCommand(
    "php",
    { projectRoot: root, outputDir: join(root, ".codehub", "scip"), allowBuildScripts: false },
    scipPath,
  );
  assert.equal(plan.cmd, "scip-php");
  assert.equal(plan.tool, "scip-php");
  assert.deepEqual(plan.args, []);
  assert.match(plan.skipReason ?? "", /allowBuildScripts=true/);
});

test("buildCommand('php', allowBuildScripts: true): emits scip-php with NO args (output is hardcoded to index.scip)", () => {
  const root = makeRoot();
  const scipPath = join(root, ".codehub", "scip", "php.scip");
  const plan = buildCommand(
    "php",
    { projectRoot: root, outputDir: join(root, ".codehub", "scip"), allowBuildScripts: true },
    scipPath,
  );
  assert.equal(plan.cmd, "scip-php");
  assert.equal(plan.tool, "scip-php");
  assert.equal(plan.cwd, root);
  // VERIFIED upstream: scip-php v0.0.2 takes no subcommand and no output flag —
  // it writes index.scip into the cwd. So the plan carries zero args; passing
  // `index --output <scipPath>` would be silently wrong.
  assert.deepEqual(plan.args, []);
  assert.equal(plan.skipReason, undefined, "opted-in php plan must not carry a skipReason");
});

test("runIndexer('php'): returns `skipped` when scip-php is missing from PATH", async () => {
  const root = makeRoot();
  // Force ENOENT by pointing PATH at an empty directory. Opt into build scripts
  // so we reach the spawn (and thus the missing-binary branch) rather than the
  // allowBuildScripts skip.
  const emptyBin = mkdtempSync(join(tmpdir(), "och-empty-bin-"));
  const result = await runIndexer("php", {
    projectRoot: root,
    outputDir: join(root, ".codehub", "scip"),
    allowBuildScripts: true,
    envOverlay: { PATH: emptyBin },
  });
  assert.equal(result.kind, "php");
  assert.equal(result.skipped, true);
  assert.equal(result.tool, "scip-php");
  assert.match(result.skipReason ?? "", /indexer binary not found: scip-php/);
});

test("scipUnofficialProvenanceReason('scip-php'): emits the Tier-1.5 prefix, NOT first-party scip:", () => {
  const reason = scipUnofficialProvenanceReason("scip-php", "0.0.2");
  assert.equal(reason, "scip-unofficial:scip-php@0.0.2");
  // Matches the Tier-1.5 set …
  assert.ok(
    SCIP_UNOFFICIAL_PROVENANCE_PREFIXES.some((p) => reason.startsWith(p)),
    "must match a scip-unofficial prefix",
  );
  // … and does NOT match the first-party oracle set.
  assert.ok(
    !SCIP_PROVENANCE_PREFIXES.some((p) => reason.startsWith(p)),
    "must NOT match a first-party scip: prefix",
  );
});

test("scipUnofficialProvenanceReason: blank version falls back to 'unknown'", () => {
  assert.equal(
    scipUnofficialProvenanceReason("scip-php", "   "),
    "scip-unofficial:scip-php@unknown",
  );
});
