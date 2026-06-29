---
title: Troubleshooting
description: Fix install failures, stale indexes, ambiguous-repo errors, and Windows quirks.
sidebar:
  order: 90
---

## Install / `node-gyp` build failures

Symptoms: `npm install -g @opencodehub/cli` (or `pnpm install` from a
checkout) fails with `node-gyp`, `python`, a C/C++ compiler, or `Visual
Studio Build Tools` in the error.

OpenCodeHub installs with **zero native bindings**, so it never compiles
anything at install time. Every runtime component is pure JS or WASM:

- Parsing is `web-tree-sitter` (WASM), with grammars vendored as `.wasm`
  blobs — no native tree-sitter build.
- The store is a single-file SQLite index via the built-in `node:sqlite`
  (Node ≥ 24.15) — no native database binding.
- The optional embedder is `onnxruntime-web` (prebuilt WASM), loaded lazily
  only under `--embeddings` — no `onnxruntime-node`, no native ONNX build.

So a `node-gyp` error almost always comes from an unrelated package in your
own project's tree, not from OpenCodeHub. Confirm with:

```bash title="probe the environment"
codehub doctor
```

`doctor` checks the Node version and that each WASM/JS component loads. If
it reports green but your install still fails, the failing module belongs to
something else you are installing alongside the CLI.

## Stale index

Symptoms: MCP responses carry `_meta["codehub/staleness"]`, or
`codehub query` returns symbols that no longer exist.

Fix:

```bash title="check then rebuild"
codehub status
codehub analyze --force
```

`status` reports how far behind `HEAD` the index is. `analyze --force`
rebuilds from scratch regardless of the no-op short-circuit. Run
`codehub analyze` after every significant pull to stay aligned.

## `AMBIGUOUS_REPO` error from MCP tools

Symptoms: an MCP tool returns an error envelope with
`error_code: "AMBIGUOUS_REPO"`.

Cause: you have more than one repo indexed and the tool call did not
include a `repo` (registry name) or `repo_uri` (Sourcegraph-style URI)
argument.

Fix: read the structured-error envelope's `choices[]` and retry with
one of the `repo_uri` values. The list is capped at 10; check
`total_matches` to know if it was truncated. See
[error codes](/opencodehub/reference/error-codes/#ambiguous_repo-envelope)
for the exact shape.

## Windows quirks

OpenCodeHub has no native bindings, so a standard install never compiles
on Windows — parsing is WASM (`web-tree-sitter`), the store is the built-in
`node:sqlite`, and the optional embedder is `onnxruntime-web` (prebuilt
WASM). There is no C/C++ toolchain requirement.

The remaining Windows friction is path-separator and shell quirks rather
than builds. If you hit those, the smoothest environment is WSL2, which
matches the POSIX paths the rest of the toolchain assumes.

## The index is missing a language I expected

Check [supported languages](/opencodehub/reference/languages/). The
default WASM runtime should produce results for every registered
language without a native toolchain. If the language is not listed,
it is not yet registered — see
[adding a language provider](/opencodehub/contributing/adding-a-language-provider/).

## Deprecation warnings during `npm install -g @opencodehub/cli`

Symptoms: `npm install -g @opencodehub/cli` prints `npm warn deprecated`
lines for transitive packages such as `glob@7.2.3` and `inflight@1.0.6`.

These are cosmetic. They are deprecation notices npm emits for indirect
dependencies pulled in by a SCIP indexer the CLI ships
(`@sourcegraph/scip-python` → `glob` → `inflight`). They are not security
advisories: every published OpenCodeHub release passes osv-scanner, grype,
semgrep, and npm-audit in CI, and pinned `overrides` hold transitive
packages at patched versions. Nothing about the warnings affects install
correctness or runtime behaviour, and there is no action for you to take.

The lockfile-parser warnings (`lodash.clone`, `lodash.isequal`, `uuid@8`)
that earlier releases also emitted are gone as of the native lockfile
parser — the CLI no longer bundles a third-party resolver for dependency
ingestion. The remaining `glob`/`inflight` pair originates inside the
upstream indexer and is tracked for removal once that package updates its
own dependencies.

## More help

- `codehub doctor --verbose` dumps every probe the doctor runs.
- File an issue at
  [github.com/theagenticguy/opencodehub](https://github.com/theagenticguy/opencodehub/issues)
  with the `doctor` output attached.
