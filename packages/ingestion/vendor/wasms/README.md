# Vendored tree-sitter WASM grammars

These `.wasm` grammar files are committed to the repo because the upstream
`tree-sitter-{kotlin,swift,dart}` npm packages ship **only** native
(`.node`) bindings — no `.wasm` asset — and the shared
[`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms)
catalog ships WASMs built with tree-sitter-cli 0.20.x that use the legacy
`dylink` section format incompatible with `web-tree-sitter@0.26+` (which
hard-requires the standardized `dylink.0` section).

The WASMs under this directory are built from the **same grammar source
commits pinned in `packages/ingestion/package.json`**, so there is zero
grammar-version drift between native and WASM runtimes.

## Files

| File | Source grammar | Source commit |
|---|---|---|
| `tree-sitter-kotlin.wasm` | `tree-sitter-kotlin@0.3.8` (fwcd) | matches npm `latest` at build time |
| `tree-sitter-swift.wasm` | `tree-sitter-swift@0.7.1` (alex-pinkus) | matches npm `latest` at build time |
| `tree-sitter-dart.wasm` | `UserNobody14/tree-sitter-dart` | git-pinned SHA from package.json |

All three were built with modern `dylink.0` section format and load
cleanly in `web-tree-sitter@0.26.8`.

## How to rebuild

See `scripts/build-vendor-wasms.sh` in the repo root. The script requires
one of `docker`, `podman`, `finch` (on PATH as `docker` via a shim), or a
local `emcc` install, plus `tree-sitter-cli` (installed as part of
`pnpm install`).

```bash
bash scripts/build-vendor-wasms.sh
```

Rebuild when you bump any of the three grammar versions in
`packages/ingestion/package.json`.

## Why not build at install time?

- Requires emscripten or docker on every developer's machine (not in CI
  runner baselines for macOS or Windows).
- Takes ~3 minutes per grammar; slows cold `pnpm install` from seconds to
  minutes.
- CI caching becomes non-trivial across OS + Node matrix cells.

Committing the built artifacts is the simplest, fastest, and most
deterministic approach. The license on each grammar (MIT for kotlin +
dart, MIT for swift) permits redistribution of compiled artifacts.
