/**
 * Unit tests for `resolveGrammarWasmPath` — the two-stage cascade that
 * maps a `LanguageId` to a bundled `.wasm` asset path.
 *
 * Stage 1 (per-grammar package) is exercised by the parse-worker /
 * wasm-parity suites via real `openWasmParser` calls. This file
 * focuses on stage 2: the vendored-WASM fallback at
 * `packages/ingestion/vendor/wasms/` which handles kotlin, swift, and
 * dart — whose per-grammar `tree-sitter-*` packages do NOT ship a
 * `.wasm` alongside the `.node` addon.
 *
 * Asserted properties:
 *   - kotlin/swift/dart resolve to absolute paths ending in
 *     `tree-sitter-<lang>.wasm` inside `vendor/wasms/`.
 *   - The resolved paths point to files that actually exist on disk
 *     (verifies the commit + build-script loop landed correctly).
 *   - A known per-grammar-package entry (python) still resolves — the
 *     refactor must not regress the 11-entry primary mapping.
 *   - PHP resolves to the `php_only` variant (AC-4 invariant).
 */

import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { _resolveGrammarWasmPathForTests } from "./wasm-fallback.js";

describe("resolveGrammarWasmPath — vendored WASM fallback", () => {
  for (const lang of ["kotlin", "swift", "dart"] as const) {
    it(`resolves ${lang} to an existing vendor/wasms/tree-sitter-${lang}.wasm`, () => {
      const wasmPath = _resolveGrammarWasmPathForTests(lang);
      assert.ok(wasmPath !== undefined, `expected a path for ${lang}, got undefined`);
      assert.ok(path.isAbsolute(wasmPath), `expected absolute path for ${lang}, got ${wasmPath}`);
      assert.ok(
        wasmPath.endsWith(`tree-sitter-${lang}.wasm`),
        `expected path ending in tree-sitter-${lang}.wasm, got ${wasmPath}`,
      );
      assert.ok(
        wasmPath.includes(`${path.sep}vendor${path.sep}wasms${path.sep}`),
        `expected path under vendor/wasms/, got ${wasmPath}`,
      );
      const stat = statSync(wasmPath);
      assert.ok(stat.isFile(), `expected file at ${wasmPath}`);
      assert.ok(stat.size > 0, `expected non-empty wasm at ${wasmPath}`);
    });
  }
});

describe("resolveGrammarWasmPath — per-grammar package path unchanged", () => {
  it("python still resolves from its own tree-sitter-python package", () => {
    const wasmPath = _resolveGrammarWasmPathForTests("python");
    assert.ok(wasmPath !== undefined);
    assert.ok(wasmPath.endsWith("tree-sitter-python.wasm"));
    assert.ok(
      !wasmPath.includes(`${path.sep}vendor${path.sep}wasms${path.sep}`),
      `python must resolve from its own package, not the vendor dir: ${wasmPath}`,
    );
  });

  it("php resolves to php_only.wasm (AC-4 invariant)", () => {
    const wasmPath = _resolveGrammarWasmPathForTests("php");
    assert.ok(wasmPath !== undefined);
    assert.ok(
      wasmPath.endsWith("tree-sitter-php_only.wasm"),
      `php must resolve to php_only.wasm, got ${wasmPath}`,
    );
  });
});
