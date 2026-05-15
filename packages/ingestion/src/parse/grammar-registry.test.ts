import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  _resetGrammarCacheForTests,
  getGrammarSha,
  getLanguageProvider,
  isRegexProviderLanguage,
  loadGrammar,
  preloadGrammars,
} from "./grammar-registry.js";
import { getUnifiedQuery } from "./unified-queries.js";

describe("grammar-registry", () => {
  it("returns a typescript handle with non-empty query text", async () => {
    _resetGrammarCacheForTests();
    const h = await loadGrammar("typescript");
    assert.equal(h.language, "typescript");
    assert.equal(h.queryText, getUnifiedQuery("typescript"));
    assert.ok(h.queryText.length > 0);
  });

  it("returns distinct handles for typescript vs tsx", async () => {
    _resetGrammarCacheForTests();
    const ts = await loadGrammar("typescript");
    const tsx = await loadGrammar("tsx");
    assert.equal(ts.language, "typescript");
    assert.equal(tsx.language, "tsx");
    // queryText may match across the two TS variants (they share the unified
    // query); the discriminating field is `language`.
    assert.notEqual(ts.language, tsx.language);
  });

  it("loads python, go, rust, java, javascript", async () => {
    _resetGrammarCacheForTests();
    for (const lang of ["python", "go", "rust", "java", "javascript"] as const) {
      const h = await loadGrammar(lang);
      assert.equal(h.language, lang);
      assert.ok(h.queryText.length > 0, `${lang} queryText should be non-empty`);
    }
  });

  it("loads csharp", async () => {
    _resetGrammarCacheForTests();
    const h = await loadGrammar("csharp");
    assert.equal(h.language, "csharp");
    assert.ok(h.queryText.length > 0);
  });

  it("preloadGrammars is callable and idempotent", async () => {
    _resetGrammarCacheForTests();
    await preloadGrammars(["typescript", "python"]);
    // second preload is a no-op-equivalent; the resolver is pure
    await preloadGrammars(["typescript", "python"]);
    const a = await loadGrammar("typescript");
    const b = await loadGrammar("typescript");
    assert.deepEqual(a, b);
  });

  it("classifies cobol as a regex-provider language", () => {
    const spec = getLanguageProvider("cobol");
    assert.equal(spec.kind, "regex");
    assert.equal(isRegexProviderLanguage("cobol"), true);
    // Sanity — tree-sitter languages are NOT regex-providers.
    assert.equal(isRegexProviderLanguage("typescript"), false);
    assert.equal(isRegexProviderLanguage("python"), false);
    const tsSpec = getLanguageProvider("typescript");
    assert.equal(tsSpec.kind, "tree-sitter");
    if (tsSpec.kind === "tree-sitter") {
      assert.equal(tsSpec.package, "tree-sitter-typescript");
    }
  });

  it("refuses to loadGrammar for a regex-provider language", async () => {
    _resetGrammarCacheForTests();
    await assert.rejects(loadGrammar("cobol"), /regex-provider/);
  });

  it("getGrammarSha returns null for regex-provider languages", async () => {
    _resetGrammarCacheForTests();
    const sha = await getGrammarSha("cobol");
    assert.equal(sha, null, "cobol has no grammar package — sha should be null");
  });

  it("loads handles for extended-language grammars", async () => {
    _resetGrammarCacheForTests();
    const langs = ["c", "cpp", "ruby", "kotlin", "swift", "php", "dart"] as const;
    for (const lang of langs) {
      const h = await loadGrammar(lang);
      assert.equal(h.language, lang);
      assert.ok(h.queryText.length > 0, `${lang}: queryText should be non-empty`);
    }
  });
});
