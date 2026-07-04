/**
 * Extension-parity pin for the pipeline phases' language detection.
 *
 * The cross-file and mro phases used to each carry a private
 * `inferLanguageFromFile` extension→language switch (a verbatim clone of the
 * `EXTENSION_MAP` in `parse/language-detector.ts`). Those copies were deleted
 * in favour of the canonical {@link detectLanguage}. This test locks the
 * contract that the swap preserved every call-site's post-switch behaviour:
 *
 *   1. Every extension the two local switches handled resolves to the SAME
 *      `LanguageId` under `detectLanguage` (the mro switch's 16-member table;
 *      cross-file's 15-member table was the same MINUS cobol).
 *   2. cobol (.cbl/.cob/.cpy) is now covered — this is the one intentional
 *      widening (cross-file's local switch silently omitted it). The
 *      determinism gate in `incremental-determinism.test.ts` proves the
 *      widening does not move the graph hash.
 *   3. Multi-dot paths (e.g. `.d.ts`) resolve by the LAST extension, matching
 *      the local switches' `lastIndexOf(".")` behaviour on realistic
 *      repo-relative paths.
 *
 * If someone changes `EXTENSION_MAP` and drops one of these mappings, this
 * pin fails loudly at the phase boundary rather than silently altering which
 * provider a file resolves to during cross-file re-resolution.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { LanguageId } from "@opencodehub/core-types";
import { detectLanguage } from "../../parse/language-detector.js";

/**
 * The exact extension→LanguageId contract the deleted `inferLanguageFromFile`
 * switch in `mro.ts` returned (the superset — 16 members incl cobol). The
 * cross-file copy was byte-identical minus the three cobol cases.
 */
const MRO_SWITCH_CONTRACT: ReadonlyArray<readonly [string, LanguageId]> = [
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".cs", "csharp"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
  [".rb", "ruby"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".swift", "swift"],
  [".php", "php"],
  [".php3", "php"],
  [".php4", "php"],
  [".php5", "php"],
  [".php7", "php"],
  [".phtml", "php"],
  [".dart", "dart"],
];

/** Extensions cross-file's inline union OMITTED — now covered (the widening). */
const COBOL_WIDENING: ReadonlyArray<readonly [string, LanguageId]> = [
  [".cbl", "cobol"],
  [".cob", "cobol"],
  [".cpy", "cobol"],
];

describe("pipeline language-detection parity (detectLanguage replaces the local switches)", () => {
  it("reproduces the deleted mro inferLanguageFromFile switch for every extension", () => {
    for (const [ext, expected] of MRO_SWITCH_CONTRACT) {
      assert.equal(
        detectLanguage(`src/file${ext}`),
        expected,
        `detectLanguage drifted from the mro switch on ${ext}`,
      );
      // Case-insensitivity — the local switch lower-cased the extension.
      assert.equal(
        detectLanguage(`src/file${ext.toUpperCase()}`),
        expected,
        `detectLanguage lost case-insensitivity on ${ext}`,
      );
    }
  });

  it("covers cobol — the one extension cross-file's local switch omitted", () => {
    for (const [ext, expected] of COBOL_WIDENING) {
      assert.equal(
        detectLanguage(`src/PROG${ext}`),
        expected,
        `cobol widening regressed on ${ext}`,
      );
    }
  });

  it("resolves multi-dot paths by the last extension (matches the local switches on repo-relative paths)", () => {
    // The deleted switches used `lastIndexOf(".")`; detectLanguage uses
    // `lastExtension()`. On realistic repo-relative files they agree.
    assert.equal(detectLanguage("src/types.d.ts"), "typescript");
    assert.equal(detectLanguage("src/a.test.ts"), "typescript");
    assert.equal(detectLanguage("src/App.stories.tsx"), "tsx");
    assert.equal(detectLanguage("copybooks/ACCT.rec.cpy"), "cobol");
  });

  it("returns undefined for extensions no switch handled", () => {
    // Every call site treats undefined as "skip this file", so unknown
    // extensions must not resolve to a provider.
    assert.equal(detectLanguage("README.md"), undefined);
    assert.equal(detectLanguage("data.json"), undefined);
    assert.equal(detectLanguage("Makefile"), undefined);
  });
});
