---
title: tree-sitter-wasms catalog package is unusable with web-tree-sitter 0.26+
tags: [tree-sitter, web-tree-sitter, wasm, dylink, parser-runtime, ingestion]
first_applied: 2026-05-08
repos: [opencodehub]
---

## The pattern

When a tree-sitter grammar npm package doesn't ship a `.wasm` alongside
its `.node` binding (kotlin `fwcd/tree-sitter-kotlin`, swift
`alex-pinkus/tree-sitter-swift`, dart `UserNobody14/tree-sitter-dart`),
the obvious workaround is the shared catalog package
`tree-sitter-wasms` which pre-builds `.wasm` for ~40 grammars in one
place.

**Do not reach for `tree-sitter-wasms@0.1.13` with
`web-tree-sitter@0.26+`. It won't load.**

## Why

`tree-sitter-wasms@0.1.13` (npm latest as of 2026-05-08) built its
`.wasm` artifacts with `tree-sitter-cli@0.20.8`, which emits the
legacy `dylink` custom section (6 bytes). `web-tree-sitter@0.26+`
hard-requires the standardized `dylink.0` section name (8 bytes) and
throws `Error: need the dylink section to be first` at
`Language.load(path)`.

Byte-level verification:

```
$ xxd -l 32 node_modules/tree-sitter-python/tree-sitter-python.wasm
00000000: 0061 736d 0100 0000 0011 0864 796c 696e  .asm.......dylin
00000010: 6b2e 3001 0694 c41a 0407 0001 2908 6001  k.0.........).`.

$ xxd -l 32 node_modules/tree-sitter-wasms/out/tree-sitter-kotlin.wasm
00000000: 0061 736d 0100 0000 000f 0664 796c 696e  .asm.......dylin
00000010: 6ba8 87ee 0104 0200 0001 2908 6001 7f00  k.........).`.
```

The 11 per-grammar packages that DO ship their own `.wasm` (python,
typescript, javascript, go, rust, java, csharp, c, cpp, ruby, php)
were built with current tree-sitter-cli and use `dylink.0` — those
load cleanly.

## Do this instead

Build your own `.wasm` blobs from the exact grammar sources your
package.json pins and commit them to the repo. See the opencodehub
implementation:

- `scripts/build-vendor-wasms.sh` — reproducible build via
  tree-sitter CLI + docker/podman/finch/local emcc
- `packages/ingestion/vendor/wasms/{kotlin,swift,dart}.wasm` — committed
  artifacts (8.1 MB total)
- `packages/ingestion/src/parse/wasm-fallback.ts` —
  `resolveGrammarWasmPath` falls back to `vendor/wasms/` for these 3
  languages when per-grammar `.wasm` isn't present

Zero grammar-version drift (built from same source as native), zero
install-time emscripten requirement (artifacts committed), zero CI-time
build (fast install everywhere).

## Related

- ADR 0013 (`docs/adr/0013-parse-runtime-wasm-default.md`) records the
  full WASM-default decision.
- Upstream publish blocker that forced the whole reshuffle:
  [tree-sitter/node-tree-sitter#276](https://github.com/tree-sitter/node-tree-sitter/issues/276)
  (Node 24 ABI break fix blocked on npm OIDC publish issue since 2025-06).
