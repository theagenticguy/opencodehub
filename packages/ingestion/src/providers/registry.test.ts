import assert from "node:assert/strict";
import { test } from "node:test";
import { getProvider, listProviders } from "./registry.js";
import type { LanguageId, MroStrategyName } from "./types.js";

const ALL_LANGUAGES: readonly LanguageId[] = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
  // --- Extended-language providers ---
  "c",
  "cpp",
  "ruby",
  "kotlin",
  "swift",
  "php",
  "dart",
];

test("registry: every LanguageId returns a provider with matching id", () => {
  for (const lang of ALL_LANGUAGES) {
    const p = getProvider(lang);
    assert.equal(p.id, lang, `provider for ${lang} has mismatched id ${p.id}`);
  }
});

test("registry: listProviders returns one entry per language", () => {
  const all = listProviders();
  assert.equal(all.length, ALL_LANGUAGES.length);
  const ids = all.map((p) => p.id).sort();
  assert.deepEqual(ids, [...ALL_LANGUAGES].sort());
});

test("registry: MRO strategies are assigned per the language family", () => {
  const expected: Readonly<Record<LanguageId, MroStrategyName>> = {
    typescript: "first-wins",
    tsx: "first-wins",
    javascript: "first-wins",
    rust: "first-wins",
    python: "c3",
    java: "single-inheritance",
    csharp: "single-inheritance",
    go: "none",
    // Extended-language MRO strategies.
    c: "none",
    cpp: "c3",
    ruby: "c3",
    kotlin: "c3",
    swift: "single-inheritance",
    php: "single-inheritance",
    dart: "c3",
  };
  for (const lang of ALL_LANGUAGES) {
    assert.equal(
      getProvider(lang).mroStrategy,
      expected[lang],
      `unexpected MRO strategy for ${lang}`,
    );
  }
});

test("registry: Go provider has null heritage edge and uppercase-first exports", () => {
  const go = getProvider("go");
  assert.equal(go.heritageEdge, null);
  assert.ok(go.isExportedIdentifier);
  assert.equal(go.isExportedIdentifier("Foo", "top-level"), true);
  assert.equal(go.isExportedIdentifier("foo", "top-level"), false);
});

test("registry: Python provider uses self as implicit receiver, TS uses this", () => {
  const py = getProvider("python");
  const ts = getProvider("typescript");
  assert.ok(py.inferImplicitReceiver);
  assert.ok(ts.inferImplicitReceiver);
  assert.equal(py.inferImplicitReceiver("Method"), "self");
  assert.equal(ts.inferImplicitReceiver("Method"), "this");
});

test("registry: extensions cover the expected suffixes", () => {
  assert.deepEqual(getProvider("typescript").extensions, [".ts"]);
  assert.deepEqual(getProvider("tsx").extensions, [".tsx"]);
  assert.deepEqual(getProvider("javascript").extensions, [".js", ".mjs", ".cjs", ".jsx"]);
  assert.deepEqual(getProvider("python").extensions, [".py"]);
  assert.deepEqual(getProvider("go").extensions, [".go"]);
  assert.deepEqual(getProvider("rust").extensions, [".rs"]);
  assert.deepEqual(getProvider("java").extensions, [".java"]);
  assert.deepEqual(getProvider("csharp").extensions, [".cs"]);
  // Extended languages.
  assert.deepEqual(getProvider("c").extensions, [".c", ".h"]);
  assert.deepEqual(getProvider("cpp").extensions, [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]);
  assert.deepEqual(getProvider("ruby").extensions, [".rb"]);
  assert.deepEqual(getProvider("kotlin").extensions, [".kt", ".kts"]);
  assert.deepEqual(getProvider("swift").extensions, [".swift"]);
  assert.deepEqual(getProvider("php").extensions, [
    ".php",
    ".php3",
    ".php4",
    ".php5",
    ".php7",
    ".phtml",
  ]);
  assert.deepEqual(getProvider("dart").extensions, [".dart"]);
});

test("registry: every provider returns empty arrays for empty inputs", () => {
  // All providers should tolerate empty captures gracefully — the
  // pipeline feeds them zero-capture inputs for files with no matches.
  const allLangs: readonly LanguageId[] = ALL_LANGUAGES;
  const emptyInput = {
    filePath: "fixture.src",
    captures: [],
    sourceText: "",
    definitions: [],
  };
  for (const lang of allLangs) {
    const p = getProvider(lang);
    assert.deepEqual(p.extractDefinitions(emptyInput), []);
    assert.deepEqual(p.extractCalls(emptyInput), []);
    assert.deepEqual(p.extractImports(emptyInput), []);
    assert.deepEqual(p.extractHeritage(emptyInput), []);
  }
});

test("registry: extended languages pick the right heritage edge", () => {
  // C alone has no class hierarchy => null. All others use EXTENDS.
  assert.equal(getProvider("c").heritageEdge, null);
  for (const lang of ["cpp", "ruby", "kotlin", "swift", "php", "dart"] as const) {
    assert.equal(getProvider(lang).heritageEdge, "EXTENDS", `${lang}: expected EXTENDS`);
  }
});
