/**
 * Locate the vendored `vendor/wasms/` directory at runtime.
 *
 * The 15 GA grammar `.wasm` blobs, `web-tree-sitter.wasm`, and `manifest.json`
 * are vendored under `packages/ingestion/vendor/wasms/` and loaded at runtime —
 * `web-tree-sitter` reads them by absolute path, so esbuild never sees them.
 *
 * This module runs in two very different emitted layouts, and a fixed `..`
 * depth is correct for only one of them:
 *
 *   - Standalone `@opencodehub/ingestion` build: the emitted module sits at
 *     `<pkg>/dist/parse/wasm-runtime.js`, so `vendor/wasms/` is two levels up.
 *   - Inlined into the `@opencodehub/cli` bundle: tsup force-bundles every
 *     `@opencodehub/*` workspace lib (`noExternal`) and emits flat chunks at
 *     the `dist/` root (`dist/parse-worker.js`, `dist/chunk-<hash>.js`) — there
 *     is no `dist/parse/` subdir. tsup copies the grammars to `<cli>/dist/
 *     vendor/wasms/`. From the flat layout the old two-levels-up offset
 *     resolved to `<cli-parent>/vendor/wasms` (outside `dist/`, nonexistent),
 *     so the WASM parser threw ENOENT and `codehub analyze` silently produced a
 *     graph with no parsed code symbols. The `doctor.ts` vendor-wasms probe in
 *     the CLI already used a walk-up and was immune; this mirrors it.
 *
 * Walk UP from this module probing `vendor/wasms/` at each level; the first
 * existing directory wins. Layout-agnostic, so it resolves correctly from the
 * standalone build, the flat CLI bundle, the test build, and a source checkout.
 * Computed once at module load. Falls back to the conventional two-up path so a
 * downstream open error names the directory we expected.
 */

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isDirSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the `vendor/wasms/` directory for the running deployment. */
export function resolveVendorWasmsDir(fromFileUrl: string): string {
  let dir = dirname(fileURLToPath(fromFileUrl));
  for (let level = 0; level <= 10; level += 1) {
    const candidate = resolve(dir, "vendor", "wasms");
    if (isDirSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Neither layout present — return the conventional standalone-build path so a
  // downstream read error names the directory we expected.
  return resolve(dirname(fileURLToPath(fromFileUrl)), "..", "..", "vendor", "wasms");
}
