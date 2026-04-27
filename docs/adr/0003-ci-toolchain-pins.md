# ADR 0003 — CI toolchain pins (gopls ↔ Go, pnpm build-script allowlist)

Status: **Superseded** — 2026-04-27, by ADR 0006 (SCIP indexer pins)

> The gopls pin matrix below is historical. OpenCodeHub no longer runs
> any long-running language server — code-graph oracle edges are
> sourced from SCIP indexers. See ADR 0005 for the migration and
> ADR 0006 for the current pin table. The pnpm lifecycle-script
> guidance remains in force; ADR 0006 reiterates it.

## Context

Two independent CI regressions kept the `Gym` workflow red on `main` in
April 2026:

1. **`gym (go)` matrix leg** pinned Go 1.23 but installed `gopls@v0.21.0`,
   which requires Go 1.25+ (live `master` `go.mod` on `golang/tools` reads
   `go 1.26.0`). `go install` silently upgraded the toolchain — or failed
   outright on offline runners — instead of producing a `gopls` binary
   compatible with the corpus under test.
2. **Every non-Go leg** failed on `pnpm install` with
   `spawn node-gyp ENOENT`. Root cause is twofold:
   - `pnpm` v10 disables dependency lifecycle scripts by default for
     supply-chain safety; packages that still call `node-gyp rebuild`
     directly (some `tree-sitter-*` grammars) never run their build step
     unless the workspace declares an explicit `pnpm.onlyBuiltDependencies`
     allowlist.
   - Even with the allowlist, the build step fails if `node-gyp` is not on
     `PATH`. The `CI` workflow installs it globally (`ci.yml:51`); the
     `Gym` workflow did not.

Both pins are the kind of drift that will recur: the next Go bump breaks
`gopls`, and the next native-addon dependency gets silently skipped unless
someone remembers to add it to the allowlist. Packet P01 fixes both and
this ADR records the policy so the next maintainer to touch either pin
has the context in-tree.

## Decision

### gopls ↔ Go pinning matrix

CI runs Go **1.23** and installs `gopls@v0.18.1`. The pin is the newest
`gopls` line that builds on Go 1.23 (requires 1.23.4+). When the Go bump
lands, bump `gopls` in lockstep using this table:

| Go toolchain | Newest compatible `gopls` |
|---|---|
| 1.23.4+ | v0.18.x |
| 1.24.2+ | v0.20.x |
| 1.25+   | v0.21.x (also needs 1.26 on master) |

Sources are the `gopls/go.mod` files at each release tag on
`golang/tools`. `gopls` support policy (v0.17.0 release notes) ratcheted to
"latest major only"; from v0.18.0 onward only the two most recent Go majors
are supported for the `go` command `gopls` spawns.

### pnpm.onlyBuiltDependencies allowlist

The workspace root `package.json` lists every package allowed to execute
build scripts during `pnpm install`. Current entries:

- `tree-sitter`
- every `tree-sitter-*` grammar consumed by `@opencodehub/ingestion`
- `@duckdb/node-api`

Adding a new native-binding dependency requires appending its package name
to the allowlist **and** confirming that `node-gyp` (installed globally on
every CI leg via `npm install -g node-gyp@11`) can reach the package. No
runtime code path should depend on `postinstall` side-effects of a package
not in this list.

## Consequences

Positive:

- `Gym` matrix legs are green by default on pushes to `main`; any failure
  now actually signals a regression.
- The next `gopls` or Go bump has a single-source-of-truth pin table in
  this ADR — failures during a drift will be loud and quickly diagnosable.
- `pnpm.onlyBuiltDependencies` is the canonical 2024+ pnpm pattern, so
  future contributors do not inherit an implicit "we turn scripts back on"
  workaround.

Negative / trade-offs:

- Adding a new native dependency now has a 2-line workflow change
  (allowlist + CI smoke) rather than an implicit `postinstall` run.
- The `gopls` pin lags the latest release by one minor line whenever we
  hold back on a Go bump; acceptable because the gym oracle is intentionally
  conservative about toolchain drift.

## Trigger for revisiting

Re-open this ADR when any of the following happens:

1. We bump the Go matrix leg above 1.23 — pick a new `gopls` from the
   table above in the same PR.
2. `pnpm` introduces a new lifecycle-script gate (e.g. a `pnpm@11`
   breaking change) that changes the semantics of
   `onlyBuiltDependencies`.
3. `node-gyp` drops the install-on-PATH contract in favour of a
   per-package bundled version.

## References

- pnpm v10 release + `onlyBuiltDependencies` — https://github.com/orgs/pnpm/discussions/8945
- pnpm docs — https://pnpm.io/package_json#pnpmonlybuiltdependencies
- `gopls` v0.17.0 release notes (support policy) — https://go.googlesource.com/tools/+/HEAD/gopls/doc/release/v0.17.0.md
- `tree-sitter` v0.25.1 `package.json` (uses `node-gyp-build` prebuilt loader) — https://github.com/tree-sitter/node-tree-sitter
- GitHub Linguist submodule-mode filter (precedent for ING-E-002 in the same packet) — https://github.com/github-linguist/linguist
