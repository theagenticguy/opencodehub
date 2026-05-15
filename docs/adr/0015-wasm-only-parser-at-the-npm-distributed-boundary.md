# ADR 0015 — WASM-only parser at the npm-distributed boundary

- Status: **Accepted** — 2026-05-15.
- Authors: Laith Al-Saadoon + Claude.
- Branch: `feat/wasm-only-parser-path`.
- Supersedes: [ADR 0013](./0013-parse-runtime-wasm-default.md)
  (parse runtime — WASM default, native opt-in).
- Closes: the bulletproof-install plan at
  `planning/bulletproof-npm-install/plan.md`.

## Context

ADR 0013 established `web-tree-sitter` (WASM) as the default parse
runtime on Node 22 and Node 24, with the native `tree-sitter` N-API
addon as an opt-in second path gated on `OCH_NATIVE_PARSER=1` or the
`--native-parser` CLI flag. That posture preserved a developer-speed
escape hatch for large-repo indexing on Node 22 dev boxes while letting
Node 24 CI run cleanly on WASM.

Maintaining the native opt-in cost the published install graph 14 npm
packages: `tree-sitter` itself plus 13 `tree-sitter-<lang>` grammar
packages. The most damaging of those was `tree-sitter-cli@0.23.2`,
whose `postinstall` reaches GitHub releases to fetch a platform-
specific binary. A 504 from `https://github.com/tree-sitter/tree-sitter/releases/`
in mid-May 2026 broke `npm install -g @opencodehub/cli@latest` for any
consumer with a cold npm cache — even on Node 24, where the native path
was unreachable in the first place. The failing transcript surfaced two
deeper problems:

1. **Native deps stayed in the install graph for a path that was
   default-off and Node-24-unreachable.** The opt-in did not justify
   its cost at the published boundary. Almost every install paid for a
   native compile or postinstall fetch that almost no install ever
   exercised.
2. **The complexity phase (cyclomatic-complexity metrics, at
   `packages/ingestion/src/pipeline/phases/complexity.ts`) used a
   separate `requireFn("tree-sitter")` path that could not use WASM.**
   On Node 24 — already half the supported matrix — complexity counts
   silently degraded to a one-shot stderr warning and zero output. The
   metric was nominal but the data was empty.

The original ADR 0013 rationale (dev-box speed on Node 22) had aged out:
WASM perf had closed enough of the gap that the opt-in's measurable win
no longer justified shipping 14 native packages to every consumer.

## Decision

**WASM is now the only parser path at the npm-distributed boundary.**

1. **Vendor every grammar's `.wasm` blob into
   `packages/ingestion/vendor/wasms/`.** All 15 GA languages are now
   covered by vendored artifacts built from the grammar sources pinned
   in `package.json`. Re-vendoring uses `pnpm dlx` to fetch the grammar
   source ad-hoc — the grammar packages do not need to remain in
   `dependencies` or `devDependencies`.
2. **Drop all 14 native packages from runtime AND devDependencies.**
   `tree-sitter`, `tree-sitter-cli`, and the 12 `tree-sitter-<lang>`
   grammar packages are gone from `packages/ingestion/package.json`.
   `tree-sitter-cli` (the worst offender — its postinstall is the GHCR
   fetch) is no longer in the install graph at any depth.
3. **Remove `OCH_NATIVE_PARSER` and `--native-parser` end-to-end.** The
   env var and CLI flag are hard-removed in 0.4.0. The dispatcher in
   `parse-worker.ts` now has a single code path. The legacy parity test
   between native and WASM is deleted.
4. **Port the complexity phase to `web-tree-sitter`.** Cyclomatic-
   complexity counting now runs on every install instead of degrading
   to a no-op. The phase no longer probes for a native binding.
5. **Lower `engines.node` floor to `>=20.0.0`.** The native ABI
   requirement is gone, so Node 20 LTS is back on the supported matrix.
   The CI install matrix expands from 6 cells to 9: `{Linux, macOS} ×
   {20, 22, 24} × {mise, nvm, Homebrew, Volta}` (Volta ships its own
   shell wrapper that needed a smoke).

## Consequences

- **`npm install -g @opencodehub/cli@latest` is bulletproof.** Zero
  ERESOLVE warnings, zero GHCR fetches in any postinstall, zero native-
  build steps. The install graph has no `node-gyp` dependency, no
  `tree-sitter-cli` postinstall, no platform-specific prebuilds. A 504
  from GitHub releases now affects nothing OCH ships.
- **Tarball size changes.** `@opencodehub/ingestion` grows from ~5 MB
  to ~28 MB because of the 15 vendored `.wasm` files (~28 MB total).
  Net consumer download is **smaller** because the dropped native deps
  used to drag in roughly 50 MB of `.cc` source plus per-platform
  `.node` prebuilds via npm's optional-deps fan-out.
- **Complexity phase fully wired.** The cyclomatic-complexity metric is
  populated on every install, on every supported Node version. No more
  silent zeros on Node 24.
- **CI install matrix gates every release.** 9 cells (Linux/macOS ×
  Node 20/22/24 × mise/nvm/Homebrew/Volta) run a clean `npm install -g`
  on each release tag and assert `codehub --version` exits 0 before the
  tarball is published.
- **Re-vendoring grammars requires running
  `scripts/build-vendor-wasms.sh`.** The script uses `pnpm dlx` to
  fetch the grammar source ad-hoc plus docker / podman / finch / local
  emcc to build the WASM. Not a per-install cost; only run when bumping
  a grammar version.
- **No deprecation shim for the removed env var or flag.** Setting
  `OCH_NATIVE_PARSER` emits a one-shot stderr advisory at CLI startup
  and the variable is then deleted from `process.env`. Passing
  `--native-parser` exits non-zero with commander's "unknown option"
  error. Both behaviours are documented in CHANGELOG entries on the
  root, `@opencodehub/cli`, and `@opencodehub/ingestion`.
- **ADR 0013 is superseded.** Its body is preserved as historical
  record; its top is annotated with a `Superseded by ADR 0015` line.

## Alternatives considered

- **`optionalDependencies` for the 14 native packages.** Rejected.
  Marking the native deps optional only demotes ERESOLVE failures to
  warnings; the postinstall network call from `tree-sitter-cli` would
  still fire on every install with a cold cache, and the failure would
  still surface in CI logs. The cleaner answer is to remove the deps
  from the install graph entirely.
- **An npm `overrides` shim on `tree-sitter-cli` to skip its
  postinstall.** Rejected. The simpler fix (move natives out of
  runtime deps and out of dev deps) already removes `tree-sitter-cli`
  from the graph at every depth. An override would be defensive code
  against a future-maintainer regression that the ADR plus the CI
  install matrix already guard.
- **Keep the native opt-in but document it as devDeps-only.** Rejected.
  The opt-in had measurable use only on Node 22 dev boxes; the same
  developers can run a separate `pnpm dlx tree-sitter` invocation if
  they want native speed for a one-off profiling run. Maintaining two
  parser paths in the source for that ergonomic edge case is not
  worth the install-graph cost or the parity-test surface area.
- **Drop COBOL or one of the smaller languages to avoid vendoring its
  WASM.** Rejected. The vendored-WASM approach scales to all 15 GA
  languages; cutting a language would be a feature regression that
  doesn't move the install-graph problem.

## Migration

- `OCH_NATIVE_PARSER` env var is hard-removed in 0.4.0. Setting it
  emits a one-shot stderr advisory at CLI startup
  (`packages/cli/src/index.ts`, the D10 advisory block) and the
  variable is then deleted from `process.env`.
- `--native-parser` CLI flag is hard-removed in 0.4.0. Passing it now
  exits non-zero with commander's "unknown option" error.
- Existing `.codehub/` indexes are unaffected — the parse-runtime
  switch is upstream of every persisted artifact, so `graphHash`,
  embeddings, summaries, and the temporal store all stay byte-identical
  on re-analyze. Operators do not need to reindex.

## References

- Plan: `planning/bulletproof-npm-install/plan.md`.
- Ultraplan: 3 explorers + critic synthesis at
  `planning/bulletproof-npm-install/explorer-{architectural,speed,simple}.md`
  and `plan.md`.
- Failing install transcript that triggered the work: in the PR
  description for `feat/wasm-only-parser-path`.
- Superseded: [ADR 0013](./0013-parse-runtime-wasm-default.md) — parse
  runtime, WASM default + native opt-in.
- Vendored WASMs: `packages/ingestion/vendor/wasms/` (15 files plus
  the `web-tree-sitter.wasm` runtime, `manifest.json`, `LICENSES.md`).
- Build script: `scripts/build-vendor-wasms.sh`.
- CLI advisory block: `packages/cli/src/index.ts` (the D10 stanza).
