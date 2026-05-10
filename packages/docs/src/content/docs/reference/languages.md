---
title: Supported languages
description: The 15 registered languages, which have SCIP indexers, and the WASM fallback.
sidebar:
  order: 40
---

Languages are registered at compile time in a `satisfies Record<LanguageId,
LanguageProvider>` table. Omitting a registered language raises a
build-time TypeScript error, so the table and this page cannot drift.

## Registered languages (15)

| Language | tree-sitter parse | SCIP indexer |
|---|---|---|
| TypeScript | yes | yes |
| TSX | yes | yes (via TypeScript) |
| JavaScript | yes | yes (via TypeScript) |
| Python | yes | yes |
| Go | yes | yes |
| Rust | yes | yes |
| Java | yes | yes |
| C# | yes | — |
| C | yes | — |
| C++ | yes | — |
| Ruby | yes | — |
| Kotlin | yes | — |
| Swift | yes | — |
| PHP | yes | — |
| Dart | yes | — |

The five languages with a SCIP indexer get precise cross-file reference
resolution (ADR 0005). The other ten rely on tree-sitter's
symbol-level resolution, which is good enough for blast-radius within
a single module and degrades gracefully across module boundaries.

## Native bindings and the WASM fallback

Every grammar is loaded via native tree-sitter bindings by default.
Native bindings are faster but require a working C/C++ toolchain
(`node-gyp` + MSVC on Windows, `clang` + headers on macOS, `gcc` +
headers on Linux). They are compiled on install from source pins in
`packages/ingestion/package.json`.

If native bindings fail to load — common on some minimal Linux
containers and on Windows without the Build Tools — run with
`--wasm-only` or export `OCH_WASM_ONLY=1`:

```bash title="force WASM for every grammar"
codehub analyze --wasm-only
```

WASM is slightly slower but has no native dependency. The web surface
of OpenCodeHub always runs in WASM-only mode.

## Adding a language

Four steps, all committed together:

1. Pin the tree-sitter grammar in `packages/ingestion/package.json`.
2. Implement `LanguageProvider` in
   `packages/ingestion/src/providers/<lang>.ts`.
3. Add the entry to the registry in
   `packages/ingestion/src/providers/registry.ts` — TypeScript fails
   the build if the key is missing.
4. Add fixture tests under
   `packages/ingestion/test/fixtures/<lang>/`, using the
   `parseFixture` helper from `test-helpers.ts`.

See
[adding a language provider](/opencodehub/contributing/adding-a-language-provider/)
for the full walkthrough.
