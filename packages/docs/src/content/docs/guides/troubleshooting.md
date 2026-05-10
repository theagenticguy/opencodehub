---
title: Troubleshooting
description: Fix native build failures, stale indexes, ambiguous-repo errors, and Windows quirks.
sidebar:
  order: 90
---

## Native build failures (tree-sitter or DuckDB)

Symptoms: `pnpm install` fails while building `tree-sitter`,
`@duckdb/node-api`, or any other native addon. Error mentions
`node-gyp`, `python`, a C/C++ compiler, or `Visual Studio Build Tools`.

Fix:

```bash title="probe the native toolchain"
codehub doctor
```

`doctor` checks Node version, the platform's C/C++ toolchain, and
whether each native module can load. Follow the remediation hints it
prints. As a fallback, run any indexing command with `--wasm-only`
(which sets `OCH_WASM_ONLY=1`) to skip native tree-sitter bindings:

```bash title="force WASM tree-sitter"
codehub analyze --wasm-only
```

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
`error.code: "AMBIGUOUS_REPO"`.

Cause: you have more than one repo indexed in
`~/.codehub/registry.json`, and the tool call did not include a `repo`
argument.

Fix: pass a `repo` argument to every per-repo tool call. The value is
the repo name from `codehub list`. If you are driving the server from
an agent, tell the agent to include `repo` every time.

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
5. If anything still fails, fall back to `codehub analyze --wasm-only`.

## The index is missing a language I expected

Check [supported languages](/opencodehub/reference/languages/). If the
language is listed but returns no symbols, the grammar may have
failed to load natively; retry with `--wasm-only`. If the language is
not listed, it is not yet registered — see
[adding a language provider](/opencodehub/contributing/adding-a-language-provider/).

## More help

- `codehub doctor --verbose` dumps every probe the doctor runs.
- File an issue at
  [github.com/theagenticguy/opencodehub](https://github.com/theagenticguy/opencodehub/issues)
  with the `doctor` output attached.
