/**
 * Unit tests for the WASM-runtime global-failure detection.
 *
 * The load-bearing behavior: a globally-broken parse runtime (vendored
 * `vendor/wasms/` missing, or web-tree-sitter.wasm un-loadable) must surface as
 * a thrown {@link WasmRuntimeUnavailableError} — NOT a soft per-file skip that
 * lets `analyze` complete with a symbol-free skeleton graph and exit 0.
 *
 * `VENDOR_WASMS_DIR` is computed once at module load, so the global-detection
 * logic is split into the pure `assertRuntimeAvailable(dirExists, dir)` seam,
 * which we test directly without standing up Emscripten or mutating the const.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertRuntimeAvailable,
  vendorWasmsDirExists,
  WasmRuntimeUnavailableError,
} from "./wasm-runtime.js";

describe("assertRuntimeAvailable — global runtime probe", () => {
  it("throws WasmRuntimeUnavailableError naming the dir when vendored grammars are missing", () => {
    assert.throws(
      () => assertRuntimeAvailable(false, "/nope/vendor/wasms"),
      (err: unknown) => {
        assert.ok(err instanceof WasmRuntimeUnavailableError);
        assert.equal((err as Error).name, "WasmRuntimeUnavailableError");
        assert.match((err as Error).message, /\/nope\/vendor\/wasms/);
        return true;
      },
    );
  });

  it("does not throw when the vendored directory exists", () => {
    assert.doesNotThrow(() => assertRuntimeAvailable(true, "/anywhere"));
  });

  it("sets a name that survives structured-clone across the worker boundary", () => {
    // Piscina loses the subclass prototype across threads; the main thread must
    // be able to match on `name`. Constructing fresh confirms the name is set.
    const err = new WasmRuntimeUnavailableError("boom");
    assert.equal(err.name, "WasmRuntimeUnavailableError");
  });

  it("reports the real vendored dir as present in this (built) package", () => {
    // Sanity: the standalone ingestion build ships vendor/wasms, so the probe
    // is true here. This also guards the resolver — a regression that pointed
    // VENDOR_WASMS_DIR outside the package would flip this to false.
    assert.equal(vendorWasmsDirExists(), true);
  });
});
