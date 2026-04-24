import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { detectLanguage } from "./language-detector.js";

describe("detectLanguage", () => {
  it("maps TypeScript extensions", () => {
    assert.equal(detectLanguage("src/app.ts"), "typescript");
    assert.equal(detectLanguage("src/app.mts"), "typescript");
    assert.equal(detectLanguage("src/app.cts"), "typescript");
    // .d.ts should also resolve to typescript via last-extension logic
    assert.equal(detectLanguage("src/types.d.ts"), "typescript");
  });

  it("maps TSX separately from TS", () => {
    assert.equal(detectLanguage("src/App.tsx"), "tsx");
  });

  it("maps JavaScript variants", () => {
    assert.equal(detectLanguage("src/app.js"), "javascript");
    assert.equal(detectLanguage("src/app.mjs"), "javascript");
    assert.equal(detectLanguage("src/app.cjs"), "javascript");
    assert.equal(detectLanguage("src/App.jsx"), "javascript");
  });

  it("maps Python", () => {
    assert.equal(detectLanguage("src/main.py"), "python");
    assert.equal(detectLanguage("src/stub.pyi"), "python");
  });

  it("maps Go", () => {
    assert.equal(detectLanguage("cmd/main.go"), "go");
  });

  it("maps Rust", () => {
    assert.equal(detectLanguage("src/lib.rs"), "rust");
  });

  it("maps Java", () => {
    assert.equal(detectLanguage("src/Main.java"), "java");
  });

  it("maps C#", () => {
    assert.equal(detectLanguage("src/Program.cs"), "csharp");
  });

  it("maps C (.c, .h)", () => {
    assert.equal(detectLanguage("src/main.c"), "c");
    // .h defaults to C (ambiguous between C/C++; upgrade later via content sniff).
    assert.equal(detectLanguage("include/api.h"), "c");
  });

  it("maps C++ (.cpp, .cc, .cxx, .hpp, .hh, .hxx)", () => {
    assert.equal(detectLanguage("src/main.cpp"), "cpp");
    assert.equal(detectLanguage("src/util.cc"), "cpp");
    assert.equal(detectLanguage("src/util.cxx"), "cpp");
    assert.equal(detectLanguage("include/util.hpp"), "cpp");
    assert.equal(detectLanguage("include/util.hh"), "cpp");
    assert.equal(detectLanguage("include/util.hxx"), "cpp");
  });

  it("maps Ruby", () => {
    assert.equal(detectLanguage("lib/app.rb"), "ruby");
  });

  it("maps Kotlin (.kt, .kts)", () => {
    assert.equal(detectLanguage("src/main.kt"), "kotlin");
    assert.equal(detectLanguage("build.gradle.kts"), "kotlin");
  });

  it("maps Swift", () => {
    assert.equal(detectLanguage("Sources/App/App.swift"), "swift");
  });

  it("maps PHP variants", () => {
    assert.equal(detectLanguage("src/Foo.php"), "php");
    assert.equal(detectLanguage("legacy/old.php3"), "php");
    assert.equal(detectLanguage("legacy/old.php4"), "php");
    assert.equal(detectLanguage("legacy/old.php5"), "php");
    assert.equal(detectLanguage("legacy/old.php7"), "php");
    assert.equal(detectLanguage("tpl/foo.phtml"), "php");
  });

  it("maps Dart", () => {
    assert.equal(detectLanguage("lib/main.dart"), "dart");
  });

  it("returns undefined for unknown extension", () => {
    assert.equal(detectLanguage("README.txt"), undefined);
    assert.equal(detectLanguage("data.bin"), undefined);
    assert.equal(detectLanguage("LICENSE"), undefined);
  });

  it("falls back to python via shebang", () => {
    assert.equal(detectLanguage("scripts/run", "#!/usr/bin/env python3"), "python");
  });

  it("falls back to javascript via node shebang", () => {
    assert.equal(detectLanguage("scripts/cli", "#!/usr/bin/env node"), "javascript");
  });

  it("is case-insensitive on extension", () => {
    assert.equal(detectLanguage("src/App.TSX"), "tsx");
    assert.equal(detectLanguage("src/Main.JAVA"), "java");
  });

  it("handles Windows-style paths", () => {
    assert.equal(detectLanguage("C:\\repo\\src\\app.ts"), "typescript");
  });

  it("does not misinterpret dotfiles", () => {
    // ".gitignore" is a dotfile with no extension — should be undefined.
    assert.equal(detectLanguage(".gitignore"), undefined);
  });
});
