/**
 * WASM parity smoke test.
 *
 * Verifies that capture tag + text output of the WASM runtime matches
 * the native runtime for a small-but-representative set of source
 * bodies across all 14 tree-sitter-backed `LanguageId` values
 * (typescript, tsx, javascript, python, go, rust, java, csharp, c,
 * cpp, ruby, php, kotlin, swift, dart). COBOL is regex-only and lives
 * outside this parity matrix by design.
 *
 * We compare by (tag, text) tuples — coordinate values can legitimately
 * differ across grammars when the tree-sitter query picks up a subtly
 * different capture range. The spec-level invariant is "semantic
 * capture output is the same"; we assert that the multiset of
 * (tag, text) pairs matches.
 *
 * Skip semantics:
 *  - When native tree-sitter is unavailable (e.g. Node 24 where the
 *    native bindings don't compile), every per-language iteration
 *    reports as a skip with a descriptive message. There is no hard
 *    fail — the suite is a no-op on WASM-only boxes.
 *  - When a specific language's WASM grammar handle fails to open, we
 *    emit a `console.warn` naming the gap and skip that language so
 *    the rest of the matrix continues to execute.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { parseFixture } from "../providers/test-helpers.js";
import type { LanguageId } from "./types.js";
import { getUnifiedQuery } from "./unified-queries.js";
import {
  _resetWasmCacheForTests,
  isNativeAvailable,
  openWasmParser,
  type WasmParserHandle,
} from "./wasm-fallback.js";
import { ParsePool } from "./worker-pool.js";

/** 20 TypeScript bodies. */
const TS_FIXTURES: readonly string[] = [
  `export function add(a: number, b: number): number { return a + b; }`,
  `class Foo { greet(): string { return "hi"; } }`,
  `interface Speaker { speak(msg: string): void; }`,
  `const x = 42;`,
  `export const fn = (n: number) => n * 2;`,
  `export class Bar extends Foo implements Speaker {
     speak(msg: string): void { console.log(msg); }
   }`,
  `type Id = string | number;`,
  `enum Color { Red, Green, Blue }`,
  `import { foo } from "./a"; import * as b from "./b";`,
  `namespace N { export const y = 1; }`,
  `async function run() { await Promise.resolve(1); }`,
  `function* gen() { yield 1; yield 2; }`,
  `/** adds numbers */ export function add2(a: number, b: number) { return a + b; }`,
  `export default class Main { constructor(public name: string) {} }`,
  `const obj = { a: 1, b: 2 };`,
  `export function takeOptional(x?: number): number { return x ?? 0; }`,
  `class K { private f = 1; get v(): number { return this.f; } }`,
  `for (const x of [1,2,3]) { console.log(x); }`,
  `try { throw new Error("bad"); } catch (e) { console.error(e); }`,
  `export abstract class A { abstract run(): void; }`,
];

/** 20 Python bodies. */
const PY_FIXTURES: readonly string[] = [
  `def add(a, b):\n    return a + b\n`,
  `class Foo:\n    def greet(self):\n        return "hi"\n`,
  `class Speaker:\n    def speak(self, msg):\n        raise NotImplementedError\n`,
  `x = 42\n`,
  `fn = lambda n: n * 2\n`,
  `class Bar(Foo):\n    def speak(self, msg):\n        print(msg)\n`,
  `from typing import Union\nId = Union[str, int]\n`,
  `from enum import Enum\nclass Color(Enum):\n    RED = 1\n    GREEN = 2\n`,
  `import os\nfrom pathlib import Path\n`,
  `def run():\n    return sum(range(10))\n`,
  `async def fetch():\n    return await asyncio.sleep(0)\n`,
  `def gen():\n    yield 1\n    yield 2\n`,
  `def add2(a, b):\n    """adds numbers"""\n    return a + b\n`,
  `class Main:\n    def __init__(self, name):\n        self.name = name\n`,
  `obj = {"a": 1, "b": 2}\n`,
  `def optional(x=None):\n    return x if x is not None else 0\n`,
  `class K:\n    def __init__(self):\n        self._f = 1\n    @property\n    def v(self):\n        return self._f\n`,
  `for x in [1, 2, 3]:\n    print(x)\n`,
  `try:\n    raise ValueError("bad")\nexcept ValueError as e:\n    print(e)\n`,
  `def multi_return(n):\n    if n > 0:\n        return 1\n    elif n < 0:\n        return -1\n    return 0\n`,
];

/** 20 Go bodies. */
const GO_FIXTURES: readonly string[] = [
  `package p\nfunc Add(a, b int) int { return a + b }\n`,
  `package p\ntype Foo struct{}\nfunc (f *Foo) Greet() string { return "hi" }\n`,
  `package p\ntype Speaker interface { Speak(msg string) }\n`,
  `package p\nconst X = 42\n`,
  `package p\nvar fn = func(n int) int { return n * 2 }\n`,
  `package p\ntype Bar struct{ Foo }\nfunc (b *Bar) Speak(msg string) {}\n`,
  `package p\ntype ID string\n`,
  `package p\nconst (\n    Red = iota\n    Green\n    Blue\n)\n`,
  `package p\nimport (\n    "fmt"\n    "strings"\n)\n`,
  `package p\nfunc Run() int { return 42 }\n`,
  `package p\nfunc run() { defer func(){ recover() }() }\n`,
  `package p\nfunc gen() <-chan int {\n    ch := make(chan int)\n    go func() { ch <- 1; ch <- 2; close(ch) }()\n    return ch\n}\n`,
  `// Add2 adds two numbers.\npackage p\nfunc Add2(a, b int) int { return a + b }\n`,
  `package p\ntype Main struct{ name string }\nfunc NewMain(name string) *Main { return &Main{name: name} }\n`,
  `package p\nvar obj = map[string]int{"a": 1, "b": 2}\n`,
  `package p\nfunc takeOptional(x *int) int { if x == nil { return 0 }; return *x }\n`,
  `package p\ntype K struct{ f int }\nfunc (k *K) V() int { return k.f }\n`,
  `package p\nfunc iter() { for _, x := range []int{1, 2, 3} { _ = x } }\n`,
  `package p\nfunc tryCatch() error { return fmt.Errorf("bad") }\n`,
  `package p\nfunc multiReturn(n int) (int, error) { if n > 0 { return 1, nil }; return 0, fmt.Errorf("non-positive") }\n`,
];

/**
 * Fixture blocks for the remaining 11 tree-sitter languages. 3-5 bodies
 * each is enough to exercise the capture-tag surface the unified query
 * targets (definitions, imports, references); fuller 20-body arrays
 * live on typescript/python/go as historical regression corpora.
 *
 * Authoring rule: every snippet must be syntactically valid on its own
 * (no missing imports / enclosing scopes) so both native and WASM can
 * parse it cleanly without error-node divergence.
 */

/** TSX fixtures. */
const TSX_FIXTURES: readonly string[] = [
  `export const Hello = () => <div>hi</div>;`,
  `import React from "react";\nexport function Page(): JSX.Element { return <main><h1>title</h1></main>; }`,
  `interface Props { name: string }\nexport const Greet = (p: Props) => <span>{p.name}</span>;`,
  `export class App extends React.Component { render() { return <div />; } }`,
];

/** JavaScript fixtures (ESM + CJS). */
const JS_FIXTURES: readonly string[] = [
  `export function add(a, b) { return a + b; }`,
  `class Foo { greet() { return "hi"; } }`,
  `import { readFile } from "node:fs/promises";\nexport async function load(p) { return readFile(p); }`,
  `const path = require("node:path");\nmodule.exports = { resolve: (f) => path.resolve(f) };`,
  `export const fn = (n) => n * 2;`,
];

/** Rust fixtures. */
const RUST_FIXTURES: readonly string[] = [
  `pub fn add(a: i32, b: i32) -> i32 { a + b }`,
  `pub struct Greeter { pub name: String }\nimpl Greeter { pub fn new(name: String) -> Self { Self { name } } }`,
  `pub trait Greet { fn greet(&self, name: &str) -> String; }`,
  `use std::collections::HashMap;\npub fn empty() -> HashMap<String, i32> { HashMap::new() }`,
  `pub const DEFAULT: u32 = 42;`,
];

/** Java fixtures. */
const JAVA_FIXTURES: readonly string[] = [
  `package demo;\npublic class Hello { public String greet(String n) { return "hi " + n; } }`,
  `package demo;\npublic interface Speaker { void speak(String msg); }`,
  `package demo;\nimport java.util.List;\npublic class Box { public List<Integer> xs; }`,
  `package demo;\npublic class Counter { private int n = 0; public int inc() { return ++n; } }`,
];

/** C# fixtures. */
const CSHARP_FIXTURES: readonly string[] = [
  `namespace Demo; public class Hello { public string Greet(string n) => "hi " + n; }`,
  `namespace Demo; public interface ISpeaker { void Speak(string msg); }`,
  `using System.Collections.Generic; namespace Demo; public class Box { public List<int> Xs = new(); }`,
  `namespace Demo; public record Point(int X, int Y);`,
];

/** C fixtures. */
const C_FIXTURES: readonly string[] = [
  `int add(int a, int b) { return a + b; }`,
  `#include <stdio.h>\nvoid greet(const char *n) { printf("hi %s\\n", n); }`,
  `struct Point { int x; int y; };\nstruct Point origin(void) { struct Point p = {0, 0}; return p; }`,
  `static int counter = 0;\nint inc(void) { return ++counter; }`,
];

/** C++ fixtures. */
const CPP_FIXTURES: readonly string[] = [
  `int add(int a, int b) { return a + b; }`,
  `#include <string>\nclass Greeter { public: std::string greet(const std::string& n) { return "hi " + n; } };`,
  `namespace util { int square(int n) { return n * n; } }`,
  `template <typename T> T identity(T x) { return x; }`,
];

/** Ruby fixtures. */
const RUBY_FIXTURES: readonly string[] = [
  `def add(a, b)\n  a + b\nend\n`,
  `class Greeter\n  def greet(name)\n    "hi #{name}"\n  end\nend\n`,
  `module Math2\n  def self.square(n)\n    n * n\n  end\nend\n`,
  `require "json"\nputs JSON.generate({a: 1})\n`,
];

/** PHP fixtures. */
const PHP_FIXTURES: readonly string[] = [
  `<?php\nfunction add(int $a, int $b): int { return $a + $b; }\n`,
  `<?php\nclass Greeter { public function greet(string $n): string { return "hi " . $n; } }\n`,
  `<?php\ninterface Speaker { public function speak(string $msg): void; }\n`,
  `<?php\nnamespace Demo;\nuse Psr\\Log\\LoggerInterface;\nclass Service { public function __construct(private LoggerInterface $log) {} }\n`,
];

/** Kotlin fixtures. */
const KOTLIN_FIXTURES: readonly string[] = [
  `package demo\nfun add(a: Int, b: Int): Int = a + b\n`,
  `package demo\nclass Greeter { fun greet(name: String): String = "hi $name" }\n`,
  `package demo\ninterface Speaker { fun speak(msg: String) }\n`,
  `package demo\ndata class Point(val x: Int, val y: Int)\n`,
];

/** Swift fixtures. */
const SWIFT_FIXTURES: readonly string[] = [
  `func add(_ a: Int, _ b: Int) -> Int { return a + b }`,
  `class Greeter { func greet(_ name: String) -> String { return "hi " + name } }`,
  `protocol Speaker { func speak(_ msg: String) }`,
  `struct Point { var x: Int; var y: Int }`,
];

/** Dart fixtures. */
const DART_FIXTURES: readonly string[] = [
  `int add(int a, int b) => a + b;`,
  `class Greeter { String greet(String name) => "hi $name"; }`,
  `abstract class Speaker { void speak(String msg); }`,
  `import "dart:async";\nFuture<int> load() async => 42;`,
];

interface CaptureKey {
  readonly tag: string;
  readonly text: string;
}

function toKeyMultiset(captures: readonly { tag: string; text: string }[]): string[] {
  const out = captures.map((c: CaptureKey) => `${c.tag}|${c.text}`);
  out.sort();
  return out;
}

async function captureNative(
  pool: ParsePool,
  lang: LanguageId,
  name: string,
  source: string,
): Promise<readonly CaptureKey[]> {
  const fx = await parseFixture(pool, lang, name, source);
  return fx.captures.map((c) => ({ tag: c.tag, text: c.text }));
}

async function captureWasm(
  handle: WasmParserHandle,
  lang: LanguageId,
  source: string,
): Promise<readonly CaptureKey[]> {
  const queryText = getUnifiedQuery(lang);
  const caps = handle.runQuery(queryText, source);
  return caps.map((c) => ({ tag: c.name, text: c.node.text }));
}

/**
 * Full fixture matrix — every tree-sitter `LanguageId` paired with its
 * fixture array. COBOL is regex-only (no grammar) and sits outside this
 * matrix.
 */
const FIXTURES: readonly (readonly [LanguageId, readonly string[]])[] = [
  ["typescript", TS_FIXTURES],
  ["tsx", TSX_FIXTURES],
  ["javascript", JS_FIXTURES],
  ["python", PY_FIXTURES],
  ["go", GO_FIXTURES],
  ["rust", RUST_FIXTURES],
  ["java", JAVA_FIXTURES],
  ["csharp", CSHARP_FIXTURES],
  ["c", C_FIXTURES],
  ["cpp", CPP_FIXTURES],
  ["ruby", RUBY_FIXTURES],
  ["php", PHP_FIXTURES],
  ["kotlin", KOTLIN_FIXTURES],
  ["swift", SWIFT_FIXTURES],
  ["dart", DART_FIXTURES],
] as const;

// Module-level native-availability gate. When native tree-sitter is not
// installed (e.g. Node 24 boxes where the native bindings fail to
// compile), flip every iteration into a skip rather than a hard fail.
// The outer `describe()` always runs so the skip surface is visible.
const NATIVE_AVAILABLE = isNativeAvailable();
const SKIP_REASON =
  "native tree-sitter is unavailable — parity suite requires it as the reference runtime";

describe("WASM parity: native vs WASM capture output", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  before(() => {
    _resetWasmCacheForTests();
  });

  for (const [lang, fixtures] of FIXTURES) {
    it(`${lang}: ${fixtures.length} bodies produce identical (tag, text) multisets`, {
      skip: NATIVE_AVAILABLE ? false : SKIP_REASON,
    }, async (t) => {
      const handle = await openWasmParser(lang);
      if (handle === null) {
        // WASM grammar missing for this language — skip (not fail) so
        // the rest of the matrix continues. Warn to stderr so the gap
        // is visible in CI logs.
        const msg = `WASM grammar missing for ${lang} — skipping parity check`;
        console.warn(`[wasm-parity] ${msg}`);
        t.skip(msg);
        return;
      }
      for (let i = 0; i < fixtures.length; i++) {
        const source = fixtures[i];
        if (source === undefined) continue;
        const nativeKeys = toKeyMultiset(
          await captureNative(pool, lang, `fx-${i}.${extFor(lang)}`, source),
        );
        const wasmKeys = toKeyMultiset(await captureWasm(handle, lang, source));
        assert.deepEqual(
          wasmKeys,
          nativeKeys,
          `${lang} fixture ${i} diverged\nnative: ${nativeKeys.join("\n")}\nwasm: ${wasmKeys.join("\n")}`,
        );
      }
    });
  }
});

function extFor(lang: LanguageId): string {
  switch (lang) {
    case "typescript":
      return "ts";
    case "tsx":
      return "tsx";
    case "javascript":
      return "js";
    case "python":
      return "py";
    case "go":
      return "go";
    case "rust":
      return "rs";
    case "java":
      return "java";
    case "csharp":
      return "cs";
    case "c":
      return "c";
    case "cpp":
      return "cpp";
    case "ruby":
      return "rb";
    case "php":
      return "php";
    case "kotlin":
      return "kt";
    case "swift":
      return "swift";
    case "dart":
      return "dart";
    default:
      return "txt";
  }
}
