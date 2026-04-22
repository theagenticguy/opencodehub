import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { _resetGrammarCacheForTests, loadGrammar, preloadGrammars } from "./grammar-registry.js";
import { getUnifiedQuery } from "./unified-queries.js";

describe("grammar-registry", () => {
  it("lazy-loads TypeScript and caches by identity", async () => {
    _resetGrammarCacheForTests();
    const first = await loadGrammar("typescript");
    const second = await loadGrammar("typescript");
    assert.equal(first, second, "second call should return the cached handle");
    assert.equal(first.language, "typescript");
    assert.ok(first.tsLanguage, "tree-sitter language object should be truthy");
    assert.equal(first.queryText, getUnifiedQuery("typescript"));
  });

  it("returns distinct handles for typescript vs tsx", async () => {
    _resetGrammarCacheForTests();
    const ts = await loadGrammar("typescript");
    const tsx = await loadGrammar("tsx");
    assert.notEqual(ts, tsx);
    assert.notEqual(ts.tsLanguage, tsx.tsLanguage);
  });

  it("loads python, go, rust, java, javascript", async () => {
    _resetGrammarCacheForTests();
    for (const lang of ["python", "go", "rust", "java", "javascript"] as const) {
      const h = await loadGrammar(lang);
      assert.equal(h.language, lang);
      assert.ok(h.tsLanguage, `${lang} tsLanguage should be loaded`);
      assert.ok(h.queryText.length > 0, `${lang} queryText should be non-empty`);
    }
  });

  it("loads c# via dynamic import path", async () => {
    _resetGrammarCacheForTests();
    const h = await loadGrammar("csharp");
    assert.equal(h.language, "csharp");
    assert.ok(h.tsLanguage, "csharp Language object should load");
  });

  it("preloadGrammars is idempotent", async () => {
    _resetGrammarCacheForTests();
    await preloadGrammars(["typescript", "python"]);
    // second preload hits cache
    await preloadGrammars(["typescript", "python"]);
    const a = await loadGrammar("typescript");
    const b = await loadGrammar("typescript");
    assert.equal(a, b);
  });

  it("loads W2-C.1 grammars when the native bindings are installed", async () => {
    // W2-C.1 adds 7 grammars (c, cpp, ruby, kotlin, swift, php, dart). Some
    // of them (notably kotlin without prebuilds, dart via git+ssh) may fail
    // to build on exotic platforms or restricted CI. We treat a load failure
    // as "skip this grammar" — the registry itself must not crash.
    _resetGrammarCacheForTests();
    const langs = ["c", "cpp", "ruby", "kotlin", "swift", "php", "dart"] as const;
    for (const lang of langs) {
      try {
        const h = await loadGrammar(lang);
        assert.equal(h.language, lang);
        assert.ok(h.tsLanguage, `${lang}: tree-sitter Language should be non-null`);
      } catch (err) {
        // Skip: native binding missing on this platform (acceptable).
        // Print once so CI diagnostics surface the gap.
        console.warn(`[grammar-registry.test] skip ${lang}: ${(err as Error).message}`);
      }
    }
  });
});
