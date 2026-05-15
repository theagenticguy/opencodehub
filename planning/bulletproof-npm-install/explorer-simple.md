# Explorer: Simple-first — Bulletproof npm global install for @opencodehub/cli

**Status:** COMPLETE
**Vector:** Simple-first
**Last updated:** 2026-05-15

---

## Vector reminder

Most-boring-engineer answer. Things I like: deletions, dropped deps, removed flags. Things I dislike: configuration switches, multi-mode runtime selection, conditional code paths, lazy downloads, optionalDependencies, npm overrides. If a plan keeps something, it owes a reason; default is delete.

---

## 1. Problem framing

`npm i -g @opencodehub/cli@latest` fails for two compounding reasons that share one root cause: **we publish a package that pulls 13 native tree-sitter grammar packages plus `tree-sitter` core**, and those packages (a) run network-touching postinstalls (`tree-sitter-cli@0.23.2` GHCR-release download, currently 504), (b) carry incompatible peer ranges that ERESOLVE on a global install where pnpm's lockfile is not present, and (c) require a working C++ toolchain on every install host.

We already have a fully-functional WASM parse path (`web-tree-sitter@0.26.8`) and we already vendor 3 WASMs that npm packages don't ship. **The simple-first answer is to make WASM the only path** and delete every native-related dependency, code branch, env var, CLI flag, doc reference, and test that exists to support the second path. The remaining work is a small port of `complexity.ts` from native to web-tree-sitter and a one-time `pnpm install` step that vendors the remaining 11 per-package WASMs into `vendor/wasms/` so the published tarball is fully self-contained.

This is a pure deletion PR with a small targeted port.

---

## 2. Chosen approach

**Shape:** "WASM-only, vendor-everything, no postinstall."

- One parser path: `web-tree-sitter` reading `.wasm` blobs from `packages/ingestion/vendor/wasms/`.
- One source for those blobs: vendored at build time from each grammar package's already-shipped `.wasm` (or built from source for kotlin/swift/dart, which already are vendored).
- Zero runtime branches keyed on env vars, Node version, or platform.
- Zero `dependencies` that run install scripts. Every native `tree-sitter-*` package and `tree-sitter@0.25.0` and `web-tree-sitter`'s native peers are removed from `@opencodehub/ingestion`'s `dependencies`. `web-tree-sitter` is the only tree-sitter dep that survives.
- The published tarball under `npm install -g` does **one thing**: copy `dist/` and `vendor/wasms/`. No download, no compile, no choose-a-runtime.

**Tradeoff I'm taking on:** 11 vendored WASMs grow the published tarball by ~10–25 MB total (the existing 3 WASMs are 8.4 MB combined; per-package WASMs we'd add are typically 0.5–2 MB each). This is the simple-first cost. The architectural alternative is a separate `@opencodehub/grammars-wasm` package + a pretty registry; not worth it for the deletion math here.

**Tradeoff I'm declining:** `optionalDependencies` for native as a "speed mode" for power users. That preserves the second path, the env var, the dispatcher, the test matrix. It's the speed-first plan, not the simple-first plan. There is no second user.

---

## 3. Key decisions

### Decision A — Inventory deletions

#### A.1 — Dependencies to remove from `packages/ingestion/package.json`

Removed entirely (lines `packages/ingestion/package.json:59-72`):

| Dep | Why it goes |
|---|---|
| `tree-sitter@0.25.0` | Native N-API addon; runs `node-gyp` postinstall. Only consumer was the deleted dispatcher + complexity phase. |
| `tree-sitter-c@0.24.1` | Native grammar, not loaded after WASM-only switch. WASM ships in vendor. |
| `tree-sitter-c-sharp@0.23.5` | Same. |
| `tree-sitter-cpp@0.23.4` | Same. |
| `tree-sitter-go@0.25.0` | Same. |
| `tree-sitter-java@0.23.5` | Same. |
| `tree-sitter-javascript@0.25.0` | Same. |
| `tree-sitter-kotlin@0.3.8` | Native binding — **no prebuilds; requires C++ toolchain** — was the worst install offender. WASM already vendored. |
| `tree-sitter-php@0.24.2` | Same. |
| `tree-sitter-python@0.25.0` | Same. |
| `tree-sitter-ruby@0.23.1` | Same. |
| `tree-sitter-rust@0.24.0` | Same. |
| `tree-sitter-swift@0.7.1` | Native binding with ~30 s postinstall rebuild. WASM already vendored. |
| `tree-sitter-typescript@0.23.2` | Same. |

That is **14 deps** out of `@opencodehub/ingestion`'s runtime tree, including the one (`tree-sitter@0.25.0`) that pulls `tree-sitter-cli` and the failing GHCR download. **Net: 14 fewer runtime deps and zero install scripts in the published cli's hot path.**

Survivors (post-change `dependencies` for tree-sitter–related work):

- `web-tree-sitter@0.26.8` — pure WASM, no `.node` addon, no postinstall.

#### A.2 — Code paths keyed on `OCH_NATIVE_PARSER`

Source of truth (from grep at `OCH_NATIVE_PARSER` and `isNativeAvailable`):

- `packages/ingestion/src/parse/parse-worker.ts:39-78,142-160` — `forceNativeOpt()`, the warned-runtime triage block, the `runNative()` branch in `runParse()`. **Delete `runNative()`, `forceNativeOpt()`, `isNativeAvailable` import, the runtime warning triage; keep only `runWasm()` body inlined into `runParse()`.**
- `packages/ingestion/src/parse/parse-worker.ts:162-191` — entire `runNative()` function and its TreeSitter ambient interfaces (lines 265-307 — `TreeSitterPoint`, `TreeSitterNode`, `TreeSitterTree`, `TreeSitterParser`, `TreeSitterQueryCapture`, `TreeSitterQueryMatch`, `TreeSitterQuery`, `TreeSitterModule`). Delete all of it. WASM types in `wasm-fallback.ts` already cover what the worker needs.
- `packages/ingestion/src/parse/wasm-fallback.ts:41-67` — `isNativeAvailable()`, `cached`, `resetNativeAvailabilityCache()`. Delete entirely. Rename `wasm-fallback.ts` → `wasm-parser.ts` because WASM is no longer a fallback.
- `packages/ingestion/src/parse/index.ts:18` — `export { isNativeAvailable, resetNativeAvailabilityCache } from "./wasm-fallback.js";`. Delete the line.
- `packages/ingestion/src/parse/grammar-registry.ts:255-267` — Dart-specific `OCH_NATIVE_PARSER` error message inside the native loader. The whole `loadLanguageObject()` function (lines 193-277) is now dead — `loadGrammar()` only fed the native path. Delete `loadLanguageObject` entirely; `loadGrammar()` shrinks to "build a `GrammarHandle` whose `tsLanguage` is `null`" because nothing on the WASM path uses `tsLanguage`. **Better: stop returning `tsLanguage` from `GrammarHandle` at all — it's only needed by `runNative()`.** See A.4.
- `packages/ingestion/src/pipeline/phases/complexity.ts:106-136` — `parserCache`, `tsModuleCached`, `getTsModule()`, `getParser()`. Delete in favor of the WASM port. `complexity.ts:115-123` carries the OCH_NATIVE_PARSER stderr advisory. Delete.
- `packages/cli/src/index.ts:88-91, 102-107` — `--native-parser` option declaration and the env-var setter. Delete.

#### A.3 — `tree-sitter-cli` removal from `pnpm-workspace.yaml`

`pnpm-workspace.yaml:69` (`tree-sitter-cli: true` under `allowBuilds`) survives because it's still needed by `scripts/build-vendor-wasms.sh` to build the kotlin/swift/dart WASMs. **But move `tree-sitter-cli` from `allowBuilds` to a workspace `devDependency`** so it lives on disk only on developer machines, not in the published tarball. (It already is — it gets pulled transitively by `tree-sitter@0.25.0`. Once `tree-sitter@0.25.0` leaves `dependencies`, also add `tree-sitter-cli` as an explicit root `devDependency` so the build script keeps working.)

`pnpm-workspace.yaml` build entries that go away with no consumer left:
- `tree-sitter: true`
- `tree-sitter-c: true`, `tree-sitter-c-sharp: true`, `tree-sitter-cpp: true`, `tree-sitter-go: true`, `tree-sitter-java: true`, `tree-sitter-javascript: true`, `tree-sitter-kotlin: true`, `tree-sitter-php: true`, `tree-sitter-python: true`, `tree-sitter-ruby: true`, `tree-sitter-rust: true`, `tree-sitter-swift: true`, `tree-sitter-typescript: true` — all 13 entries (`pnpm-workspace.yaml:66-83` minus `tree-sitter-cli`).

**Net: 14 entries deleted from `allowBuilds`.** Only `tree-sitter-cli` (devDependency, not published) remains.

#### A.4 — `GrammarHandle.tsLanguage` field

`packages/ingestion/src/parse/grammar-registry.ts:117-122` — the `tsLanguage` field exists only because the native path needed `parser.setLanguage(handle.tsLanguage)`. WASM resolves the grammar from a `.wasm` path directly via `Language.load(wasmPath)` inside `wasm-fallback.ts`. After the deletion, `GrammarHandle` collapses to just `{ language: LanguageId; queryText: string }` — and at that point it's a 2-field DTO that doesn't need its own type. **Inline it: callers want either the query text or the wasm path.** The `loadGrammar()` function and the inflight-dedupe Map collapse to a 1-line `getUnifiedQuery(lang)` and a separate-but-trivial `getGrammarSha()` is the only thing left worth keeping in this module.

This is a meaningful structural deletion: `grammar-registry.ts` shrinks from 337 lines to ~80 lines, mostly the language-spec map and `getGrammarSha`.

### Decision B — WASM blob coverage

Existing state (`packages/ingestion/src/parse/wasm-fallback.ts:249-303`):

- **Stage 1 (per-grammar npm package):** typescript, tsx, javascript, python, go, rust, java, csharp, c, cpp, ruby, php — resolved by `requireFn.resolve('tree-sitter-<lang>/package.json')` then `path.join(pkgDir, '<file>.wasm')`. The `.wasm` is bundled inside each native package at the same path. Verified in `node_modules/.pnpm/tree-sitter-<lang>@<v>/.../tree-sitter-<lang>.wasm` (see grep output of pnpm node_modules).
- **Stage 2 (vendored):** kotlin, swift, dart — `packages/ingestion/vendor/wasms/tree-sitter-{kotlin,swift,dart}.wasm`. Already in repo (`vendor/wasms/` listing: 8.4 MB combined).

When we delete the native `tree-sitter-<lang>` deps, **Stage 1 stops working** — `requireFn.resolve('tree-sitter-python/package.json')` will throw because the package isn't installed in a global cli install. So we must move every Stage-1 grammar's `.wasm` into `vendor/wasms/` and delete Stage 1 entirely.

**Plan:**

1. Rebuild `scripts/build-vendor-wasms.sh` to also copy the 11 per-package `.wasm` files. The build steps are different per language:
   - 11 grammars (typescript/tsx, javascript, python, go, rust, java, csharp, c, cpp, ruby, php) ship a pre-built `.wasm` inside the npm tarball — **just `cp` it into `vendor/wasms/`**, no docker, no emcc.
   - 3 grammars (kotlin, swift, dart) require `tree-sitter build --wasm` (current logic) — keep as is.

2. The 11 `cp` lines run on every developer's `pnpm install` cycle (idempotent — fast). Or simpler: **commit them once and never re-run unless a grammar version bumps**. Same model as the current 3 vendored WASMs.

3. Result file list under `vendor/wasms/`:
   - `tree-sitter-c.wasm`, `tree-sitter-cpp.wasm`, `tree-sitter-c_sharp.wasm` (note underscore — matches what c-sharp ships and what `wasm-fallback.ts:265` already expects)
   - `tree-sitter-dart.wasm` (existing)
   - `tree-sitter-go.wasm`, `tree-sitter-java.wasm`, `tree-sitter-javascript.wasm`
   - `tree-sitter-kotlin.wasm` (existing), `tree-sitter-php_only.wasm`, `tree-sitter-python.wasm`
   - `tree-sitter-ruby.wasm`, `tree-sitter-rust.wasm`, `tree-sitter-swift.wasm` (existing)
   - `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`
   - **15 files total.**

4. `wasm-fallback.ts` (renamed `wasm-parser.ts`) collapses to **one** resolver function:
   ```
   function resolveGrammarWasmPath(lang) {
     const fname = WASM_FILES[lang];  // a single Record<LanguageId, string>
     return path.join(VENDOR_WASMS_DIR, fname);
   }
   ```
   No two-stage cascade. No `requireFn.resolve`. No `tryPerGrammarPackage` / `tryVendoredWasm` split. ~50 lines deleted.

5. The `files` array in `packages/ingestion/package.json:24-34` already includes `vendor/wasms/**` (line 33), so the published tarball already ships them. No `package.json` change needed except the `dependencies` deletions.

**Tradeoff:** Each WASM is 0.5–4 MB; 15 of them total is ~15–25 MB extra in the published tarball vs. shipping nothing. The current world ships the same WASMs anyway — they're just inside the per-package native tarballs that we publish a transitive dep on. So actually **net tarball download is smaller**, because we lose every `.node` prebuild for every platform and every `tree-sitter` C source the native packages bundle. (The native `tree-sitter` package itself ships ~5 MB of C sources for `node-gyp`. Each grammar ships its native `.cc` parser. Across 13 grammars that's tens of MB in lost weight.)

#### B.1 — Vendoring license check

`vendor/wasms/LICENSES.md` already exists. After adding 11 more WASMs, append their licenses (all MIT or Apache-2.0 per the existing third-party manifest at `THIRD_PARTY_LICENSES.md`). One-time edit.

### Decision C — Complexity phase fate

**Decision: port to WASM, not delete.** Keep at the same module path.

Reasoning:

- The phase is wired into `default-set.ts:71` and is a real consumer's signal: `verdict.ts:101,688` reads `cyclomaticComplexity > 10` to set the risk tier in `verdict`, which is the thing PR-review uses to issue 0/1/2 exit codes. Deleting it silently neuters `verdict`. That is a behavior regression a real customer is using.
- The port is mechanically straightforward — every API the phase uses against the native binding (`rootNode`, `child(i)`, `childCount`, `childForFieldName`, `text`, `startPosition`, `endPosition`, `type`) exists with identical semantics on `web-tree-sitter`'s `Node` (verified at `node_modules/.pnpm/web-tree-sitter@0.26.8/.../web-tree-sitter.d.ts:328,448,471,493,499`). The only meaningful API shift is `parser.parse()` returns a `Tree` synchronously in both bindings.
- The phase already runs **on the main thread** doing its own re-parse (it doesn't reuse the worker pool's parsed trees because parse output drops the tree to keep IPC small). Doing that re-parse via `web-tree-sitter` + the same vendored `.wasm` is a pure substitution: swap `require('tree-sitter')` for the existing `openWasmParser(lang).parse(source)`. The walk logic at `complexity.ts:370-460` is binding-agnostic — `walk()` only touches the abstract `TsNode` shape, which `WasmNode` matches.
- After the port, **delete `getTsModule`, `parserCache` (native-typed), `tsModuleCached`, `warnedComplexityDegraded`, the `OCH_NATIVE_PARSER` stderr advisory** at `complexity.ts:106-124`. Replace with a single per-language WASM parser handle pulled from `wasmCache` (or call `openWasmParser(lang)` and let the per-process cache that already exists in `wasm-fallback.ts:110` do the memoization for free).
- Net: `complexity.ts` loses ~30 lines of tree-sitter shim and gains ~5 lines of `await openWasmParser(lang)` plus a `?? skip` guard. **Smaller file.**

**Tradeoff declined:** the alternative ("delete complexity for 0.4.0, restore later") sounds simple, but the deletion cost is hidden — `verdict` quietly drops a tier and PR reviews change verdict for users who have been relying on it. The port is small enough that the boring choice is to do it.

### Decision D — Verification

A single bash script that proves the install across all 6 cells (Linux × {Node 20, 22, 24} ∪ macOS × {Node 20, 22, 24} — though macOS via Linux container with rosetta if local hardware isn't available):

```bash
# scripts/verify-global-install.sh
set -euo pipefail
VERSION="${1:-latest}"
for NODE in 20 22 24; do
  docker run --rm -v /tmp:/tmp node:${NODE}-slim bash -c "
    set -euo pipefail
    npm install -g @opencodehub/cli@${VERSION}
    codehub --version
    git clone --depth=1 https://github.com/sindresorhus/p-limit /tmp/probe
    cd /tmp/probe
    codehub analyze .
    codehub query 'export default'
  "
done
```

Three smoke assertions:
1. `npm install -g` exits 0 and emits no `WARN` or `ERR` lines about peer deps or postinstalls.
2. `codehub --version` prints the version.
3. `codehub analyze .` against `p-limit` (TypeScript) exits 0 and writes `.codehub/`.

For the matrix completeness on macOS I'd add `mise` and `nvm` shells locally:

```bash
# scripts/verify-global-install-macos.sh — runs on a clean Mac
mise use --global node@22
npm install -g @opencodehub/cli@${VERSION}
codehub --version
codehub analyze /tmp/probe
mise use --global node@20 && npm install -g @opencodehub/cli@${VERSION} && codehub --version
mise use --global node@24 && npm install -g @opencodehub/cli@${VERSION} && codehub --version
```

The container script is enough for CI. Macs in the wild get covered by Node 22+24 via the docker matrix because the only platform-specific surface remaining is `web-tree-sitter`'s WASM runtime, which is identical across darwin and linux (it's pure Wasm + `WebAssembly.compile`, no `.node` addon).

**`.github/workflows/verify-global-install.yml`** — new workflow, run on every push to main and on every release tag, fail loudly if any cell exits non-zero. This is the regression net.

### Decision E — Files deleted or simplified in source

In priority order (most deletion first):

1. **Delete entirely** — `packages/ingestion/src/parse/wasm-parity.test.ts`. The test exists *only* to assert WASM vs native produce the same captures. Without a native path, there's nothing to compare. Cited at `wasm-parity.test.ts:281-286`: "native tree-sitter is unavailable — parity suite requires it as the reference runtime". With native gone, the suite is meaningless. **Replace with nothing.** The native path was the only reason the test existed.

2. **Heavy edit, then rename** — `packages/ingestion/src/parse/wasm-fallback.ts` → `wasm-parser.ts`. Drop `isNativeAvailable`, `resetNativeAvailabilityCache`, `tryPerGrammarPackage`, `resolvePackageDir`. Collapse `resolveGrammarWasmPath` to one map lookup. Delete the 70-line two-stage-cascade comment. **From 332 lines to ~120 lines.**

3. **Heavy edit** — `packages/ingestion/src/parse/parse-worker.ts`. Delete `forceNativeOpt`, `runNative`, `getOrBuildParser`, `getOrBuildQuery`, the `requireFn` import, the runtime triage block, all 8 `TreeSitter*` ambient interfaces. **From 308 lines to ~140 lines.**

4. **Heavy edit** — `packages/ingestion/src/parse/grammar-registry.ts`. Delete `loadLanguageObject` (lines 193-277), simplify `loadGrammar` to drop `tsLanguage`, drop the inflight-dedupe Map (it's there to avoid duplicate native `require()`s — WASM uses its own per-process cache in `wasm-fallback`/`wasm-parser`). **From 337 lines to ~80 lines.**

5. **Edit** — `packages/ingestion/src/pipeline/phases/complexity.ts`. Replace native re-parse with WASM. Delete `requireFn`, `getTsModule`, `getParser`, `tsModuleCached`, `warnedComplexityDegraded`, `parserCache` (native-typed). Use `openWasmParser(lang)` directly. Delete the 8 `Ts*` ambient interfaces (their `Wasm*` equivalents already exist in the parser module).

6. **Edit** — `packages/ingestion/src/parse/parse-worker.test.ts`. Delete tests `(b)`, `(c)`, `(d)` — all `OCH_NATIVE_PARSER` cases. Keep test `(a)` "WASM path, WASM warning" but rename to "parse worker reports WASM runtime on startup" (or delete the test — the runtime-name logging itself is going away under the simple-first deletion of the warning at `parse-worker.ts:64-78`). **Probably delete the file. The single remaining "WASM is the only path" assertion is implicit in every other parse test.**

7. **Edit** — `packages/ingestion/src/parse/wasm-grammar-resolution.test.ts`. Update to assert the new flat single-table resolver. Many of its existing assertions about the two-stage cascade collapse to "every language resolves to `vendor/wasms/<file>`". **From whatever it is now to ~30 lines.**

8. **Edit** — `packages/ingestion/src/parse/index.ts:18`. Drop the `isNativeAvailable, resetNativeAvailabilityCache` export.

9. **Edit** — `packages/cli/src/index.ts:88-91, 102-107`. Delete the `--native-parser` option block and the env setter. **Net: -10 lines, -1 user-visible flag.**

10. **Edit** — `pnpm-workspace.yaml:66-83`. Delete 14 of 15 `allowBuilds` entries (keep only `tree-sitter-cli` since `scripts/build-vendor-wasms.sh` still uses it). Add `tree-sitter-cli` as an explicit root `devDependencies` entry in the workspace root `package.json` so it's installed locally without `tree-sitter@0.25.0` pulling it.

11. **Edit** — `packages/ingestion/package.json:59-72`. Delete 14 deps (every `tree-sitter*` line except `web-tree-sitter`).

12. **Edit** — `packages/cli/README.md:79`. Drop `OCH_NATIVE_PARSER` from the env-toggle list.

13. **Edit** — `README.md:83, 234-236`. Drop the "WASM-default parse runtime" feature row and the Node-22-native-opt-in paragraph.

14. **Edit** — `packages/ingestion/README.md:25, 57`. Drop the same.

15. **Edit** — `CLAUDE.md:96-107` (the "Parse runtime — WASM default, native opt-in" section). **Replace with a 3-line version**: "All parsing runs through `web-tree-sitter` against vendored WASMs at `packages/ingestion/vendor/wasms/`. There is no native opt-in. Run `bash scripts/build-vendor-wasms.sh` after bumping a grammar version."

16. **Edit (and/or delete)** — `docs/adr/0013-parse-runtime-wasm-default.md`. The ADR was the rationale for the dual-mode design; once we delete native, the ADR is partially outdated. Add a `**Superseded by:** 0014 — WASM-only parser path` note and write a small ADR 0014 next to it with the deletion rationale.

17. **Edit** — `packages/docs/src/content/docs/start-here/install.md:15,112`, `packages/docs/src/content/docs/architecture/parsing-and-resolution.md:25`, `packages/docs/src/content/docs/architecture/adrs.md:126`, `packages/docs/src/content/docs/reference/cli.md:40`, `packages/docs/src/content/docs/reference/configuration.md:31-33`, `packages/docs/src/content/docs/reference/languages.md:53-55`, `packages/docs/src/content/docs/start-here/what-is-opencodehub.md:68`, `packages/docs/src/content/docs/guides/troubleshooting.md:27,80`, `packages/docs/src/content/docs/guides/indexing-a-repo.md:130`. Strip every mention of `OCH_NATIVE_PARSER`, `--native-parser`, "Node 22 native opt-in". Replace with a one-line "WASM is the only runtime."

18. **Edit** — `packages/ingestion/CHANGELOG.md` and root `CHANGELOG.md`. Add a 0.4.0 entry: "BREAKING: removed `OCH_NATIVE_PARSER` env var and `--native-parser` CLI flag. WASM is the only parser runtime. Native parsing has not been the install-time default since 0.3.0; this completes the removal."

#### Total deletion count (approximate)

- 14 deps removed from `@opencodehub/ingestion/package.json`.
- 14 entries removed from `pnpm-workspace.yaml` `allowBuilds`.
- 1 CLI flag removed.
- 1 env var removed.
- 1 entire test file deleted (`wasm-parity.test.ts`, ~330 lines).
- 1 likely test file deleted (`parse-worker.test.ts`, ~280 lines) or stripped to its skeleton.
- ~600+ lines of source deleted across `parse-worker.ts`, `wasm-fallback.ts`, `grammar-registry.ts`, `complexity.ts` shim.
- ADR 0013 superseded; ADR 0014 added (small).

### Decision F — Migration story

Hard removal, with a one-line stderr advisory the first time the env var is observed.

```ts
// In packages/cli/src/index.ts at startup, before commander.parse:
if (process.env["OCH_NATIVE_PARSER"] !== undefined) {
  process.stderr.write(
    "[codehub] OCH_NATIVE_PARSER was removed in 0.4.0; WASM is the only parser runtime. Unset to silence this warning.\n",
  );
  delete process.env["OCH_NATIVE_PARSER"];
}
```

For `--native-parser`, **don't add a deprecation alias**. Commander will report the unknown flag and exit. That's the loudest possible signal. The CHANGELOG covers the rest.

**Why no graceful migration period:** there's no second user. The flag was added in the M5 default-flip and the only documented audience is "Node 22 dev boxes for measurably faster parsing". Anyone with `--native-parser` in a script gets a clean error message from commander on the first run after upgrade, reads the CHANGELOG, deletes the flag, moves on. Total user-impact cost: minutes per script.

### Decision G — Commit shape

**One PR titled:** `feat!: WASM-only parser path; drop native tree-sitter and tree-sitter-cli`.

Body sketch:

```
Removes 14 native tree-sitter dependencies and the OCH_NATIVE_PARSER /
--native-parser env+flag toggle. WASM via web-tree-sitter is the only
runtime. Vendor every grammar's .wasm under packages/ingestion/vendor/wasms/
so `npm install -g @opencodehub/cli` runs zero install scripts.

BREAKING:
- OCH_NATIVE_PARSER env var: removed (one-shot stderr advisory still emitted).
- --native-parser CLI flag: removed (commander will reject as unknown).
- complexity phase: ported to web-tree-sitter; metrics are unchanged.

Why: `npm install -g` was failing with two compounding issues — a
GHCR-release 504 from `tree-sitter-cli`'s postinstall and ERESOLVE peer
conflicts between `tree-sitter@0.25.0` and the per-language native
grammar packages. Both go away when there is no native runtime.
```

Single commit, single PR, single review pass. **Zero `optionalDependencies`. Zero `npm overrides`.** Both would imply two install outcomes, which violates the simple-first vector. The whole point is "one outcome, every time."

---

## 4. Implementation steps

Strict ordering — each step's verification gates the next.

1. **Vendor the 11 missing WASMs.** Edit `scripts/build-vendor-wasms.sh` to add 11 `cp` lines pulling each `tree-sitter-<lang>.wasm` from `node_modules/.pnpm/tree-sitter-<lang>@<v>/.../tree-sitter-<lang>.wasm`. Run the script. Commit the 11 new files under `packages/ingestion/vendor/wasms/`. Verify: `ls vendor/wasms/*.wasm | wc -l` == 15.

2. **Port complexity.ts to WASM.** Replace native re-parse with `await openWasmParser(lang).parse(source)`. Delete `getTsModule`, `getParser`, `requireFn`, the native `Ts*` interfaces. Run `pnpm -C packages/ingestion test --grep complexity`. Verify: all complexity tests pass on Node 22 and Node 24 with no `OCH_NATIVE_PARSER` set.

3. **Simplify `wasm-fallback.ts` (rename → `wasm-parser.ts`).** Drop two-stage cascade, drop `isNativeAvailable`, drop `resetNativeAvailabilityCache`. Collapse `resolveGrammarWasmPath` to one-table lookup. Update import sites (`parse-worker.ts`, `index.ts`, `complexity.ts`). Run `pnpm -C packages/ingestion test`. Verify: green.

4. **Delete native paths in `parse-worker.ts`.** Remove `forceNativeOpt`, `runNative`, native interfaces, runtime-triage warning. Inline `runWasm` body into `runParse`. Run `pnpm -C packages/ingestion test --grep parse-worker`. Verify: WASM-only parse worker still produces the right `ParseCapture` output for the test fixtures.

5. **Simplify `grammar-registry.ts`.** Delete `loadLanguageObject`. Drop `tsLanguage` from `GrammarHandle`. Run all ingestion tests. Verify: green. The `getGrammarSha` path is unaffected — it never read `tsLanguage`.

6. **Delete `wasm-parity.test.ts` and trim `parse-worker.test.ts`.** Run ingestion tests. Verify: green (we lose 4 tests, gain nothing).

7. **Delete the CLI flag.** Edit `packages/cli/src/index.ts` lines 88-91 and 102-107. Add the one-shot `OCH_NATIVE_PARSER` stderr advisory + `delete` at startup. Run `pnpm -C packages/cli test`. Verify: green.

8. **Edit `package.json`s and `pnpm-workspace.yaml`.** Drop 14 deps from `packages/ingestion/package.json`. Drop 14 `allowBuilds` entries from `pnpm-workspace.yaml`. Add `tree-sitter-cli` as a root `devDependency` to keep `scripts/build-vendor-wasms.sh` working. Run `pnpm install --frozen-lockfile=false` to regenerate `pnpm-lock.yaml`. Verify: lockfile diff is large but only delta is "deleted" entries.

9. **Run the full workspace test suite.** `pnpm -r test`. Fix any test that imported a deleted symbol (most likely some tests `import { isNativeAvailable } from '@opencodehub/ingestion'`). Verify: green.

10. **Update docs and ADRs.** Step E.12-17 above. Drop `OCH_NATIVE_PARSER` mentions. Add ADR 0014 superseding 0013. Verify: `pnpm run banned-strings` (if there's a banned-strings list) flags nothing residual.

11. **Add the verification workflow.** Write `scripts/verify-global-install.sh` and `.github/workflows/verify-global-install.yml`. Workflow does a release-candidate publish to a private dist-tag (e.g., `npm publish --tag rc`), then the docker matrix in Decision D installs and smoke-runs. Verify: workflow goes green for Node 20/22/24 against an RC dist-tag.

12. **Publish 0.4.0.** `pnpm -r publish` with the new versions. Verify: post-publish, `npm install -g @opencodehub/cli@0.4.0` works on a clean Node 20/22/24 docker image.

13. **Run the verification script in production.** Same script as Decision D against the published `@latest`. Verify: zero warnings, zero ERESOLVE, zero postinstall fetches.

---

## 5. Risks and tradeoffs

**What this plan gives up:**

- **Native parsing speed on dev boxes.** The opt-in claim was "measurably faster on Node 22 dev boxes." We give up that knob. Tradeoff: simplicity for everyone else. The win is that the install is bulletproof — we trade ~10–30 % parse-phase wall-clock for the people who would have set the flag, against eliminating the install-failure tax on everyone who wouldn't.
- **Future flexibility for native.** Re-introducing a native opt-in later is a non-trivial revert (re-add the dispatcher, the interfaces, the test matrix). **Deletion cost named.** Counter: the only reason native was kept around was M5-era performance. By 0.5.0, web-tree-sitter perf gaps usually shrink anyway as the runtime matures.
- **Tarball size for `@opencodehub/ingestion`.** ~15–25 MB extra in the published tarball from the 11 new vendored WASMs. **Net is probably smaller than today** because we lose the per-grammar native `.cc`/`node-gyp` source trees that current native deps drag in, but the published-tarball size of `@opencodehub/ingestion` itself goes up. Acceptable: install latency on a 100 Mbps pipe is ~2 s for 25 MB.

**What could go wrong:**

- **A vendored WASM doesn't load on web-tree-sitter@0.26.8.** Already happened with the upstream `tree-sitter-wasms@0.1.13` catalog (`vendor/wasms/README.md:7-12`). Mitigation: we're vendoring the per-package WASMs that tree-sitter team itself ships with their npm packages — those use modern tree-sitter-cli builds. The 3 we build ourselves (kotlin/swift/dart) are already known good.
- **A grammar version bump produces an incompatible WASM.** The current 3-vendored model already has this risk; the 11-extra mitigation is: the cp-from-node_modules approach in step 1 means the WASM in `vendor/wasms/` always corresponds to the version pinned in our (deleted) `tree-sitter-<lang>` deps. Once we delete those deps, we have to pin the grammar versions some other way — the simplest is **pin them as `devDependencies` in `packages/ingestion/package.json`** so `pnpm install` still resolves them locally for the build script, but they don't ship to consumers. (devDeps are stripped from `npm publish`.)
- **`web-tree-sitter`'s `Parser.init()` fails on a sandboxed runtime.** This was already a concern (`wasm-fallback.ts:8-11`). The fix is the same: surface the error, no silent fallback. The new world has no native fallback, so a user on a sandbox without WebAssembly support gets a hard error. **Acceptable: the Wasm engine is in every modern Node.** Node 22+ has had it stable for 2+ years.
- **`engines.node` constraint.** Both `packages/ingestion/package.json:106` and `packages/cli/package.json:81` specify `>=22.0.0`. The verification matrix includes Node 20 because users on global installs sometimes have older Node defaults. **Decision: keep `>=22.0.0`** — `engineStrict: true` is set in `pnpm-workspace.yaml:38` so older Node fails fast with a clear message, which is the simple-first contract: one valid runtime, fail fast outside it. Tradeoff: users on Node 20 get an explicit "upgrade Node" prompt instead of an opaque WASM error later. **This is a pre-existing decision; the simple-first plan ratifies it but doesn't change it.**

**Watchpoints post-merge:**

- npm install error rate on the cli (track via `npm` download stats + GitHub issue volume).
- `web-tree-sitter` runtime errors in the parse phase (already logged; track frequency).
- Grammar-version drift between `vendor/wasms/` and the latest grammar release (a quarterly rebuild cron is enough — the current cadence is already that).

---

## 6. Verification criteria

This plan worked iff all of the following are true after merge and publish:

1. `npm install -g @opencodehub/cli@latest` exits 0 on a clean `node:20-slim`, `node:22-slim`, and `node:24-slim` container. **No** `WARN deprecated`, **no** `ERR! ERESOLVE`, **no** GHCR fetches in stderr. The verification workflow (Decision D / step 11) is the regression gate.
2. `codehub --version` prints the version on each of the 3 Node images.
3. `codehub analyze /tmp/p-limit` (a small TypeScript repo) writes `.codehub/graph.duckdb` (or `.lbug`), exits 0, and the run takes <60 s.
4. `codehub query 'export default'` against the freshly-indexed repo returns at least one hit.
5. `pnpm -r test` is green locally and in CI.
6. `pnpm install` from a clean clone (no `node_modules`, no `pnpm-lock.yaml` fast-path) installs in <2 minutes with no postinstall network calls beyond what `tree-sitter-cli` does for build-time grammar building (and `tree-sitter-cli` is now a devDep, not a transitive runtime install).
7. `du -sh dist/` for `@opencodehub/cli` after `npm pack` is roughly the same as today (within ±20 %).
8. Grep for `OCH_NATIVE_PARSER` in the published tarball returns zero hits. Same for `--native-parser`.
9. The `verdict` PR-review tool still emits the `cyclomaticComplexity > 10` risk-tier flip (verified by a unit test that hand-crafts a 15-decision-point function and asserts the verdict bumps a tier).

When (1) (2) (3) (8) all pass, the install is bulletproof in the scope of this PR.

---

## Appendix — quick deletion ledger

Smallest surface remaining post-change:

- 1 parser binding (`web-tree-sitter`).
- 1 wasm directory (`vendor/wasms/`).
- 1 build script (`scripts/build-vendor-wasms.sh`).
- 1 CLI flag removed (`--native-parser`).
- 1 env var removed (`OCH_NATIVE_PARSER`).
- 0 `optionalDependencies` introduced.
- 0 `overrides` introduced.
- 0 runtime branches keyed on platform/Node version/env var.

That's the simple-first signature.
