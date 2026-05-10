---
title: Supported languages
description: The 15 GA languages OpenCodeHub parses, which have SCIP indexers, and the WASM-default runtime.
sidebar:
  order: 40
---

Languages are registered at compile time in a `satisfies Record<LanguageId,
LanguageProvider>` table at `packages/ingestion/src/providers/registry.ts`.
Omitting a registered language raises a build-time TypeScript error, so
the table and this page cannot drift.

## Registered languages (15 GA)

The `LanguageId` union has 16 entries because `tsx` is a separate
provider-id. The GA count rounds to 15 — TSX is a flavour of TypeScript
in every consumer-facing surface (`@opencodehub/cli` output, `query`
filters, `project_profile`).

| Language | tree-sitter parse | SCIP indexer |
|---|---|---|
| TypeScript | yes | scip-typescript |
| TSX | yes | scip-typescript (shared) |
| JavaScript | yes | scip-typescript (shared) |
| Python | yes | scip-python |
| Go | yes | scip-go |
| Rust | yes | rust-analyzer (stable) |
| Java | yes | scip-java |
| C# | yes | scip-dotnet |
| C | yes | scip-clang |
| C++ | yes | scip-clang |
| Ruby | yes | scip-ruby |
| Kotlin | yes | scip-kotlin |
| Swift | yes | — |
| PHP | yes | — |
| Dart | yes | — |

COBOL is also indexed (regex hot path; the `cobol` provider is a
stub). Add `--allow-build-scripts proleap` to opt into the JVM
ProLeap deep-parse.

## Native bindings and the WASM default

The default parse runtime on Node 22 and Node 24 is
`web-tree-sitter` (WASM). It has no native ABI dependency, so it works
on every supported Node version out of the box.

The native `tree-sitter` N-API addon is available as an opt-in path
on Node 22, where it is measurably faster on large repos. Enable it
with the env var or CLI flag:

```bash title="opt into native parsing on Node 22"
OCH_NATIVE_PARSER=1 codehub analyze
# or
codehub analyze --native-parser
```

Native is unavailable on Node 24 until `node-tree-sitter@0.25.1` lands
on npm (tree-sitter/node-tree-sitter#276). Kotlin, Swift, and Dart
ship their grammars as `.wasm` blobs vendored at
`packages/ingestion/vendor/wasms/` regardless of the runtime
selection — those grammars do not have prebuilt N-API addons on npm.

The complexity-metrics ingestion phase still uses native tree-sitter
for cyclomatic-complexity counting. On Node 24 (or Node 22 without the
opt-in) it degrades with a one-shot stderr warning; all other
parsing continues via WASM.

ADR 0013 (`docs/adr/0013-parse-runtime-wasm-default.md`) explains the
rationale.

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
