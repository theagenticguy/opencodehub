/**
 * Native vs WASM runtime detection.
 *
 * Tree-sitter 0.25.0 ships prebuilt `.node` binaries for every MVP target
 * (darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64).
 * WASM is a fallback for exotic environments (musl/Alpine, Cloudflare Workers,
 * sandboxed Electron renderers) where `.node` loading is disallowed.
 *
 * MVP status: native is the only wired path. If the native require() throws,
 * `isNativeAvailable()` returns false and a warning is logged — but a
 * production WASM bridge is NOT implemented at this time.
 *
 * TODO(wave-5): wire web-tree-sitter + per-grammar `.wasm` loading end-to-end.
 *   - Bundle each grammar's `.wasm` with this package or resolve from the
 *     installed `tree-sitter-<lang>` package (all seven ship a `.wasm` next to
 *     their `bindings/node/index.js`).
 *   - Mirror the unified query execution path using `web-tree-sitter`'s
 *     Parser/Language/Query APIs.
 *   - Preserve identical capture output (research doc §determinism notes the
 *     logical tree is identical native vs WASM per language).
 */

import { createRequire } from "node:module";

const requireFn = createRequire(import.meta.url);

let cached: boolean | undefined;

/**
 * Returns true when `require('tree-sitter')` succeeds in the current process.
 * Result is cached — subsequent calls are O(1).
 *
 * Call this at worker startup rather than on every parse.
 */
export function isNativeAvailable(): boolean {
  if (cached !== undefined) {
    return cached;
  }
  try {
    requireFn("tree-sitter");
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * For tests and diagnostics: reset the cached detection result.
 */
export function resetNativeAvailabilityCache(): void {
  cached = undefined;
}
