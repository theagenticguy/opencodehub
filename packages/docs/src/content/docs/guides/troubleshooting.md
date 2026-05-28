---
title: Troubleshooting
description: Fix install failures, stale indexes, ambiguous-repo errors, and Windows quirks.
sidebar:
  order: 90
---

## Native build failures

Symptoms: `pnpm install` fails while building `@duckdb/node-api`. Error
mentions `node-gyp`, `python`, a C/C++ compiler, or `Visual Studio
Build Tools`.

Fix:

```bash title="probe the native toolchain"
codehub doctor
```

`doctor` checks Node version, the platform's C/C++ toolchain, and
whether each native module can load. Follow the remediation hints it
prints.

The parse runtime is `web-tree-sitter` (WASM) on every supported Node
version, so a missing C/C++ toolchain does not break parsing. The only
native bindings OpenCodeHub loads are `@duckdb/node-api` (temporal store)
and `onnxruntime-node` (the local embedder) — both ship platform
prebuilds, so a normal install does not compile anything. If a prebuild
is missing for your platform, `codehub doctor` reports which module
failed to load and prints the remediation steps.

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

Parsing is WASM, so the parser needs no native toolchain on Windows. The
native bindings (`@duckdb/node-api`, `onnxruntime-node`) ship `win32-x64`
prebuilds, so a standard install pulls a binary rather than compiling.
If a prebuild is unavailable and a module has to build from source, you
need the Microsoft C++ Build Tools plus a matching Python for
`node-gyp`. In practice the fastest fix is to run everything under WSL2 —
WSL2 ships with a working toolchain out of the box and avoids path
separator issues.

If you must stay on native Windows and a source build is forced:

1. Install Visual Studio Build Tools with the "Desktop development
   with C++" workload.
2. Install Python from the Microsoft Store (Python 3.12).
3. `npm config set msvs_version 2022` and `npm config set python
   python3.12`.
4. Re-run `pnpm install --frozen-lockfile`.

## The index is missing a language I expected

Check [supported languages](/opencodehub/reference/languages/). The
default WASM runtime should produce results for every registered
language without a native toolchain. If the language is not listed,
it is not yet registered — see
[adding a language provider](/opencodehub/contributing/adding-a-language-provider/).

## More help

- `codehub doctor --verbose` dumps every probe the doctor runs.
- File an issue at
  [github.com/theagenticguy/opencodehub](https://github.com/theagenticguy/opencodehub/issues)
  with the `doctor` output attached.
