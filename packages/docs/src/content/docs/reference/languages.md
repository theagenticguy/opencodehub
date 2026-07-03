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

## Parse runtime — WASM-only

The parse runtime is `web-tree-sitter` (WASM) on Node ≥24.15.
WASM has no native ABI dependency, so it works on every supported Node
version out of the box and `npm install -g @opencodehub/cli@latest` does
zero native builds.

All 15 GA grammar `.wasm` blobs are vendored at
`packages/ingestion/vendor/wasms/`, built from the grammar sources
pinned in `package.json`. Re-vendoring is a one-shot operation via
`bash scripts/build-vendor-wasms.sh`; consumers never build grammars at
install time.

The complexity-metrics ingestion phase is also WASM-backed, so
cyclomatic-complexity counting runs on every install instead of
degrading to a no-op.

ADR 0015 (`docs/adr/0015-wasm-only-parser-at-the-npm-distributed-boundary.md`)
explains the rationale and the bulletproof-install plan; ADR 0013
records the prior WASM-default + native-opt-in posture and is now
superseded.

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
