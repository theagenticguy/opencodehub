/**
 * Unit tests for the scip-ruby adapter (v0.4.7).
 *
 * These tests assert on the shell plan + skip semantics without spawning the
 * real `scip-ruby` binary. A missing-binary skip test exercises `runIndexer`
 * with a bogus `$PATH` so `spawn` returns ENOENT, validating the S-M4-1
 * state requirement: when the indexer binary is absent, analyze must skip
 * cleanly with a setup hint.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCommand, detectLanguages, runIndexer } from "./index.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "och-scip-ruby-"));
}

test("detectLanguages: Gemfile at root adds 'ruby'", () => {
  const root = makeRoot();
  writeFileSync(join(root, "Gemfile"), "source 'https://rubygems.org'\n");
  assert.deepEqual(detectLanguages(root), ["ruby"]);
});

test("detectLanguages: Gemfile.lock at root adds 'ruby'", () => {
  const root = makeRoot();
  writeFileSync(join(root, "Gemfile.lock"), "GEM\n");
  assert.deepEqual(detectLanguages(root), ["ruby"]);
});

test("detectLanguages: Rakefile at root adds 'ruby'", () => {
  const root = makeRoot();
  writeFileSync(join(root, "Rakefile"), "task :default\n");
  assert.deepEqual(detectLanguages(root), ["ruby"]);
});

test("detectLanguages: *.gemspec at root adds 'ruby'", () => {
  const root = makeRoot();
  writeFileSync(join(root, "my-gem.gemspec"), "Gem::Specification.new do |s| end\n");
  assert.deepEqual(detectLanguages(root), ["ruby"]);
});

test("detectLanguages: sorbet/config at root adds 'ruby'", () => {
  const root = makeRoot();
  mkdirSync(join(root, "sorbet"));
  writeFileSync(join(root, "sorbet", "config"), "--dir\n.\n");
  assert.deepEqual(detectLanguages(root), ["ruby"]);
});

test("detectLanguages: empty root does not add 'ruby'", () => {
  const root = makeRoot();
  assert.deepEqual(detectLanguages(root), []);
});

test("detectLanguages: a TypeScript project alongside a Gemfile surfaces both", () => {
  const root = makeRoot();
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "Gemfile"), "source 'https://rubygems.org'\n");
  assert.deepEqual(detectLanguages(root), ["typescript", "ruby"]);
});

test("buildCommand('ruby'): emits --index-file with `.` positional when sorbet/config is absent", () => {
  const root = makeRoot();
  const scipPath = join(root, ".codehub", "scip", "ruby.scip");
  const plan = buildCommand(
    "ruby",
    { projectRoot: root, outputDir: join(root, ".codehub", "scip") },
    scipPath,
  );
  assert.equal(plan.cmd, "scip-ruby");
  assert.equal(plan.tool, "scip-ruby");
  assert.equal(plan.versionCmd, "scip-ruby");
  assert.deepEqual(plan.versionArgs, ["--version"]);
  assert.equal(plan.cwd, root);
  assert.deepEqual(plan.args, ["--index-file", scipPath, "."]);
  assert.equal(plan.skipReason, undefined);
});

test("buildCommand('ruby'): omits the `.` positional when sorbet/config is present", () => {
  const root = makeRoot();
  mkdirSync(join(root, "sorbet"));
  writeFileSync(join(root, "sorbet", "config"), "--dir\n.\n");
  const scipPath = join(root, ".codehub", "scip", "ruby.scip");
  const plan = buildCommand(
    "ruby",
    { projectRoot: root, outputDir: join(root, ".codehub", "scip") },
    scipPath,
  );
  // sorbet/config present → scip-ruby reads the file list from there; no
  // positional path arg is appended.
  assert.deepEqual(plan.args, ["--index-file", scipPath]);
});

test("buildCommand('ruby'): forwards --gem-metadata when projectName is set", () => {
  const root = makeRoot();
  const scipPath = join(root, ".codehub", "scip", "ruby.scip");
  const plan = buildCommand(
    "ruby",
    { projectRoot: root, outputDir: join(root, ".codehub", "scip"), projectName: "my_gem" },
    scipPath,
  );
  // projectName flows into --gem-metadata so downstream SCIP edges carry a
  // stable cross-repo identifier even without Gemfile.lock.
  assert.deepEqual(plan.args, ["--index-file", scipPath, "--gem-metadata", "my_gem@0.0.0", "."]);
});

test("runIndexer('ruby'): returns `skipped` with a setup hint when scip-ruby is missing from PATH", async () => {
  const root = makeRoot();
  // Force ENOENT by pointing PATH at an empty directory. The isolated PATH
  // overlay lives in envOverlay rather than mutating process.env so parallel
  // tests stay unaffected.
  const emptyBin = mkdtempSync(join(tmpdir(), "och-empty-bin-"));
  const result = await runIndexer("ruby", {
    projectRoot: root,
    outputDir: join(root, ".codehub", "scip"),
    envOverlay: { PATH: emptyBin },
  });
  assert.equal(result.kind, "ruby");
  assert.equal(result.skipped, true);
  assert.equal(result.tool, "scip-ruby");
  assert.match(result.skipReason ?? "", /indexer binary not found: scip-ruby/);
});
