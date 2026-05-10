# ADR 0013 — Parse runtime: WASM default, native opt-in

> Note: there is a sibling ADR — `0013-m7-default-flip-and-abstraction.md`
> — that landed concurrently and shares the same number. Both are kept
> in-tree because they were authored in parallel branches and accepted
> on the same release. The next ADR uses 0014.

- Status: **Accepted** — 2026-05-08.
- Authors: Laith Al-Saadoon + Claude.
- Branch: `feat/node24-wasm-default`.
- Closes: GitHub issues #19 (`@types/node` 20→24), #23 (Node 24 CI matrix).
- Interacts with: the Dependabot unified bump PR #69 (merged 2026-05-08).

## Context

`@opencodehub/ingestion` used the native `tree-sitter` N-API addon as
the default parse runtime with a `web-tree-sitter` WASM fallback behind
an `OCH_WASM_ONLY=1` opt-in. Adding Node 24 to CI was blocked on an
upstream issue: `node-tree-sitter` 0.25.1 fixes the Node 24 ABI break
but the maintainers' npm OIDC publish has been failing since 2025-06
(tree-sitter/node-tree-sitter#276, still open as of 2026-05-08). We had
no visibility into an ETA.

Three downstream questions fell out:

1. How do we get Node 24 into CI without waiting on the publish?
2. Do we keep native as a supported path for Node 22 developer speed,
   or drop it entirely?
3. What do we do about kotlin, swift, dart — the 3 grammar packages
   whose npm tarballs ship only `.node` addons with no `.wasm` asset?

## Decision

**WASM is now the default parse runtime on both Node 22 and Node 24.
Native is an opt-in second path controlled by `OCH_NATIVE_PARSER=1` or
the `--native-parser` CLI flag.**

### Rationale for each question

**(Q1) Node 24.** WASM has no native ABI dependency, so it works on
Node 24 immediately. The CI `test` job now runs a `[ubuntu, macos,
windows] × [22, 24]` matrix (6 cells). Node 22 rows set
`OCH_NATIVE_PARSER=1` to exercise the native path; Node 24 rows leave
the env unset to exercise WASM. Both paths are tested every PR.

**(Q2) Native stays.** Native parsing is measurably faster than WASM
for large-repo indexing. On Node 22, developers still get that speed
via the opt-in. We did not drop the 13 `tree-sitter-<lang>` npm deps
from `packages/ingestion/package.json` — they remain installable, just
not default. `isNativeAvailable()` still probes them at runtime.

**(Q3) Kotlin / Swift / Dart.** Their npm packages ship only native
`.node` bindings. The obvious workaround — the `tree-sitter-wasms`
catalog package — is unusable: its 0.1.13 artifacts were built with
`tree-sitter-cli` 0.20.x, which emits the legacy `dylink` custom
section. `web-tree-sitter` 0.26+ hard-rejects anything that's not the
standardized `dylink.0` section. We verified this at the byte level
(python grammar ships `dylink.0`; tree-sitter-wasms ships `dylink` and
throws at load). So we build our own `.wasm` blobs once, from the
exact grammar sources we pin, and commit them to
`packages/ingestion/vendor/wasms/`. The build script at
`scripts/build-vendor-wasms.sh` reproduces the build via docker /
podman / finch / local emsdk and takes ~3 minutes end-to-end. Zero
grammar-version drift between native and WASM paths.

## Consequences

- **Node 24 is a first-class CI target.** Issue #23 closed.
- **Native-parser dispatch is explicit.** `parse-worker.ts` logs which
  runtime it picked at worker startup; neither path is silent anymore.
- **Parity test covers all 14 tree-sitter languages** (was 3). The suite
  skips cleanly when `isNativeAvailable()` returns false so Node 24 CI
  runs it as a no-op; on Node 22 + `OCH_NATIVE_PARSER=1` it asserts
  byte-identical ParseCapture output across runtimes.
- **Complexity phase has a documented degradation.** The cyclomatic-
  complexity phase at `packages/ingestion/src/pipeline/phases/complexity.ts`
  has an independent `requireFn("tree-sitter")` path that cannot use
  WASM. When native is unavailable, it emits a one-shot stderr warning
  and returns `undefined`; all other parsing continues. Upgrading this
  to WASM is a follow-up (the current `ts-morph`-backed implementation
  depends on native AST walking).
- **`vendor/wasms/` adds 8.1 MB to the repo.** Acceptable vs the
  alternative (emsdk at install time on every dev box + CI runner).
- **Grammar bumps now require a WASM rebuild.** When we bump
  `tree-sitter-kotlin` / `tree-sitter-swift` / `tree-sitter-dart` in
  `package.json`, the `vendor/wasms/*.wasm` files must be rebuilt via
  the committed script and re-committed. The parity test will catch
  forgotten rebuilds on the Node 22 + opt-in CI row.
- **Old flag removed without deprecation shim.** `OCH_WASM_ONLY` is
  gone; the M5 `--wasm-only` CLI flag becomes `--native-parser` (inverse
  meaning). This was a fresh flag from the M5 release with zero
  external consumers.

## Alternatives considered

- **Drop native entirely** — rejected; local dev speed still matters.
- **Pin to an older `web-tree-sitter`** that accepted legacy dylink —
  rejected; pins us to an unmaintained line and doesn't solve future
  per-grammar packages shipping `dylink.0`.
- **Use `tree-sitter-wasms` catalog as-is** — investigated, it doesn't
  load. Documented above.
- **Build `.wasm` at install time via a postinstall** — requires emsdk
  or docker on every developer machine; CI cache strategy becomes a
  headache across the OS × Node matrix. Pre-committing the artifacts
  is simpler, faster, more deterministic.
- **Ship kotlin / swift / dart as native-only** (WASM default for the
  other 13) — considered after `tree-sitter-wasms` was ruled out.
  Rejected because Amazon-internal Finch is available on dev boxes and
  the build worked in one shot, making the extra 8.1 MB of vendored
  wasms the cleaner long-term answer.

## References

- GitHub issue: tree-sitter/node-tree-sitter#276 (publish blocker,
  still open 2026-05-08)
- Lesson: `.erpaval/solutions/architecture-patterns/parse-runtime-wasm-default.md`
  (written post-merge)
- Session trace: `.erpaval/sessions/session-b4fcc7/`
