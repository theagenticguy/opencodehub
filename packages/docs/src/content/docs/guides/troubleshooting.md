---
title: Troubleshooting
description: Fix native build failures, stale indexes, ambiguous-repo errors, and Windows quirks.
sidebar:
  order: 90
---

## Native build failures

Symptoms: `pnpm install` fails while building `@duckdb/node-api` or
the optional native tree-sitter N-API addon. Error mentions
`node-gyp`, `python`, a C/C++ compiler, or `Visual Studio Build
Tools`.

Fix:

```bash title="probe the native toolchain"
codehub doctor
```

`doctor` checks Node version, the platform's C/C++ toolchain, and
whether each native module can load. Follow the remediation hints it
prints.

The default parse runtime is `web-tree-sitter` (WASM) on both Node 22
and Node 24, so a missing C/C++ toolchain does not break analyze
itself — only the optional native opt-in via `OCH_NATIVE_PARSER=1` is
affected. `@duckdb/node-api` has a native binding requirement on the
single-file DuckDB fallback; if it cannot load, set `CODEHUB_STORE=lbug`
to use LadybugDB instead, which has its own platform packages.

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

Native tree-sitter and DuckDB builds on Windows require the Microsoft
C++ Build Tools plus a matching Python for `node-gyp`. In practice the
fastest fix is to run everything under WSL2 — WSL2 ships with a
working toolchain out of the box and avoids path separator issues.

If you must stay on native Windows:

1. Install Visual Studio Build Tools with the "Desktop development
   with C++" workload.
2. Install Python from the Microsoft Store (Python 3.12).
3. `npm config set msvs_version 2022` and `npm config set python
   python3.12`.
4. Re-run `pnpm install --frozen-lockfile`.
5. The default parse runtime is WASM, so analyze itself should work
   without the native toolchain — only `@duckdb/node-api` and the
   optional `OCH_NATIVE_PARSER=1` native addon need a native build.

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
