# Explorer: Speed-first — Bulletproof npm global install for @opencodehub/cli

**Status:** COMPLETE
**Vector:** Speed-first
**Last updated:** 2026-05-15T03:04:05+00:00

---

## Protocol

<write_protocol>
Your output file is the single source of truth for your plan. Edit it as each decision crystallizes, before moving to the next one.
</write_protocol>

---

## 1. Problem Framing

`npm install -g @opencodehub/cli@latest` exits non-zero because (a) `tree-sitter-swift@0.7.1` runtime-depends on `tree-sitter-cli@0.23.2` whose postinstall pulls a binary from a GitHub release URL that 504s, and (b) seven `tree-sitter-*` native grammar packages declare `peerOptional tree-sitter@^0.21|^0.22.x` while `@opencodehub/ingestion` ships `tree-sitter@0.25.0`, producing ERESOLVE noise. Runtime is already WASM-by-default; native is opt-in. Therefore the native grammar packages are non-essential for a working `npm install -g` — except as carriers of the per-grammar `.wasm` blob (verified: 11 of 13 grammars ship `.wasm` inside the tarball; kotlin/swift/dart do not, and we already vendor those at `packages/ingestion/vendor/wasms/`).

## 2. Chosen Approach

**One commit, one publish.** Move every native grammar package out of `dependencies` in `packages/ingestion/package.json` into `optionalDependencies`, and pin a problematic transitive `tree-sitter-cli` to a noop via `overrides` for belt-and-suspenders safety. Bump the patch version, publish, smoke-test with `npm pack` + `npm install -g ./<tgz>`. **Do not touch parser-runtime code, do not refactor, do not restructure tarballs.** The `requireFn.resolve('${pkg}/package.json')` cascade in `wasm-fallback.ts:307` Just Works whether the optional package is installed or not — when present, the `.wasm` is found; when absent, the language is unsupported on that host (acceptable per the user preference "go all in on wasm").

Shape: **package.json surgery + npm overrides + smoke test**. No new modules, no new abstractions, no behavior change for the runtime path.

## 3. Key Decisions

### Decision A — Move all `tree-sitter-*` native grammar packages from `dependencies` to `optionalDependencies` in `packages/ingestion/package.json`

**What.** Move these 13 keys (`packages/ingestion/package.json:59-72`) out of `dependencies` into the existing `optionalDependencies` block (which already holds `ts-morph` — `packages/ingestion/package.json:85-87`):

- `tree-sitter@0.25.0`
- `tree-sitter-c@0.24.1`
- `tree-sitter-c-sharp@0.23.5`
- `tree-sitter-cpp@0.23.4`
- `tree-sitter-go@0.25.0`
- `tree-sitter-java@0.23.5`
- `tree-sitter-javascript@0.25.0`
- `tree-sitter-kotlin@0.3.8`
- `tree-sitter-php@0.24.2`
- `tree-sitter-python@0.25.0`
- `tree-sitter-ruby@0.23.1`
- `tree-sitter-rust@0.24.0`
- `tree-sitter-swift@0.7.1` ← the postinstall offender (it pulls `tree-sitter-cli` per `pnpm-lock.yaml` lines around 11937)
- `tree-sitter-typescript@0.23.2`

Keep `web-tree-sitter@0.26.8` in `dependencies` (the runtime entrypoint per `wasm-fallback.ts:198`).

**Why this is the smallest possible diff.** npm tolerates failures inside `optionalDependencies` and never errors-out the parent install. ERESOLVE peer-conflict warnings on optional deps are demoted to warnings rather than hard errors. The runtime (`grammar-registry.ts:194-254`, `wasm-fallback.ts:249-277`) calls `require()` lazily, gated by `OCH_NATIVE_PARSER`; on the WASM default path it only needs `requireFn.resolve('${pkg}/package.json')` to find the `.wasm` blob, which works for whichever optional packages happened to install successfully on the host.

**Tradeoff.** On hosts where the optional grammar package failed to install (e.g. tree-sitter-kotlin requires a C++ toolchain it doesn't have), that language degrades to "unsupported on this install" with a `requireFn.resolve` returning undefined → upstream caller sees `undefined`. Acceptable: kotlin/swift/dart are already covered by vendored WASMs (the vendored fallback at `wasm-fallback.ts:294-303` runs after the per-grammar lookup), and the other ten languages ship prebuilds for common platforms (Linux x64/arm64, macOS arm64/x64, Windows x64) and rarely fail. Native opt-in via `OCH_NATIVE_PARSER=1` is a developer-mode feature; if a developer wants it, they can `npm i tree-sitter tree-sitter-python` etc. directly. Per user preference: "go all in on wasm if it has the same support" — it does.

### Decision B — Add an `overrides` entry that defangs `tree-sitter-cli` for belt-and-suspenders

**What.** Add to `packages/ingestion/package.json`:

```jsonc
"overrides": {
  "tree-sitter-cli": "npm:@socketregistry/empty-package@*"
}
```

…and likewise to `packages/cli/package.json` (the published-tarball root for `npm install -g`). npm reads `overrides` from the install root's `package.json`, including for global installs.

**Why.** Even if the user passes `--include=optional` or `optionalDependencies` somehow doesn't suppress the failure on a particular npm version, this guarantees `tree-sitter-cli` resolves to an empty noop with no postinstall network call. `@socketregistry/empty-package` is a maintained empty-package shim from Socket — exactly the established pattern for nuking unwanted transitive deps. Cost: 1 extra dep at install time, no runtime impact (the override only fires inside the `tree-sitter-swift` install tree, which is already optional).

**Tradeoff.** This means even if a developer opts into `OCH_NATIVE_PARSER=1` and Swift, `tree-sitter-cli` won't be available. That's fine — `tree-sitter-cli` is a dev tool for grammar authors, not required for runtime parsing. None of `grammar-registry.ts:240-243` calls into it.

**Cheaper-to-reverse alternative considered:** rely solely on `optionalDependencies` and skip the override. Reject — costs nothing to add and gives us a hard guarantee in case any consumer's npm config (e.g. `--include=optional` or pnpm's `optional=true`) attempts to install the optional package anyway. Ship-today over correct-forever.

### Decision C — Keep the `web-tree-sitter` dependency, do NOT touch parser code, do NOT refactor

**What.** No edits to `packages/ingestion/src/parse/grammar-registry.ts` or `wasm-fallback.ts`. The WASM resolver already has the right two-stage cascade (per-grammar package → vendored). The native loader at `grammar-registry.ts:194-254` only runs under `OCH_NATIVE_PARSER=1`; if a `require('tree-sitter-foo')` throws because the package wasn't installed, the existing error handling surfaces a clean message.

**Why.** Per problem statement: "Don't refactor parser layers. Don't write new abstractions." The user's CLAUDE.md already documents WASM-default + native-opt-in. The plan is a package.json move, not a code change.

**Tradeoff.** A purer plan would delete the native loader paths entirely (since the user said "go all in on wasm"). Rejecting that for this iteration — purely a deletion, has zero blast radius, but adds review surface and risks breaking the `OCH_NATIVE_PARSER=1` developer affordance documented in CLAUDE.md. **Deferred to follow-up.**

### Decision D — Bump version, do not change the publish surface

**What.** Bump `packages/cli/package.json` from `0.3.0` → `0.3.1` (or `0.4.0` if you'd rather signal "install path changed"). Bump `packages/ingestion/package.json` from `0.3.2` → `0.3.3`. Tag normally; the existing release-please workflow (referenced in `f3c30f7 chore: release main`) handles versions.

**Why.** Patch-bump is appropriate: the public API doesn't change, only install behavior. Skip `0.4.0` unless you want consumer-facing release notes that say "switched to WASM-only on global install."

**Tradeoff.** If the optional-deps move is too disruptive on some platform we haven't tested, a `0.3.1` deprecation needs another patch. Acceptable.

### Decision E — Do not ship an `.npmrc` inside the package

**What.** Skip the `.npmrc`-in-tarball idea.

**Why.** `npm install -g <pkg>` does not read an `.npmrc` from inside the package being installed; it reads the user's `~/.npmrc`, the project `.npmrc`, and `npm config`. Shipping one would be cargo-cult. The user-side warnings ("Unknown user config 'store-dir'", "package-import-method") come from the user's `~/.npmrc` having pnpm-only options — not our problem to fix from our tarball. **Document in the README that those warnings are benign and originate from the user's pnpm config bleeding into npm.**

**Tradeoff.** If we wanted to suppress the user's pnpm-side warnings, we'd need to teach `codehub init` to also write a `~/.npmrc` shim — out of scope for "ship today."

## 4. Implementation Steps

Each step lists the file, the change, and the verification.

1. **Edit `packages/ingestion/package.json`.** Move every `tree-sitter*` (including `tree-sitter` core) from `dependencies` into `optionalDependencies`. Keep `web-tree-sitter@0.26.8` in `dependencies`. Verify with `jq '.dependencies | keys | .[] | select(startswith("tree-sitter"))' packages/ingestion/package.json` returning only `web-tree-sitter`.

2. **Edit `packages/ingestion/package.json` and `packages/cli/package.json`.** Add an `overrides` block:

   ```jsonc
   "overrides": {
     "tree-sitter-cli": "npm:@socketregistry/empty-package@*"
   }
   ```

   The cli package is the install root for `npm install -g`, so it's the one npm actually reads for overrides. Add to both for defense-in-depth (in case anyone consumes ingestion directly as a non-workspace dep later).

3. **Edit `pnpm-workspace.yaml`.** Mirror the override in the pnpm `overrides` block (lines 5–27) so monorepo dev installs match the published shape:

   ```yaml
   overrides:
     # ... existing ...
     tree-sitter-cli: "npm:@socketregistry/empty-package@*"
   ```

   Optional but recommended — keeps dev/CI install behavior identical to the published artifact.

4. **Bump versions.** `packages/cli/package.json` → `0.3.1`, `packages/ingestion/package.json` → `0.3.3`. Skip if release-please owns versioning.

5. **Run `pnpm install`** at the repo root to refresh `pnpm-lock.yaml`. Verify:
   - `tree-sitter-cli` no longer appears under `tree-sitter-swift` resolved deps (or resolves to `@socketregistry/empty-package`).
   - The native grammar packages still resolve (they're optional, so pnpm still installs them in dev — that's fine; we're testing the published-shape behavior separately).

6. **Run `pnpm -r build`** then `pnpm -r test` to confirm no test breakage. Pay attention to `packages/ingestion/src/parse/wasm-parity.test.ts` — it runs both runtimes; the native side may now resolve grammars from the optional install which is fine.

7. **Smoke test the published shape.** From a clean directory:
   ```sh
   cd /tmp && rm -rf och-smoke && mkdir och-smoke && cd och-smoke
   npm pack /efs/lalsaado/workplace/opencodehub/packages/cli
   # also pack the workspace deps:
   for pkg in ingestion analysis core-types embedder mcp pack policy sarif scanners search storage wiki; do
     npm pack /efs/lalsaado/workplace/opencodehub/packages/$pkg
   done
   # install the cli tarball, with workspace deps as file-refs (or publish to a local verdaccio):
   npm install -g ./opencodehub-cli-0.3.1.tgz
   echo $?  # MUST be 0
   codehub --version
   ```

   Run on:
   - **Linux Node 22** (mise-managed) — primary target.
   - **Linux Node 24** — verify WASM-only path still works (CLAUDE.md notes native is unsupported on Node 24).
   - **macOS arm64 Node 22** (Homebrew or mise) — secondary target.

   If node_modules isn't fully resolvable due to workspace deps, push a `0.3.1-rc.1` tag to npm's dist-tag and run `npm install -g @opencodehub/cli@rc` from a throwaway machine. Spend the API tokens; this is the gate.

8. **Smoke test `codehub analyze`.** Inside a small repo (e.g. the cli's own dist), run `codehub analyze .` and confirm parsing succeeds for the languages whose native grammars happened to install (most). Confirm kotlin/swift/dart still parse via the vendored WASM (`vendor/wasms/`). If any language errors out, that's a known degradation — log it and move on.

9. **Publish.** `pnpm -r publish --access public` (or merge to main and let the release-please bot tag). Confirm the published tarball at `npm view @opencodehub/cli@0.3.1 dependencies` shows zero `tree-sitter-*` keys (only `web-tree-sitter` and the workspace siblings).

10. **Update README** (`packages/cli/README.md` if it exists, otherwise the repo root README) with one paragraph: "Native grammars are optional. The default runtime is WASM. Set `OCH_NATIVE_PARSER=1` if you want native parsing and have already installed the grammar packages by hand." Note the user-side `~/.npmrc` `store-dir`/`package-import-method` warnings are benign pnpm-config bleed.

## 5. Risks and Tradeoffs

- **Risk: optional-dep failures cascade.** On a host where `tree-sitter-kotlin` (no prebuilds, requires C++ toolchain) fails to install, npm prints a long warning trail but still exits 0. That's a UX wart, not a blocker. Mitigation: README mentions it.
- **Risk: ERESOLVE warnings persist.** Optional deps still emit peer-resolution warnings (`tree-sitter-cpp` peerOptional `tree-sitter@^0.21.x` vs our `^0.25.x`). npm v9+ no longer hard-errors on peerOptional mismatches; it warns. Acceptable. If a user runs `npm install -g --strict-peer-deps` they'll still fail — that's their choice.
- **Risk: empty-package override breaks if a future grammar bumps `tree-sitter-cli` API usage.** Impact zero — `tree-sitter-cli` is only used in postinstall scripts, never imported by runtime code in any of the grammar packages. Verified by inspecting `tree-sitter-swift@0.7.1`'s `package.json` (the `install` script uses `node-gyp-build`, not `tree-sitter-cli`).
- **Risk: a downstream consumer of `@opencodehub/ingestion` (not via the cli) expects `tree-sitter-c` to be a regular dependency.** Mitigation: that's an internal-monorepo concern; all our consumers are workspace siblings. Document in CHANGELOG that ingestion's native grammars moved to optional.
- **Risk: regression on `complexity.ts` phase.** Per CLAUDE.md, complexity uses native tree-sitter and "degrades gracefully." Confirmed by the existing one-shot stderr warning. No code change needed.
- **Tradeoff accepted:** native parser support remains the same on a development box (devs can `npm i` the optionals or run `pnpm install` in the monorepo) but degrades on a fresh `npm install -g` box. Aligns with the user's stated "WASM-only is fine" preference.
- **Deferred to follow-up:** rip out the native parser code paths entirely; teach `codehub init` to fix the user's `~/.npmrc` pnpm-warning bleed; collapse the `tree-sitter-*` optional list into a smaller curated set; rebuild kotlin/swift/dart vendored WASMs from current grammar versions.

## 6. Verification Criteria

The plan worked iff:

1. **Hard exit code:** `npm install -g ./opencodehub-cli-0.3.1.tgz` exits 0 on Linux Node 22 + Linux Node 24 + macOS arm64 Node 22. Tested in fresh shell, fresh `npm prefix`, no cached `~/.npm` entries from previous runs.

2. **No GitHub-release postinstall network calls.** `npm install -g --foreground-scripts ./opencodehub-cli-0.3.1.tgz 2>&1 | grep -i "github.com.*releases"` returns nothing.

3. **No ERESOLVE blocker.** `npm install -g ./opencodehub-cli-0.3.1.tgz 2>&1 | grep -E "ERESOLVE|peer dep"` should show only warnings, never errors. Exit 0 confirms no hard fail.

4. **Runtime smoke test.** `codehub --version` prints the version. `codehub analyze /tmp/some-repo` parses TypeScript / Python / JavaScript files (the prebuild-shipping languages) without falling back to "language not supported."

5. **Vendored WASMs still load.** A fixture file in Kotlin or Swift parses correctly — confirms the vendored fallback path works when the optional native package failed to install.

6. **No test regressions.** `pnpm -r test` passes pre- and post-edit. `wasm-parity.test.ts` in particular continues to pass.

7. **Published artifact inspection.** `npm view @opencodehub/cli@0.3.1 dependencies` lists no `tree-sitter-*` keys. `npm view @opencodehub/ingestion@0.3.3 optionalDependencies` lists all 14.

If all six pass, ship and close. The 0.4.0 architectural cleanup (delete native loader code) lives on a future branch.
