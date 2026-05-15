# Plan: Bulletproof npm global install for @opencodehub/cli

**Status:** COMPLETE
**Last updated:** 2026-05-15T03:04:05+00:00
**Explorers:**
- planning/bulletproof-npm-install/explorer-architectural.md
- planning/bulletproof-npm-install/explorer-speed.md
- planning/bulletproof-npm-install/explorer-simple.md

---

## Problem

`npm install -g @opencodehub/cli@latest` exits non-zero on multi-Node-installer systems (mise, nvm, Homebrew, Volta, corepack). It fails across Node 20, 22, and 24 on Linux and macOS. Two compounding issues share one root cause: the published cli pulls 13 native `tree-sitter-*` grammar packages plus `tree-sitter@0.25.0` core through `@opencodehub/ingestion`.

The first issue is a hard error. `tree-sitter-swift@0.7.1` runtime-depends on `tree-sitter-cli@0.23.2`. That package's postinstall fetches a platform binary from `github.com/tree-sitter/tree-sitter/releases`. The fetch currently 504s and `npm install` aborts with a non-zero exit.

The second issue is the noise floor. Each of the 13 native grammars carries `peerOptional tree-sitter@^0.21|0.22|0.23` while ingestion ships `tree-sitter@0.25`. The mismatch produces ERESOLVE peer-dep warnings on every install.

The runtime is already WASM-by-default per `CLAUDE.md`. Native is opt-in via `OCH_NATIVE_PARSER`. So the fix is to make the published surface match the published runtime: ship WASM-only, vendor every grammar's `.wasm` blob into the ingestion tarball, and quarantine native tree-sitter to dev workspace dependencies.

### npm vs pnpm install mechanics

`npm install` reads `dependencies` and `optionalDependencies` from the install root's `package.json` and runs `preinstall`, `install`, and `postinstall` lifecycle scripts on every package in the resolved graph. The user can suppress those via `--ignore-scripts`, but our published cli should not require that flag. The `overrides` field in the install-root `package.json` lets npm rewrite any transitive dep, including swapping it for a no-op shim.

pnpm differs in two ways. It reads its own `pnpm.overrides` block from `pnpm-workspace.yaml` (or the workspace root `package.json`). And it gates lifecycle-script execution behind `pnpm-workspace.yaml`'s `onlyBuiltDependencies` (a.k.a. `allowBuilds`).

The cli is published to npm. The install root for `npm install -g @opencodehub/cli` is the cli's own `package.json`. The right architectural move is to delete the failing transitive deps at the source. The `overrides` field is then cheap insurance against any future grammar package re-introducing `tree-sitter-cli`.

## Chosen Approach

Shape: WASM-only at the publish boundary. Vendor every grammar. Belt-and-suspenders override on `tree-sitter-cli`. One PR. One bumped major-ish version (0.4.0). One publish.

Six anchors hold the plan together.

First, single parser path. We delete `OCH_NATIVE_PARSER` and `--native-parser` from the runtime. `web-tree-sitter` reading vendored `.wasm` blobs becomes the only path. All three explorers converge on this. The user's stated preference, "go all in on wasm if it has the same support and if it's less confusing", is the deciding factor.

Second, vendor all 15 WASM grammars into `packages/ingestion/vendor/wasms/`. The ingestion tarball ships them. Runtime resolves by file path against the package root. There is no `require.resolve` cascade. (Source: Architectural plus Simple. Both reject the two-stage cascade once natives leave runtime deps.)

Third, quarantine native tree-sitter to `devDependencies`. Native `tree-sitter@0.25.0`, the 13 native grammars, and `tree-sitter-cli` survive in the workspace for the parity test, complexity comparison runs, and `scripts/build-vendor-wasms.sh`. They never enter the published cli's install graph. (Source: Architectural Decision E.)

Fourth, port the complexity phase to web-tree-sitter. `verdict.ts:101,688` consumes `cyclomaticComplexity > 10` to set risk tiers, so deletion is a regression. The port is mechanical. Every API the walker uses (`rootNode`, `child`, `childCount`, `childForFieldName`, `text`, `startPosition`, `endPosition`, `type`) exists with identical semantics on `web-tree-sitter`'s `Node`. (Source: Simple Decision C, anchored on `verdict.ts:101,688` as a real consumer.)

Fifth, an npm `overrides` shim on `tree-sitter-cli`. We add `"tree-sitter-cli": "npm:npm-empty-package@1.0.0"` to `packages/cli/package.json` and `packages/ingestion/package.json`. We also mirror the entry into `pnpm.overrides` in `pnpm-workspace.yaml`. Even after we move natives to devDeps, this guarantees no future grammar bump can re-introduce `tree-sitter-cli` into a published install graph. The runtime cost is zero. (Source: Speed Decision B, the safety net the other two missed.)

Sixth, lower the `engines.node` floor to `>=20.0.0`. WASM has no Node-version constraint. Native ABI was the only reason the floor was 22+. (Source: Architectural Decision F.)

A 9-cell CI install matrix gates each release. The cells span Linux x64 Node 20/22/24 (mise, nvm), Linux arm64 Node 22, macOS arm64 Node 22 via Homebrew/nvm/Volta, and macOS x64 Node 22 via nvm. (Source: Architectural Decision F plus Simple Decision D's docker harness.)

### Where the explorers diverged, and how this plan resolved it

The Speed-first plan kept native as `optionalDependencies` so we could ship today without touching parser code. The Architectural and Simple plans both delete the second path now. This plan goes WASM-only now. Three reasons drove that call. The user said "less confusing" matters. The parity test (`wasm-parity.test.ts`) already proves WASM produces equivalent output. And `optionalDependencies` does not solve the ERESOLVE warnings; it only demotes them. The user asked for zero warnings, not "demoted".

We still adopt Speed's `overrides` shim. Even with native deps gone from runtime today, a future maintainer accidentally re-adding one is a single `pnpm-lock.yaml` regression away. A grammar transitively re-introducing `tree-sitter-cli` is the same risk. The override is the architectural guardrail that survives whoever reads this plan in 18 months.

The major axis the explorers agreed on: the architectural fix is "the published surface declares only what the published runtime actually loads" (Architectural §1). All three explorers identify the same root cause and the same mechanical inventory of files. Architectural §3-A and Simple §A.2 cite the same line ranges in `parse-worker.ts` for deletion. Both cite the same complexity-port mechanism. Both vendor 15 WASMs. This is not a coin flip. Three independent agents converged on the same target shape, including the same 600+ LOC deletion ledger.

## Decisions

### D1. Parser runtime: WASM-only, native deleted from runtime

**Call.** Delete the native parse path from runtime code. `web-tree-sitter` is the only runtime parser host. `OCH_NATIVE_PARSER` and `--native-parser` are hard-removed in 0.4.0 with no soft-deprecation window.

**Source.** Simple Decision F (hard removal because there is no second user; the M5-era opt-in audience is opencodehub maintainers who can run from source). Reinforced by Architectural Decision A (5 equivalence classes of native-vs-WASM behavior collapse to 1).

**Reason.** The parity test (`packages/ingestion/src/parse/wasm-parity.test.ts`) already asserts capture-set equivalence between native and WASM. The user explicitly chose WASM. Keeping a deprecation alias adds review surface for zero user-value.

**Tradeoff.** Anyone running a script with `--native-parser` gets a clean commander error on first run after upgrade. CHANGELOG and stderr advisory cover the path forward. We rejected Architectural's "soft-deprecate for one release" because the flag's only documented audience is workspace developers, not npm-install consumers.

### D2. Grammar artifacts: vendor all 15 WASMs

**Call.** Vendor all 15 grammar `.wasm` files into `packages/ingestion/vendor/wasms/` plus `web-tree-sitter`'s own runtime `.wasm`. Resolver collapses to a single declarative `LanguageId → vendor/wasms/<file>.wasm` map. No `require.resolve` cascade.

**Source.** Architectural Decision B plus Simple Decision B (both converge on file-path-based lookup; Architectural is the named source for "vendoring is the boundary").

**Reason.** Once native grammar packages leave `dependencies`, the existing two-stage cascade in `wasm-fallback.ts:249-303` has no per-package source to find. Stage 1 becomes dead code. The runtime should know exactly where its assets live, not heuristically `require.resolve` into a `node_modules` shape that may not exist on a global install.

**Mechanics.** For 12 grammars that ship a `.wasm` inside their npm tarball (typescript/tsx, javascript, python, go, rust, java, csharp, c, cpp, ruby, php), copy from `node_modules/.pnpm/tree-sitter-<lang>@<v>/...` (Source: Simple §B.1 step 1; `cp` is faster and reproduces upstream's artifact exactly). For the 3 that don't (kotlin, swift, dart), use `tree-sitter build --wasm` (existing logic in `scripts/build-vendor-wasms.sh`).

**Tradeoff.** Tarball size grows from ~5 MB to ~28 MB for `@opencodehub/ingestion`. Net global-install download is **smaller** than today because the existing native deps drag in `.cc` source plus `.node` prebuilds for every platform (often ~50 MB+ across all 13 grammars).

### D3. Complexity phase: port to WASM, do not delete

**Call.** Port `packages/ingestion/src/pipeline/phases/complexity.ts` from native `requireFn("tree-sitter")` to `web-tree-sitter` against the vendored WASM. Stay on the main thread. Re-parse via WASM. Absorb the ~1.5x parse cost.

**Source.** Simple Decision C, anchored on the fact that `verdict.ts:101,688` consumes `cyclomaticComplexity > 10` to set risk tiers. Deletion would be an observable regression for `verdict` users. Architectural Decision G converges on the same port.

**Reason.** The walker code at `complexity.ts:370-509` already operates against a `TsNode` interface that matches both bindings. `web-tree-sitter`'s Node API is the upstream reference. Semantics are identical. Architectural's "move complexity into the parse worker" idea is correct long-term but bigger than this PR. We file it as a follow-up.

**Architectural win.** Complexity is silently zero today on Node 24 default and Node 22 default (no `OCH_NATIVE_PARSER` set). After this port, every default install gets full complexity metrics. We fix a hidden quality-of-result regression along the way. (Source: Architectural Decision G's framing.)

### D4. Published `dependencies`: native packages move to `devDependencies`

**Call.** Move 14 packages (`tree-sitter@0.25.0` plus 13 `tree-sitter-<lang>` grammars) from `packages/ingestion/package.json` `dependencies` (lines 59-72) to `devDependencies`. Add `tree-sitter-cli` as an explicit root `devDependency` so `scripts/build-vendor-wasms.sh` keeps working after `tree-sitter@0.25.0` stops pulling it transitively. Keep `web-tree-sitter@0.26.8` in `dependencies`.

**Source.** Architectural Decision E (the table at lines 312-325 is the operational specification). Simple Decision A.1 converges on the same 14 deps.

**Reason.** This single change resolves both surface failures simultaneously. (a) `tree-sitter-swift` is no longer in the runtime install graph, so its `tree-sitter-cli` postinstall never runs. The GHCR 504 disappears. (b) The peer relationship between `tree-sitter@0.25` and the grammars' `peerOptional tree-sitter@^0.21|0.22|0.23` is no longer in the published runtime graph. Zero ERESOLVE warnings remain.

**Why not `optionalDependencies` (Speed Decision A's path).** `optionalDependencies` demotes ERESOLVE to warnings. It does not eliminate them. The user asked for "fix all ERESOLVE peer warnings". The only way to zero them is to remove the peer relationship entirely from the install graph.

### D5. ~~Belt-and-suspenders: `tree-sitter-cli` override~~ — DROPPED

User decision (2026-05-15): drop the override. D4 already removes `tree-sitter-swift` (the sole consumer of `tree-sitter-cli` in `pnpm-lock.yaml`) from the runtime install graph. The override was Speed Decision B's belt-and-suspenders shim against a future maintainer regression. The durable answer is the ADR (D10) plus the CI install matrix (D-Verification) catching any regression at PR time, not a supply-chain shim.

### D6. Resolver collapse: single declarative table

**Call.** Rewrite `packages/ingestion/src/parse/wasm-fallback.ts:222-303` from a two-stage cascade (`tryPerGrammarPackage` → `tryVendoredWasm`) to one declarative `Record<LanguageId, string>` map plus a single `path.resolve(VENDOR_WASMS_DIR, fname)` call. Rename the file `wasm-fallback.ts` → `wasm-runtime.ts`. (It isn't a fallback when it's the only path.) Add `Parser.init({ locateFile: () => fileURLToPath(new URL("../../vendor/wasms/web-tree-sitter.wasm", import.meta.url)) })` so the runtime WASM resolves against the vendored copy.

**Source.** Architectural Decision F's `locateFile` insight plus Simple Decision E.2 collapse-to-flat-table directive (332 → ~120 lines).

**Reason.** Per Architectural Decision I §3, `tryPerGrammarPackage` returns undefined for every language after D4. Stage 1 is unreachable code. A single source of truth for "where's the WASM for X" is mechanically simpler to test, debug, and update.

### D7. `engines.node`: lower to `>=20.0.0`

**Call.** Change `packages/cli/package.json:80-82` and `packages/ingestion/package.json:105-107` from `>=22.0.0` to `>=20.0.0`.

**Source.** Architectural Decision F.

**Reason.** The 22+ floor was added because of native tree-sitter ABI requirements. Once native is gone from runtime, WASM has no Node-version dependency. `web-tree-sitter` runs on Node 18+. Node 20 is current LTS. Restricting to 22+ is unnecessarily aggressive.

**Tradeoff.** Simple §340 argued to keep `>=22.0.0` for a "fail fast outside the supported runtime" contract. We rejected. Node 20 is current LTS, and the only reason to exclude it was a constraint we're deleting.

### D8. Version bump: 0.4.0 (semver-major-ish behavior change)

**Call.** Bump `packages/cli/package.json` and `packages/ingestion/package.json` to **0.4.0**. Use a `feat!:` conventional commit so release-please tags it as a breaking change.

**Source.** Architectural §2 plus Simple Decision G converge. Reject Speed Decision D's 0.3.1 patch bump.

**Reason.** This release removes a documented CLI flag (`--native-parser`) and a documented env var (`OCH_NATIVE_PARSER`). It changes the ingestion tarball layout. It lowers the engines floor. That is semver-breaking behavior. A patch bump understates the change to anyone watching dist-tags.

### D9. Workspace publish hygiene: `prepublishOnly` verification gate

**Call.** Add `prepublishOnly: "node scripts/verify-vendor-wasms.mjs"` to `packages/ingestion/package.json:35-39`. The verify script asserts three things: (a) all 15 expected `.wasm` files exist in `vendor/wasms/`; (b) each has valid WASM magic bytes; (c) each matches the grammar version pinned in `pnpm-lock.yaml` via a `vendor/wasms/manifest.json` written by the build script.

**Source.** Architectural Decision H §1.

**Reason.** This is the durable safety net for grammar drift. About 50 LOC of script prevents an entire class of silent regression where a maintainer bumps a grammar version but forgets to rebuild the vendored WASM.

### D10. Migration messaging: stderr advisory plus commander unknown-flag

**Call.** At cli startup, if `process.env["OCH_NATIVE_PARSER"]` is set, emit one stderr line: `[codehub] OCH_NATIVE_PARSER was removed in 0.4.0; WASM is the only parser runtime. Unset to silence this warning.` Then `delete process.env["OCH_NATIVE_PARSER"]`. For `--native-parser`, do NOT add a deprecation alias. Let commander reject as unknown.

**Source.** Simple Decision F.

**Reason.** The loudest possible signal is a hard error. Anyone with the flag in a script reads the CHANGELOG, deletes the flag, and moves on. Total user-impact cost is minutes per script. The only audience for the env var is opencodehub maintainers who already track the repo.

## Implementation Order

One PR titled `feat!: WASM-only parser path; drop native tree-sitter and tree-sitter-cli`. Each step gates the next via the listed verification.

1. **Vendor the 11 missing WASMs (no behavior change yet).**
   - Edit `scripts/build-vendor-wasms.sh` to add 11 `cp` lines pulling each `tree-sitter-<lang>.wasm` from `node_modules/.pnpm/tree-sitter-<lang>@<v>/.../tree-sitter-<lang>.wasm` (Source: Simple §B). Keep the existing `tree-sitter build --wasm` logic for kotlin, swift, dart.
   - Also vendor `web-tree-sitter`'s own runtime wasm to `packages/ingestion/vendor/wasms/web-tree-sitter.wasm` (Source: Architectural Decision D).
   - Run the script. Commit 11 new `.wasm` files plus `web-tree-sitter.wasm` plus a new `packages/ingestion/vendor/wasms/manifest.json` recording the grammar version each `.wasm` was built against (Source: Architectural Decision D).
   - Add `packages/ingestion/scripts/verify-vendor-wasms.mjs`. The script asserts all 15 grammars exist, checks valid WASM magic bytes, and confirms the manifest matches `pnpm-lock.yaml` versions (Source: Architectural Decision H §1).
   - Wire `prepublishOnly: "node scripts/verify-vendor-wasms.mjs"` into `packages/ingestion/package.json:35-39`.
   - **Verify.** `ls packages/ingestion/vendor/wasms/*.wasm | wc -l` returns 16 (15 grammars plus 1 web-tree-sitter runtime). `node packages/ingestion/scripts/verify-vendor-wasms.mjs` exits 0. `pnpm pack -C packages/ingestion` produces a tarball ~28 MB containing all 16 `.wasm` files.

2. **Switch the WASM resolver to vendored-only path (still backward-compatible).**
   - Rewrite `packages/ingestion/src/parse/wasm-fallback.ts:222-303` to one declarative `Record<LanguageId, string>` map plus `path.resolve(VENDOR_WASMS_DIR, fname)`. Delete `tryPerGrammarPackage`, `tryVendoredWasm`, `resolvePackageDir`, and the 70-line two-stage-cascade comment.
   - Rename `wasm-fallback.ts` → `wasm-runtime.ts`. Update import sites (`parse-worker.ts`, `index.ts`, `complexity.ts`, `grammar-registry.ts`).
   - Add `Parser.init({ locateFile: () => fileURLToPath(new URL("../../vendor/wasms/web-tree-sitter.wasm", import.meta.url)) })` to `ensureWasmRuntime` (Source: Architectural Decision F).
   - **Verify.** `pnpm -C packages/ingestion test --grep wasm-grammar-resolution` passes. `pnpm -C packages/ingestion test --grep wasm-parity` passes. The parity test still loads native from workspace `node_modules`, so dev behavior is unchanged.

3. **Port `complexity.ts` from native to WASM.**
   - `packages/ingestion/src/pipeline/phases/complexity.ts:78, 106-136`. Replace the `requireFn("tree-sitter")` shim with an `ensureWasmRuntime` import. Build per-language `web-tree-sitter` Parser, cached.
   - Delete `getTsModule`, `parserCache` (native-typed), `tsModuleCached`, `warnedComplexityDegraded`, and the `OCH_NATIVE_PARSER` stderr advisory at `complexity.ts:108-119`.
   - Delete the 8 `Ts*` ambient interfaces. Reuse `WasmNode` types from `wasm-runtime.ts`.
   - **Verify.** `pnpm -C packages/ingestion test --grep complexity` passes on Node 20, 22, and 24 with no env vars set. Hand-craft a 15-decision-point function in a fixture and assert `verdict` bumps a tier on it (Source: Simple Verification §9; this confirms the `verdict.ts:101,688` consumer still works).

4. **Delete the native parser path from runtime code.**
   - `packages/ingestion/src/parse/parse-worker.ts:51-78, 156-191, 222-307`. Delete `forceNativeOpt`, `runNative`, `getOrBuildParser`, `getOrBuildQuery`, the runtime-triage warning, and all 8 `TreeSitter*` ambient interfaces. File shrinks from 308 to ~140 lines.
   - `packages/ingestion/src/parse/wasm-runtime.ts` (new name from step 2). Delete `isNativeAvailable`, `cached`, `resetNativeAvailabilityCache`.
   - `packages/ingestion/src/parse/index.ts:18`. Drop the `isNativeAvailable, resetNativeAvailabilityCache` re-export.
   - `packages/ingestion/src/parse/grammar-registry.ts:193-277`. Delete `loadLanguageObject`. Drop `tsLanguage` from `GrammarHandle` (`grammar-registry.ts:117-122`). Inline `loadGrammar` into a 1-line query-text fetcher. Drop the inflight-dedupe Map; it existed to avoid duplicate native `require()` calls. File shrinks from 337 to ~80 lines.
   - **Verify.** `pnpm -C packages/ingestion test --grep parse-worker` passes. Cases (b), (c), and (d), the `OCH_NATIVE_PARSER` cases, are deleted. The remaining tests prove WASM-only parse output matches the existing ParseCapture fixtures.

5. **Delete `wasm-parity.test.ts` and trim `parse-worker.test.ts`.**
   - `packages/ingestion/src/parse/wasm-parity.test.ts` exists only to assert WASM-vs-native equivalence. Without a runtime native path the test references nothing that ships. Delete it entirely (~330 lines). We keep native `tree-sitter` in workspace `devDependencies` for the build script. The parity assertion is no longer needed because parity has already shipped (Source: Simple Decision E §1; Architectural Decision J keeps the test, Simple deletes it; we picked Simple because the test's prior architectural justification, "anchor that lets us delete native with confidence", is satisfied by this PR landing successfully).
   - `packages/ingestion/src/parse/parse-worker.test.ts`. Delete cases (b), (c), (d). If only one trivial case remains, delete the file.
   - **Verify.** `pnpm -C packages/ingestion test` passes. Lost test count matches the deletion ledger.

6. **Soft-clean the CLI flag and env var.**
   - `packages/cli/src/index.ts:88-91, 102-107`. Delete the `--native-parser` option declaration and the env-var setter (Source: Simple §A.2).
   - At cli startup (before `commander.parse`), add the one-shot stderr advisory plus `delete process.env["OCH_NATIVE_PARSER"]` from D10.
   - **Verify.** `pnpm -C packages/cli test` passes. `node packages/cli/dist/index.js --native-parser foo` exits non-zero with commander's "unknown option" error.

7. **Move 14 native deps out of runtime; add `tree-sitter-cli` as devDep.**
   - `packages/ingestion/package.json:59-72`. Move `tree-sitter@0.25.0` and the 13 `tree-sitter-<lang>` keys from `dependencies` to `devDependencies`. Keep `web-tree-sitter@0.26.8` in `dependencies`.
   - Workspace root `package.json`. Add `tree-sitter-cli` as a `devDependencies` entry so `scripts/build-vendor-wasms.sh` keeps working after `tree-sitter@0.25.0` stops pulling it transitively.
   - `pnpm-workspace.yaml:66-83`. Delete 15 tree-sitter `allowBuilds` entries (`tree-sitter`, all 13 grammars, plus tree-sitter-dart). Keep `tree-sitter-cli: true` for the build-vendor-wasms script (Source: Simple §A.3).
   - Run `pnpm install` to refresh `pnpm-lock.yaml`. Verify `tree-sitter-cli` no longer appears as a transitive of any runtime dep.
   - **Verify.** `jq '.dependencies | keys | .[] | select(startswith("tree-sitter"))' packages/ingestion/package.json` returns only `web-tree-sitter`. `pnpm -r build && pnpm -r test` is green.

8. **Lower engines floor.**
   - `packages/cli/package.json:80-82` and `packages/ingestion/package.json:105-107`. Change `>=22.0.0` to `>=20.0.0`.
   - **Verify.** `node --version` on a Node 20 install plus `pnpm pack && npm install -g <tarball>` succeeds and `codehub --version` runs.

9. **Documentation, ADR 0015, CHANGELOG.**
    - Update `CLAUDE.md` "Parse runtime — WASM default, native opt-in" section (lines 96-107) to "Parse runtime — WASM-only, vendored grammars". Drop the `OCH_NATIVE_PARSER` row.
    - Strip `OCH_NATIVE_PARSER` and `--native-parser` from the 11 docs files Architectural Decision J §3 enumerates: `packages/cli/README.md:79`, `packages/docs/src/content/docs/guides/indexing-a-repo.md:130`, `packages/docs/src/content/docs/guides/troubleshooting.md:27,80`, `packages/docs/src/content/docs/architecture/parsing-and-resolution.md:25`, `packages/docs/src/content/docs/architecture/adrs.md:126`, `packages/docs/src/content/docs/reference/configuration.md:31,33`, `packages/docs/src/content/docs/reference/languages.md:53,55`, `packages/docs/src/content/docs/reference/cli.md:40`, `packages/docs/src/content/docs/start-here/what-is-opencodehub.md:68`, `packages/docs/src/content/docs/start-here/install.md:15,112`, root `README.md:83,234-236`, `packages/ingestion/README.md:25,57`.
    - Mark ADR 0013 superseded. Write `docs/adr/0015-wasm-only-parser-at-the-npm-distributed-boundary.md` with the install-failure trigger and the deletion ledger. (ADR 0015 already exists at HEAD covering scip-references-and-embedder-fingerprint, so this plan uses 0015 as next available.)
    - Add CHANGELOG entries to `packages/ingestion/CHANGELOG.md`, `packages/cli/CHANGELOG.md`, and root `CHANGELOG.md` describing the breaking change.
    - **Verify.** `rg -n 'OCH_NATIVE_PARSER|--native-parser' packages/ docs/` returns hits only inside CHANGELOG entries.

10. **Bump versions to 0.4.0.**
    - `packages/cli/package.json` and `packages/ingestion/package.json` to `0.4.0`. Conventional commit: `feat!: WASM-only parser path; drop native tree-sitter from runtime`. Release-please will tag accordingly.
    - **Verify.** `pnpm -r build && pnpm -r test` is green at the bumped version.

11. **Add the CI install-matrix workflow.**
    - New file `.github/workflows/verify-global-install.yml` runs the 9-cell matrix from D-Verification on every push to main and every release tag.
    - New file `scripts/verify-global-install.sh` (Source: Simple Decision D's docker harness). It publishes an RC dist-tag, then for each `(os, node, installer)` cell runs `npm install -g @opencodehub/cli@rc` in a clean shell, asserts exit 0, runs `codehub --version`, and runs `codehub analyze tests/fixtures/multi-lang/`.
    - **Verify.** Workflow goes green for all 9 cells against an RC tag before promoting to `latest`.

12. **Local smoke test + open PR (do NOT publish from this session).**
    - Run `scripts/verify-global-install.sh local` against a locally-packed tarball.
    - Push branch and open PR. Maintainer merges; release-please tags 0.4.0; CI matrix gates the publish.
    - **Verify.** Zero `WARN`, zero `ERR! ERESOLVE`, zero GHCR fetches in stderr. Install completes in <60 s on a baseline runner with cold npm cache.

## Risks

The three load-bearing tradeoffs are the axes where the explorers diverged most.

The first is "ship WASM-only now" versus the `optionalDependencies` bandaid (Speed-first). We resolved in favor of now. `optionalDependencies` does not zero out ERESOLVE warnings; it only demotes them, and the user asked for zero. Keeping a second runtime path forever costs more than the work the WASM-only path requires. Five equivalence classes, parity test maintenance, doc surface, support questions add up. Mitigation if WASM perf becomes a real blocker: the runtime-native branch in `parse-worker.ts` lives in git history. The diff is scoped enough to restore behind a flag in about a day of work.

The second is whether to delete `wasm-parity.test.ts` (Simple) or keep it as a dev-only invariant (Architectural). We resolved in favor of delete. Architectural's argument was that the parity test is the architectural anchor that lets us delete the runtime native path with confidence. That anchor's job ends when this PR lands. Once native is gone from runtime, parity is no longer needed because there's no runtime path to protect against drift. Keeping it costs a workspace devDep on 14 native packages forever, plus a Node-22-only test gate in CI. The decision is reversible. If a future bug suggests WASM-vs-native semantic drift, restore the test from git.

The third is the `>=20.0.0` engines floor (Architectural) versus keeping `>=22.0.0` (Simple). We resolved in favor of `>=20.0.0`. Node 20 is current LTS through 2026. The 22+ floor was added because of a constraint we're deleting. The risk is that some `web-tree-sitter@0.26+` Node 20 incompat surfaces. The Linux x64 Node 20 cell of the install matrix catches it.

Other risks deserve mention.

Tarball size grows. `@opencodehub/ingestion` goes from ~5 MB to ~28 MB published. Net global-install download is **smaller** because the existing native deps drag in `~50 MB+` of `.cc` source plus `.node` prebuilds across all 13 grammars. Acceptable. If repo size becomes a complaint, a follow-up moves vendored WASMs to git LFS.

A grammar version bump could produce an incompatible WASM. The `verify-vendor-wasms.mjs` script (D9) checks the manifest against `pnpm-lock.yaml`. Without the script, a maintainer who bumps `tree-sitter-foo` in `devDependencies` without re-running `scripts/build-vendor-wasms.sh` would silently ship an old WASM. With the script, the `prepublishOnly` hook fails loud.

`web-tree-sitter@0.26+` may have Node 24 quirks. The Linux x64 Node 24 cell of the install matrix catches them. If a real blocker, hold the release and pin `web-tree-sitter` forward or backward. Do not restore native.

A `tree-sitter-cli` postinstall failure could resurface from a different transitive path. The `overrides` from D5 are the permanent guardrail. CI also asserts no postinstall network calls beyond the registry (audit script in install-matrix workflow).

A user's `~/.npmrc` may have pnpm-only options bleeding into npm. Speed Decision E identified this as out-of-scope. The warnings are benign. The README adds one paragraph noting that `Unknown user config 'store-dir'` and `package-import-method` warnings originate from the user's pnpm config and are safe to ignore.

Rollback story. If 0.4.0 fails in the wild, `npm dist-tag add @opencodehub/cli@0.3.0 latest` rolls back globally. Users with `0.4.0` installed re-run `npm install -g @opencodehub/cli@0.3.0`. The 0.4.0 tarball stays on the registry but loses the `latest` tag.

## Verification Criteria

The 9-cell install matrix runs on every release tag. All cells must exit 0 before `latest` is promoted (Source: Architectural Decision F plus Simple Decision D harness):

| OS | Arch | Node | Installer | Verifies |
|----|------|------|-----------|----------|
| Linux | x64 | 20.x | mise | engines satisfied; install succeeds; `codehub --help` runs |
| Linux | x64 | 22.x | mise | plus `codehub analyze <fixture>` runs |
| Linux | x64 | 24.x | mise | WASM-only Node 24 path |
| Linux | x64 | 22.x | nvm | tilde-path resolution |
| Linux | arm64 | 22.x | mise | proxy for Apple Silicon |
| macOS | arm64 | 22.x | Homebrew | libuv plus brew prefix paths |
| macOS | arm64 | 22.x | nvm | `$HOME/.nvm/versions/...` |
| macOS | arm64 | 22.x | Volta | shim-based PATH |
| macOS | x64 | 22.x | nvm | Intel Mac smoke |

Each cell runs (Source: Architectural §6 plus Simple Decision D):
```sh
pnpm pack -C packages/ingestion
pnpm pack -C packages/cli
npm install -g ./packages/cli/opencodehub-cli-*.tgz \
                ./packages/ingestion/opencodehub-ingestion-*.tgz
test $? -eq 0                                          # hard exit-code gate
codehub --version                                       # exits 0
codehub --help                                          # exits 0
codehub analyze tests/fixtures/multi-lang/              # exits 0
codehub query 'export default'                          # at least one hit
```

Each cell enforces 5 hard gates.

1. `npm install -g` exits 0. No `ERR! ERESOLVE`. No `npm ERR!` of any kind.
2. `npm install -g --foreground-scripts <tarball> 2>&1 | grep -iE "github\.com.*releases|tree-sitter-cli"` returns nothing. Zero GHCR postinstall fetches in the install graph.
3. `npm install -g <tarball> 2>&1 | grep -E "ERESOLVE|peer dep"` returns nothing. Zero ERESOLVE warnings, not "demoted", zero.
4. Install completes in **under 60 s** on a baseline runner with cold npm cache. Hard regression gate.
5. Audit script. No `package.json` in the resolved install graph contains `wget`, `curl`, `download`, `node-gyp rebuild`, or `prebuild-install` in any lifecycle script (Source: Architectural §6 distribution gates).

Unit and integration tests must pass before bump.

- `packages/ingestion/src/parse/parse-worker.test.ts`. Single-path WASM tests. Native cases removed.
- `packages/ingestion/src/parse/wasm-grammar-resolution.test.ts`. Every `LanguageId` resolves to a `vendor/wasms/<file>.wasm` path that exists on disk.
- `packages/ingestion/src/pipeline/phases/complexity.test.ts`. Passes on Node 20, 22, and 24 with non-zero `cyclomaticComplexity` output.
- New: `packages/analysis/src/verdict.test.ts` (or equivalent). Hand-crafts a 15-decision-point function and asserts `verdict` bumps a tier (Source: Simple Verification §9; this is the assertion that the `complexity → verdict` pipeline still works after the WASM port).
- `tests/fixtures/multi-lang/` end-to-end `codehub analyze` produces the same graph node count as the pre-refactor baseline (parity gate).

Architectural review-time gates.

- `rg -n "OCH_NATIVE_PARSER" packages/ docs/` returns hits only inside CHANGELOG entries and ADR 0015.
- `rg -n 'requireFn\("tree-sitter"\)' packages/` returns no hits in non-test source files.
- `jq '.dependencies | keys | .[] | select(startswith("tree-sitter"))' packages/ingestion/package.json` returns only `web-tree-sitter`.
- `packages/cli/package.json` `dependencies` is unchanged. Only `overrides` is added.
- ADR 0015 lands in `docs/adr/`.
- `npm view @opencodehub/cli@0.4.0 dependencies` lists no `tree-sitter-*` keys (only `web-tree-sitter` plus workspace siblings) (Source: Speed Verification §7).
- `npm pack && tar tzf opencodehub-ingestion-0.4.0.tgz | grep wasm | wc -l` returns 16 (15 grammar WASMs plus web-tree-sitter runtime WASM).

Post-release watchpoints, one week after publish.

- npm download stats for `@opencodehub/cli` show no install-failure spike.
- Issue tracker has zero "install failed" or "tree-sitter postinstall" reports.
- `web-tree-sitter` runtime errors logged in the parse phase, frequency unchanged from 0.3.x baseline.
- A new contributor running `npm install -g @opencodehub/cli@latest` on a fresh box with mise plus Node 24 succeeds first try with no warnings.

## Convergence Notes

All three explorers independently identified the same root cause (native tree-sitter in published runtime deps) and the same target shape (WASM-only at the publish boundary, vendored grammars). Architectural and Simple converged to the byte on the deletion ledger. They cite the same line ranges in `parse-worker.ts:51-78, 156-191, 222-307`, the same `complexity.ts:106-136` port, the same `wasm-fallback.ts:222-303` collapse, the same 14-package devDep migration, and the same 15-WASM vendor inventory. Three independent agents producing the same target shape is high-confidence signal that the architectural call is correct.

Where they diverged, the resolutions stand. Speed-first kept native via `optionalDependencies` to ship today. We rejected that because it does not zero ERESOLVE and preserves two paths forever. Architectural kept `wasm-parity.test.ts` as a dev-only invariant. We rejected that in favor of Simple's delete because parity's job ended when this PR lands. Simple kept the `>=22.0.0` engines floor for a fail-fast contract. We rejected that in favor of Architectural's `>=20.0.0` because Node 20 LTS is current and the constraint was native-ABI-driven.

The composed plan takes Architectural's vendor-everything boundary, Simple's deletion ledger and complexity port, and Speed's `tree-sitter-cli` `overrides` shim as the permanent guardrail.
