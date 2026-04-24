/**
 * WASM parity smoke test.
 *
 * Verifies that capture tag + text output of the WASM runtime matches
 * the native runtime for a small-but-representative set of source
 * bodies across TypeScript, Python, and Go. Each language gets a 20-
 * body fixture array; failure of any single body fails the suite.
 *
 * We compare by (tag, text) tuples — coordinate values can legitimately
 * differ across grammars when the tree-sitter query picks up a subtly
 * different capture range. The spec-level invariant is "semantic
 * capture output is the same"; we assert that the multiset of
 * (tag, text) pairs matches.
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

describe("WASM parity: native vs WASM capture output", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  before(() => {
    _resetWasmCacheForTests();
  });

  it("skips cleanly when native is not available", () => {
    // Signpost only — the actual suite below needs native to exist so
    // we can diff against it. We run on the canonical developer box
    // where `tree-sitter` binds correctly, and this file exists purely
    // for the parity invariant, not as a portability assertion.
    assert.ok(isNativeAvailable(), "test requires native tree-sitter (install fails CI");
  });

  for (const [lang, fixtures] of [
    ["typescript", TS_FIXTURES],
    ["python", PY_FIXTURES],
    ["go", GO_FIXTURES],
  ] as const) {
    it(`${lang}: 20 bodies produce identical (tag, text) multisets`, async () => {
      const handle = await openWasmParser(lang);
      if (handle === null) {
        // WASM unavailable — mark the test as a skip-equivalent by
        // asserting the signal so CI surface isn't silent.
        assert.fail(`WASM grammar missing for ${lang}`);
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
  if (lang === "typescript") return "ts";
  if (lang === "python") return "py";
  if (lang === "go") return "go";
  return "txt";
}
