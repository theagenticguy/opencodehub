/**
 * Tests for the layout-agnostic asset resolver.
 *
 * Two layers:
 *
 *  1. Synthetic-tree unit tests pin the WALK-UP behaviour against every
 *     emitted-module layout the CLI ships in — flat post-collapse bundle,
 *     nested pre-collapse bundle, and raw source checkout. This is the exact
 *     bug class that shipped a broken `codehub init`: a fixed `..` depth is
 *     correct for one layout and silently wrong for the others.
 *
 *  2. A drift guard runs the SAME candidate lists the production resolvers use
 *     against the REAL built `dist/` tree. The prior init/ci-init tests all
 *     injected `sourceDir` or walked to the source `plugins/` tree, so the
 *     default resolvers were never exercised against the emitted bundle — see
 *     the "doctor-probe drift after rip-and-replace" lesson. This guard skips
 *     (loudly) when `dist/` is absent rather than passing vacuously.
 */

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAsset } from "./asset-resolver.js";

async function mkTree(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-asset-resolver-"));
}

// Candidate lists copied verbatim from the production resolvers so the unit
// tests fail if a resolver's candidates drift away from what is tested here.
const PLUGIN_CANDIDATES = [["plugin-assets"], ["plugins", "opencodehub"]] as const;
const CI_TEMPLATE_CANDIDATES = [
  ["commands", "ci-templates"],
  ["ci-templates"],
  ["src", "commands", "ci-templates"],
] as const;

test("resolveAsset: flat post-collapse bundle — finds dist/plugin-assets as a sibling", async () => {
  const root = await mkTree();
  try {
    // <root>/dist/init-<hash>.js  +  <root>/dist/plugin-assets/
    const distDir = join(root, "dist");
    await mkdir(join(distDir, "plugin-assets"), { recursive: true });
    const resolved = resolveAsset(PLUGIN_CANDIDATES, { startDir: distDir });
    assert.equal(resolved, join(distDir, "plugin-assets"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAsset: nested pre-collapse bundle — finds plugin-assets one level up", async () => {
  const root = await mkTree();
  try {
    // <root>/dist/commands/init.js  +  <root>/dist/plugin-assets/
    const commandsDir = join(root, "dist", "commands");
    await mkdir(commandsDir, { recursive: true });
    await mkdir(join(root, "dist", "plugin-assets"), { recursive: true });
    const resolved = resolveAsset(PLUGIN_CANDIDATES, { startDir: commandsDir });
    assert.equal(resolved, join(root, "dist", "plugin-assets"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAsset: source checkout — finds plugins/opencodehub at the repo root", async () => {
  const root = await mkTree();
  try {
    // <root>/packages/cli/src/commands/init.ts  +  <root>/plugins/opencodehub/
    const srcCommands = join(root, "packages", "cli", "src", "commands");
    await mkdir(srcCommands, { recursive: true });
    await mkdir(join(root, "plugins", "opencodehub"), { recursive: true });
    const resolved = resolveAsset(PLUGIN_CANDIDATES, { startDir: srcCommands });
    assert.equal(resolved, join(root, "plugins", "opencodehub"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAsset: bundle-first — prefers plugin-assets over a coincidental source match", async () => {
  const root = await mkTree();
  try {
    // Both present: the bundle path is a closer sibling AND earlier in the
    // candidate list, so it must win.
    const distDir = join(root, "dist");
    await mkdir(join(distDir, "plugin-assets"), { recursive: true });
    await mkdir(join(distDir, "plugins", "opencodehub"), { recursive: true });
    const resolved = resolveAsset(PLUGIN_CANDIDATES, { startDir: distDir });
    assert.equal(resolved, join(distDir, "plugin-assets"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAsset: ci-templates flat bundle — finds commands/ci-templates one level down", async () => {
  const root = await mkTree();
  try {
    // Flat bundle: module at <root>/dist/ci-init-<hash>.js; templates copied to
    // <root>/dist/commands/ci-templates/. The pre-fix sibling probe missed this.
    const distDir = join(root, "dist");
    await mkdir(join(distDir, "commands", "ci-templates"), { recursive: true });
    const resolved = resolveAsset(CI_TEMPLATE_CANDIDATES, { startDir: distDir });
    assert.equal(resolved, join(distDir, "commands", "ci-templates"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAsset: file kind — locates a single config file, not just dirs", async () => {
  const root = await mkTree();
  try {
    const distDir = join(root, "dist");
    await mkdir(join(distDir, "config"), { recursive: true });
    await writeFile(join(distDir, "config", "betterleaks.default.toml"), "# test\n");
    const resolved = resolveAsset([["config", "betterleaks.default.toml"]], {
      startDir: distDir,
      kind: "file",
    });
    assert.equal(resolved, join(distDir, "config", "betterleaks.default.toml"));
    // A dir-kind probe must NOT match the file.
    const asDir = resolveAsset([["config", "betterleaks.default.toml"]], {
      startDir: distDir,
      kind: "dir",
      maxLevels: 1,
    });
    assert.equal(asDir, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAsset: returns null when no candidate exists within maxLevels", async () => {
  const root = await mkTree();
  try {
    const deep = join(root, "a", "b", "c");
    await mkdir(deep, { recursive: true });
    const resolved = resolveAsset([["does-not-exist"]], { startDir: deep, maxLevels: 2 });
    assert.equal(resolved, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAsset: accepts a file:// URL via fromFileUrl", async () => {
  const root = await mkTree();
  try {
    const distDir = join(root, "dist");
    await mkdir(join(distDir, "plugin-assets"), { recursive: true });
    const fakeModule = pathToFileURL(join(distDir, "init-abc123.js")).href;
    const resolved = resolveAsset(PLUGIN_CANDIDATES, { fromFileUrl: fakeModule });
    assert.equal(resolved, join(distDir, "plugin-assets"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- drift guard
// Locate the real built `dist/` tree by walking up from this test module to the
// `packages/cli` package root. Tests compile to `dist-test/`, so walk up and
// check the sibling `dist/`.
function findBuiltDist(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    // The cli package root holds both `dist/` and `package.json`.
    const candidate = join(dir, "dist", "index.js");
    try {
      if (statSync(candidate).isFile()) return join(dir, "dist");
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const BUILT_DIST = findBuiltDist();

test("drift guard: production resolver candidates hit real files in the built dist/", {
  skip: BUILT_DIST === null ? "dist/ not built (run `pnpm -F @opencodehub/cli build`)" : false,
}, () => {
  const dist = BUILT_DIST as string;
  // Each resolver must land on an existing path when started from `dist/`
  // (the flat-bundle layout the emitted modules actually run in).
  const plugin = resolveAsset(PLUGIN_CANDIDATES, { startDir: dist });
  assert.equal(plugin, join(dist, "plugin-assets"), "init/setup plugin source");
  assert.ok(
    statSync(join(plugin as string, "skills")).isDirectory(),
    "plugin-assets/skills must ship (codehub init copies it)",
  );
  assert.ok(
    statSync(join(plugin as string, ".claude-plugin", "plugin.json")).isFile(),
    "plugin-assets/.claude-plugin/plugin.json must ship (setup --plugin needs it)",
  );

  const templates = resolveAsset(CI_TEMPLATE_CANDIDATES, { startDir: dist });
  assert.equal(templates, join(dist, "commands", "ci-templates"), "ci-init templates");

  const config = resolveAsset([["config", "betterleaks.default.toml"]], {
    startDir: dist,
    kind: "file",
  });
  assert.equal(
    config,
    join(dist, "config", "betterleaks.default.toml"),
    "betterleaks default config",
  );
});
