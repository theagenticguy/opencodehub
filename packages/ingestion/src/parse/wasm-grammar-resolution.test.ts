/**
 * Unit tests for `resolveGrammarWasmPath` — the single declarative
 * LanguageId-to-filename map that locates each grammar's `.wasm` inside
 * the vendored directory at `packages/ingestion/vendor/wasms/`.
 *
 * Asserted properties:
 *   - Every supported `LanguageId` resolves to an absolute path under
 *     `vendor/wasms/` ending in the expected filename.
 *   - The resolved paths point to files that actually exist on disk
 *     (verifies the commit + build-script loop landed correctly).
 *   - PHP resolves to the `php_only` variant (pure PHP, no HTML
 *     injection) — matches the prior native-loader behavior.
 *   - C# resolves to `tree-sitter-c_sharp.wasm` (underscore, not hyphen).
 *   - Cobol returns `undefined` (regex-provider language; no grammar).
 */

import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { _resolveGrammarWasmPathForTests } from "./wasm-runtime.js";

const EXPECTED: Readonly<Record<string, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  swift: "tree-sitter-swift.wasm",
  dart: "tree-sitter-dart.wasm",
  php: "tree-sitter-php_only.wasm",
};

describe("resolveGrammarWasmPath — vendored WASM resolver", () => {
  for (const [lang, fname] of Object.entries(EXPECTED)) {
    it(`resolves ${lang} to vendor/wasms/${fname} on disk`, () => {
      const wasmPath = _resolveGrammarWasmPathForTests(lang as never);
      assert.ok(wasmPath !== undefined, `expected a path for ${lang}, got undefined`);
      assert.ok(path.isAbsolute(wasmPath), `expected absolute path for ${lang}, got ${wasmPath}`);
      assert.ok(
        wasmPath.endsWith(fname),
        `expected path ending in ${fname}, got ${wasmPath}`,
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

describe("resolveGrammarWasmPath — non-tree-sitter languages", () => {
  it("cobol returns undefined (regex-provider language; no tree-sitter grammar)", () => {
    const wasmPath = _resolveGrammarWasmPathForTests("cobol");
    assert.equal(wasmPath, undefined);
  });
});
