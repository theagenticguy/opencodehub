/**
 * Tests for `resolveVendorWasmsDir` — the walk-up probe that locates
 * `vendor/wasms/` across every emitted layout the ingestion code runs in.
 *
 * This is the bug class that shipped a `codehub analyze` which produced a
 * graph with NO parsed code symbols: the prior fixed two-levels-up offset
 * (`../../vendor/wasms`) was calibrated for the standalone ingestion build
 * (`dist/parse/`) and resolved to a nonexistent path once the code was inlined
 * into the flat `@opencodehub/cli` bundle (`dist/` root, no `parse/` subdir).
 * The WASM parser then threw ENOENT and the pipeline silently degraded.
 *
 * Synthetic-tree tests pin the resolver against both layouts; a drift guard
 * confirms it lands on the real vendored directory shipped with this package.
 */

import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolveVendorWasmsDir } from "./vendor-wasms.js";

async function mkTree(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-vendor-wasms-"));
}

test("resolveVendorWasmsDir: standalone build — vendor/wasms two levels up from dist/parse", async () => {
  const root = await mkTree();
  try {
    // <root>/dist/parse/wasm-runtime.js  +  <root>/vendor/wasms/
    const parseDir = join(root, "dist", "parse");
    await mkdir(parseDir, { recursive: true });
    await mkdir(join(root, "vendor", "wasms"), { recursive: true });
    const moduleUrl = pathToFileURL(join(parseDir, "wasm-runtime.js")).href;
    assert.equal(resolveVendorWasmsDir(moduleUrl), join(root, "vendor", "wasms"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveVendorWasmsDir: flat CLI bundle — vendor/wasms is a sibling at the dist root", async () => {
  const root = await mkTree();
  try {
    // <root>/dist/parse-worker.js (flat, no parse/ subdir)  +  <root>/dist/vendor/wasms/
    const distDir = join(root, "dist");
    await mkdir(join(distDir, "vendor", "wasms"), { recursive: true });
    const moduleUrl = pathToFileURL(join(distDir, "parse-worker.js")).href;
    assert.equal(resolveVendorWasmsDir(moduleUrl), join(distDir, "vendor", "wasms"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveVendorWasmsDir: source checkout — finds vendor/wasms at the package root", async () => {
  const root = await mkTree();
  try {
    // <root>/src/parse/wasm-runtime.ts  +  <root>/vendor/wasms/
    const srcParse = join(root, "src", "parse");
    await mkdir(srcParse, { recursive: true });
    await mkdir(join(root, "vendor", "wasms"), { recursive: true });
    const moduleUrl = pathToFileURL(join(srcParse, "wasm-runtime.ts")).href;
    assert.equal(resolveVendorWasmsDir(moduleUrl), join(root, "vendor", "wasms"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Drift guard: from THIS test module (compiled to dist-test/parse/), the
// resolver must still find the real vendored grammars shipped at the package
// root. This is what the CLI bundle relies on after inlining the ingestion
// code into its flat dist/.
test("drift guard: resolveVendorWasmsDir locates the real vendored grammars", () => {
  const resolved = resolveVendorWasmsDir(import.meta.url);
  assert.ok(statSync(resolved).isDirectory(), `expected a directory at ${resolved}`);
  assert.ok(
    statSync(join(resolved, "web-tree-sitter.wasm")).isFile(),
    "web-tree-sitter.wasm runtime must ship in vendor/wasms/",
  );
  assert.ok(
    statSync(join(resolved, "manifest.json")).isFile(),
    "manifest.json must ship in vendor/wasms/",
  );
  // Sanity: the resolved path actually ends in vendor/wasms.
  assert.equal(dirname(resolved).endsWith("vendor") || resolved.endsWith("wasms"), true);
});
