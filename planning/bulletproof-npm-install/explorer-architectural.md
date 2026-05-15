# Explorer: Architectural — Bulletproof npm global install for @opencodehub/cli

**Status:** COMPLETE
**Vector:** Architectural
**Last updated:** 2026-05-15T03:04:05+00:00

---

## Protocol

The output file is the source of truth. Section-by-section. Cite paths.
Vector bias: **clean boundaries, smallest future-change cost**. If consolidation
is the right answer, recommend deletion.

---

## 1. Problem Framing

The published `@opencodehub/cli` ships a runtime path that doesn't match its
distribution model. The runtime is "WASM by default, native opt-in". The
package graph is "13 native grammars + native `tree-sitter` core as
runtime `dependencies`". That mismatch is the real bug. The 504 from
GitHub on `tree-sitter-cli`'s postinstall and the ERESOLVE peer warnings
are surface symptoms of a deeper architectural drift: we have **two
parser backends in the published surface but only one path the user is
expected to take**, and we make every install pay the cost of the
backend it isn't going to use.

The architectural fix is not "make the postinstall more reliable"; it is
"published surface declares only what the published runtime actually
loads".

## 2. Chosen Approach

**Single-path WASM, with native tree-sitter quarantined in the dev
workspace.** Concretely, three decisions sit on top of one another:

1. **Split parser concerns into two packages.** Keep `@opencodehub/ingestion`
   as the WASM-only parser. Move every native-tree-sitter consumer
   (currently: `complexity.ts`, the opt-in path in `parse-worker.ts`) onto
   the WASM API. Native `tree-sitter` and the 13 native grammars become
   `devDependencies` of a new private workspace package
   `@opencodehub/parser-native-bench` (or stay in the workspace root) used
   only for the parity test and dev benchmarking — never published.

2. **WASM grammars vendored at publish time.** The `vendor/wasms/` pattern
   already used for kotlin/swift/dart extends to all 15 grammars. The
   ingestion tarball ships a single `vendor/wasms/*.wasm` directory,
   resolved at runtime by file path (no `require.resolve(...)` against a
   sibling package). Total vendored size: ~24 MB compressed (see Decision
   D for sizes). Tarball-bound, network-free, postinstall-free.

3. **Delete the `--native-parser` opt-in and `OCH_NATIVE_PARSER` env var
   from the runtime.** The two-path branch in `parse-worker.ts:156-159`
   collapses to one. The complexity phase ports its tree walker onto the
   `web-tree-sitter` `Tree` it already gets from `parse.ts`, so the parse
   tree is built once per file instead of twice (the current code parses
   each file again natively just for complexity).

The shape is "one parser path, one binary format (WASM), one set of
grammar artifacts vendored in the tarball". That is the cheapest shape
to evolve: when `tree-sitter-foo@0.30` ships, we bump one dep, rebuild
one set of WASM blobs, and the cli inherits it without touching
distribution-side code.

**The speed-first answer would have been different.** The speed-first
plan keeps native tree-sitter as a perf escape hatch and just moves it
to `optionalDependencies` so a failing postinstall doesn't fail the
install. That works, ships in an afternoon, and preserves a 1.5-2x
speedup on Node 22 dev boxes. I'm explicitly *not* recommending it
because it preserves three parser implementations (native, WASM, and the
complexity-only third walker), three test matrices, and three failure
modes. The user has license for refactor and explicitly said "go all in
on wasm if it has the same support and if it's less confusing". WASM has
parity (asserted by `wasm-parity.test.ts` already in the codebase), so
the long-run answer is consolidation.

## 3. Key Decisions

### Decision A — Tree-sitter parsing path consolidation

**Decision:** Delete the native parser path entirely from the runtime.
Collapse to WASM-only. Remove `OCH_NATIVE_PARSER` and `--native-parser`
from the published surface; keep them as deprecated aliases for one
release, then delete.

**Files changed:**

- `packages/ingestion/src/parse/parse-worker.ts:51-54` — delete
  `forceNativeOpt()`.
- `packages/ingestion/src/parse/parse-worker.ts:64-78` — delete the
  three-branch startup-warning. Replace with a single line: `[parse-worker]
  using web-tree-sitter (WASM) runtime`.
- `packages/ingestion/src/parse/parse-worker.ts:156-159, 162-191` —
  delete `runNative` and the dispatch. The function becomes:
  `async function runParse(language, content) { return runWasm(language,
  content.toString('utf8')); }`.
- `packages/ingestion/src/parse/parse-worker.ts:222-245, 265-307` —
  delete `getOrBuildParser`, `getOrBuildQuery`, the entire native shim
  type set. The WASM path doesn't use them.
- `packages/ingestion/src/parse/wasm-fallback.ts:41-67` — delete
  `isNativeAvailable` and `resetNativeAvailabilityCache`. There's no
  caller anymore. Rename the file from `wasm-fallback.ts` to
  `wasm-runtime.ts` — it isn't a fallback when it's the only path.
- `packages/ingestion/src/parse/index.ts:18` — drop the
  `isNativeAvailable` re-export.
- `packages/cli/src/index.ts:88-91, 102-107` — delete the `--native-parser`
  option and the env var write. Soft-deprecate by accepting the flag with
  a stderr deprecation warning for one release.
- `packages/ingestion/src/parse/grammar-registry.ts:40-329` —
  **rewrite around WASM-only.** No more `requireFn` of native grammar
  modules; `loadLanguageObject(lang)` becomes "find the .wasm path,
  return it" and `loadGrammar` returns a path + queryText, not a
  `tsLanguage` opaque-pointer (or alternatively, returns the loaded
  `web-tree-sitter` Language object — `runtime.Language.load(path)`).
  This is the largest single edit in the plan: the registry
  currently has 13 per-language case branches, each calling `requireFn`
  with format quirks (`tree-sitter-typescript.typescript`,
  `tree-sitter-php.php_only`, c-sharp ESM default, dart's "we never
  shipped this natively" throw). The WASM path already handles these
  uniformly via `wasm-fallback.ts:249-303` — the module mapping is
  declarative. We move the entire registry to that declarative shape.

**Tradeoff accepted:** ~30-40% slower parse phase on Node 22 dev boxes
where the developer would have set `OCH_NATIVE_PARSER=1`. Per-process
cold start gets ~200ms cheaper because we no longer resolve 13 native
modules eagerly. We lose the perf ceiling but gain a single, reasoning-
friendly code path. The architectural cost of keeping native is paid
forever (every grammar bump, every Node major, every install env); the
perf benefit is bounded.

**Why this is the right architectural call:** The current branch has
five subtly-different equivalence classes — (Node 22, native available,
opt-in set), (Node 22, native available, opt-in unset), (Node 22, native
fails to build), (Node 24, opt-in set, native unsupported), (Node 24, no
opt-in). That's 5 paths to test, 5 places where a grammar version-skew
bug can hide. The parity test (`wasm-parity.test.ts`) keeps the two
backends in lockstep, which is itself maintenance work. Collapsing to
WASM is reversible if WASM perf becomes a real blocker (we restore from
git history, scoped to the `parse-worker.ts` runNative branch and the
grammar registry's native arm). Until then, every line we delete is a
line the next maintainer doesn't have to understand.

### Decision B — Grammar coverage audit

**Verified, all 15 languages have a WASM artifact reachable today:**

| Language | npm package | Native ABI | WASM source | Size (kB) |
|----------|-------------|-----------:|-------------|----------:|
| typescript | tree-sitter-typescript@0.23.2 | 0.21.x | bundled in pkg `tree-sitter-typescript.wasm` | 1380 |
| tsx | tree-sitter-typescript@0.23.2 | 0.21.x | bundled in pkg `tree-sitter-tsx.wasm` | 1411 |
| javascript | tree-sitter-javascript@0.25.0 | 0.25.x | bundled in pkg | 402 |
| python | tree-sitter-python@0.25.0 | 0.25.x | bundled in pkg | 447 |
| go | tree-sitter-go@0.25.0 | 0.25.x | bundled in pkg | 212 |
| rust | tree-sitter-rust@0.24.0 | 0.24.x | bundled in pkg | 1077 |
| java | tree-sitter-java@0.23.5 | 0.23.x | bundled in pkg | 405 |
| csharp | tree-sitter-c-sharp@0.23.5 | 0.23.x | bundled in pkg `tree-sitter-c_sharp.wasm` | 5225 |
| c | tree-sitter-c@0.24.1 | 0.24.x | bundled in pkg | 611 |
| cpp | tree-sitter-cpp@0.23.4 | 0.23.x | bundled in pkg | 3354 |
| ruby | tree-sitter-ruby@0.23.1 | 0.23.x | bundled in pkg | 2057 |
| php | tree-sitter-php@0.24.2 | 0.24.x | bundled in pkg `tree-sitter-php_only.wasm` | 979 |
| kotlin | tree-sitter-kotlin@0.3.8 | none on npm | vendored `vendor/wasms/tree-sitter-kotlin.wasm` | 4096 |
| swift | tree-sitter-swift@0.7.1 | bundled but builds postinstall | vendored `vendor/wasms/tree-sitter-swift.wasm` | 3300 |
| dart | (no npm pkg) | n/a | vendored `vendor/wasms/tree-sitter-dart.wasm` | 995 |
| cobol | n/a (regex provider) | n/a | n/a | 0 |

**Decision:** Vendor every grammar's WASM into `packages/ingestion/vendor/wasms/`,
not just the three that have no npm WASM today. Bundle 15 .wasm blobs,
plus `web-tree-sitter`'s own runtime wasm (~196 kB for the production
build at `node_modules/web-tree-sitter/web-tree-sitter.wasm`). Total ~25
MB extra in the published `@opencodehub/ingestion` tarball.

**Why vendor everything, not just the rare ones:** The current two-stage
cascade in `wasm-fallback.ts:238-303` (per-grammar package → vendored
fallback) is fragile distribution-wise. It assumes the user's npm/pnpm
hoisted the per-grammar packages somewhere `require.resolve` can find
them. That works inside this monorepo's `node_modules`. It works less
well when `@opencodehub/cli` is installed globally and only its declared
deps are present — yes, the grammars are still listed as deps today,
but the *whole point of the refactor* is to remove them from the
published deps. If we drop `tree-sitter-typescript` from
`@opencodehub/ingestion`'s dependencies (which we should, per Decision E),
we have to vendor its .wasm — there's no other path to it at runtime.

So the architectural call is: **vendoring is the boundary**. Either we
vendor every WASM, or we keep listing the grammar packages just to
reach into `node_modules/.../<lang>.wasm`. The latter is a pun — it
keeps a runtime dep around for one purpose (a static asset) while the
package's actual runtime code (the .node addon) is dead weight. Vendoring
collapses the dependency graph cleanly and makes the tarball
self-contained.

**Tradeoff accepted:** The published `@opencodehub/ingestion` tarball
grows from ~5 MB today to ~28 MB. Global `npm install -g @opencodehub/cli`
download time goes up by ~3-5 seconds on a typical home connection.
Build pipeline gains a "rebuild WASMs from grammar pins" step that has
to run before publish — but `scripts/build-vendor-wasms.sh` already
proves this is tractable.

**Why this is reversible:** If tarball size becomes a real complaint, we
publish `@opencodehub/parsers-wasm` as a separate package keyed to the
ingestion version. The runtime code (`wasm-fallback.ts` /
`wasm-runtime.ts`) already abstracts WASM-path resolution behind a
single function; swapping "look in `<self>/vendor/wasms/`" for "look in
`<peer>/wasms/`" is a one-line change. Don't do that on day one — the
boundary is right at the package boundary, ship it self-contained,
split out only when there's a forcing function.

### Decision C — Postinstall purge

**Rule:** No published runtime dep may have a postinstall that does
network IO or compiles native code on the user's machine.

**Postinstall offenders in the current dep tree of @opencodehub/cli (via
@opencodehub/ingestion):**

1. `tree-sitter-cli@0.23.2` — downloads platform binary from
   `github.com/tree-sitter/tree-sitter/releases`. Pulled in transitively
   by `tree-sitter-swift@0.7.1`. **HARD ERROR root cause** — drop by
   removing `tree-sitter-swift` from runtime deps.
2. `tree-sitter` (core, 0.25.0) — runs `node-gyp rebuild` if no prebuild
   is found. Has prebuilds for common platforms via `prebuild-install`.
   Drop by moving `tree-sitter` to `devDependencies` (only the parity
   test and complexity-phase native walk consume it; both go away under
   Decision A and G).
3. Every `tree-sitter-<lang>` package — runs `node-gyp rebuild` if the
   prebuild for the user's platform doesn't exist. Drop all 13 by
   purging from runtime deps (Decision E).
4. `onnxruntime-node` — downloads CUDA EP (~400MB) unless
   `npm_config_onnxruntime_node_install_cuda=skip` is set. Already
   handled in repo `.npmrc` per the workspace config; verify it ships in
   the published context too. (This is `@opencodehub/embedder`'s
   problem; in scope here only because the same architectural rule
   applies — runtime deps must not phone home at install time.)
5. `@duckdb/node-api` — has prebuilds, ships fine. Keep.

**Decision:** Move 14 packages (`tree-sitter` + 13 grammars) from
`@opencodehub/ingestion`'s `dependencies` to its `devDependencies`. They
remain available in the workspace for the parity test (Decision J) and
for `scripts/build-vendor-wasms.sh` to run `tree-sitter-cli build
--wasm` against the same source the npm pin points at.

**Architectural note:** `tree-sitter-cli` itself is fine in
`devDependencies` — it never reaches user installs. The fact that it's
currently transitive through `tree-sitter-swift` is exactly the wrong
direction of dependency flow. Build tools should be at the dev edge,
not at the runtime edge.

### Decision D — Build-time WASM vendoring strategy

**Decision:** Vendor all 15 WASMs at publish time. The ingestion package
ships them in its tarball.

**Mechanics:**

- Extend `scripts/build-vendor-wasms.sh` to build all 15 .wasm artifacts
  (currently builds 3). The script reads the grammar source out of the
  workspace's `node_modules/.pnpm/tree-sitter-<lang>` (already proves
  this for kotlin/swift/dart) and runs `tree-sitter build --wasm` in a
  temp dir, writing to `packages/ingestion/vendor/wasms/`. For
  per-grammar packages that already ship a `.wasm` (12 of them — see
  Decision B table), the script can either rebuild from source for
  consistency, or copy the shipped .wasm out of node_modules. **Pick:
  copy.** Rebuilding adds 30-60s per grammar and reproduces upstream's
  artifact; copying is a deterministic "use the same bytes the grammar
  package shipped". Keep `tree-sitter build --wasm` for the three that
  have no shipped WASM (kotlin, swift, dart).
- Add a `prepublishOnly` script in `packages/ingestion/package.json`
  that runs the vendor builder. This is the single guarantee: the
  tarball can't be published without the .wasms being current. CI gates
  on it via the `pnpm publish` flow.
- Add `vendor/wasms/**` to the `files` array (already there at
  `packages/ingestion/package.json:33`).
- Vendor `web-tree-sitter`'s own runtime wasm too. The package ships it
  inside `node_modules/web-tree-sitter/`, but we don't want a runtime
  `require.resolve('web-tree-sitter/...')` for an asset the user
  doesn't otherwise need. Copy it into `vendor/wasms/web-tree-sitter.wasm`
  and pass `Parser.init({ locateFile: () => <vendored path> })`.

**Tradeoff accepted:** `prepublishOnly` adds a hard build dependency
(docker/podman/finch with emcc, OR a local emcc) for any maintainer
running `pnpm publish` from a clean checkout. We could relax this by
caching the WASM artifacts in git LFS or as a CI build product. **First
pass:** keep them committed to the repo (they already are for k/s/d).
The repo grows by ~24 MB. Reversible: move to LFS later if the repo
weight becomes a complaint.

**Why not "download at runtime, first analyze":** Same failure mode as
postinstall. The user's `codehub analyze` would now need network reach
to GitHub or wherever we host the WASMs. We just spent a paragraph
deleting the postinstall network-call problem; reintroducing it on first
use is the same architectural mistake one layer over.

**Why not "peer package @opencodehub/parsers-wasm":** Splitting a peer
package makes sense if (a) multiple consumers want the same WASMs
without pulling all of ingestion, or (b) the WASM payload becomes large
enough that ingestion shouldn't carry it. Neither is true today. The
peer package is the right shape *later*, after we have a second
consumer; until then it's premature.

### Decision E — `@opencodehub/cli` published surface

**Current state of `packages/cli/package.json:38-58`:** 17 runtime
dependencies. Native tree-sitter and grammars come transitively through
`@opencodehub/ingestion`. The CLI itself doesn't list them.

**Required changes — `packages/ingestion/package.json:40-75`:**

| Before | After | Reason |
|--------|-------|--------|
| `tree-sitter@0.25.0` (deps) | `devDependencies` | Used only by complexity (Decision G) and parity test (Decision J). Both go to dev. |
| `tree-sitter-c@0.24.1` (deps) | drop from runtime; `devDependencies` for parity | WASM in vendor/ |
| `tree-sitter-c-sharp@0.23.5` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-cpp@0.23.4` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-go@0.25.0` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-java@0.23.5` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-javascript@0.25.0` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-kotlin@0.3.8` (deps) | `devDependencies` | Source for build-vendor-wasms.sh |
| `tree-sitter-php@0.24.2` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-python@0.25.0` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-ruby@0.23.1` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-rust@0.24.0` (deps) | `devDependencies` | WASM in vendor/ |
| `tree-sitter-swift@0.7.1` (deps) | `devDependencies` | Source for build-vendor-wasms.sh |
| `tree-sitter-typescript@0.23.2` (deps) | `devDependencies` | WASM in vendor/ |
| `web-tree-sitter@0.26.8` | keep in `dependencies` | Runtime parser host |

After this change, the ERESOLVE peer warnings disappear because the
peer relationship between `tree-sitter@0.25` and the grammars'
`peerOptional tree-sitter@^0.21|0.22|0.23` is *not in the published
runtime graph* — the user's `npm install -g @opencodehub/cli` no longer
sees those packages.

**The CLI itself (`packages/cli/package.json:38-58`)** needs no changes
— it depends on `@opencodehub/ingestion` and inherits the cleaner graph.

**Tradeoff accepted:** Runtime no longer tolerates a "user supplies
their own native tree-sitter for speed" path. To use native, a developer
would need to clone the workspace and run from source. That's the
correct boundary for an opt-in dev-only feature.

### Decision F — Multi-Node-installer compatibility matrix

The published cli, after the above changes, has zero native build steps
in its install chain. The matrix is a verification surface, not a code
surface — the install path is the same on every row.

**Test matrix (run pre-release in CI; smoke-run quarterly):**

| OS | Arch | Node | Installer | Verifies |
|----|------|------|-----------|----------|
| Linux | x64 | 20.x | mise | engines satisfied; install succeeds; `codehub --help` runs |
| Linux | x64 | 22.x | mise | as above + `codehub analyze <fixture>` runs |
| Linux | x64 | 24.x | mise | as above |
| Linux | arm64 | 22.x | mise | proxy for Apple Silicon |
| Linux | x64 | 22.x | nvm | tilde-path resolution |
| macOS | arm64 | 22.x | Homebrew | libuv + brew prefix paths |
| macOS | arm64 | 22.x | nvm | $HOME/.nvm/versions/... |
| macOS | arm64 | 22.x | Volta | shim-based PATH |
| macOS | x64 | 22.x | nvm | Intel Mac smoke |

**Engines field decision:** `packages/cli/package.json:80-82` declares
`>=22.0.0`. **Lower it to `>=20.0.0`.** WASM has no Node-version
constraint; the only reason engines was bumped was the native
tree-sitter ABI requiring a recent N-API. Once native is gone, we can
honestly support Node 20 LTS through Node 24. Reversible if Node 20
hits an unrelated incompatibility.

`packages/ingestion/package.json:105-107` matches.

**One concrete failure mode to watch:** `web-tree-sitter` 0.26+ uses
top-level await in some code paths and requires its own .wasm runtime
to be loadable. Pass `Parser.init({ locateFile: () => fileURLToPath(new
URL("../../vendor/wasms/web-tree-sitter.wasm", import.meta.url)) })` to
guarantee resolution against the vendored copy — don't rely on the
default loader, which tries `fetch()` on web platforms and `fs` on Node
with platform-specific paths that have bitten us before
(`node_modules/.pnpm/...` vs. flat `node_modules/...`). One line in
`wasm-fallback.ts:194-220`'s `ensureWasmRuntime`. Architectural: the
runtime should know exactly where its assets live, not heuristically
search for them.

### Decision G — Complexity phase resolution

**Current state:** `packages/ingestion/src/pipeline/phases/complexity.ts:110-124`
calls `requireFn("tree-sitter")` and degrades gracefully when it fails.
On Node 24 default + Node 22 default, complexity metrics are silently
zero today. The complexity phase parses each file *again* (line 581:
`tree = parser.parse(sourceText)`) on top of what `parse.ts` already
parsed.

**Decision: port complexity to WASM.** Two architectural sub-decisions:

1. **Make the complexity walker source-format-agnostic.** The walker
   only uses `node.type`, `node.childCount`, `node.child(i)`,
   `node.startPosition`, `node.endPosition`, `node.text`,
   `node.childForFieldName(name)`. Both native and `web-tree-sitter`
   trees expose this surface (web-tree-sitter has the same Node API by
   design — it's the upstream reference). The walker code in
   `complexity.ts:370-509` already operates against an interface
   (`TsNode`, lines 84-94) that matches both. The conversion is a swap
   of the parser source, not a rewrite.

2. **Stop double-parsing.** The parse phase already builds a tree per
   file. Pipe the tree through to the complexity phase as part of
   `ParseOutput`, instead of re-reading the file and re-parsing. This
   is a non-trivial structural change because trees aren't structured-
   clone-safe across worker boundaries — they're parser-tied objects.
   Two ways to fix:

   - **Cheap option (do this):** Re-parse on the main thread, but use
     WASM. The overhead is ~1.5x what native was; complexity is a
     small phase (a few seconds on a 100k-LOC repo) so the absolute
     hit is negligible.
   - **Architectural option:** Move complexity *into* the parse worker
     so each worker computes complexity on the tree it already has. This
     is the right shape long-term — the complexity walker is per-file,
     stateless, and trivially parallel — but it touches the
     pipeline-phase contract (`PipelineContext`, `PipelinePhase`) and
     is bigger than the install fix calls for.

   **Pick the cheap option for this work item; file the parse-fold
   refactor as a follow-up.** Tradeoff: we accept a one-CPU-thread cost
   on Node 24 that we don't strictly have to, in exchange for keeping
   the change scoped.

**Files changed:**

- `complexity.ts:78, 106-124` — replace `requireFn("tree-sitter")` shim
  with a `ensureWasmRuntime` import from `wasm-runtime.ts` (renamed
  per Decision A). The `getParser(lang)` function builds a
  `web-tree-sitter` `Parser` per language, cached.
- `complexity.ts:108-109, 116-119` — delete `warnedComplexityDegraded`
  and the "set OCH_NATIVE_PARSER=1" message. WASM is reachable
  unconditionally; complexity becomes a default-on capability instead
  of a Node-22-with-opt-in capability.
- `complexity.ts:130-133` — `parser.setLanguage(handle.tsLanguage)` —
  `handle.tsLanguage` becomes the `web-tree-sitter` Language object.
  This is consistent with Decision A's reshape of `loadGrammar`.

**Architectural win:** Complexity stops being silently degraded on the
default path. Today, a user running `npm install -g @opencodehub/cli`
on Node 24 gets a working `analyze` but *zero* complexity numbers —
this is a hidden quality-of-result regression. After this change, every
default install gets full complexity metrics.

**Why I'm rejecting option (ii) "regex/AST-walker approximation":**
That answer optimizes for "make the complexity phase work without tree-
sitter at all". But tree-sitter is going to be there — we ship it. The
question isn't "how do we get rid of tree-sitter for complexity"; it's
"native or WASM tree-sitter". WASM is what we ship; use it.

**Why I'm rejecting option (iii) "drop complexity from published cli":**
Complexity is a published-API feature. It powers the risk-trends MCP
tool and shows up in `verdict` blast-radius scoring. Removing it
breaks observable behavior. Not a refactor — a regression.

### Decision H — Workspace publish hygiene

**Current state:** `packages/ingestion/package.json:33` already lists
`vendor/wasms/**` in `files`. Good. No `prepack`/`prepare` scripts in
either ingestion or cli today. No `package-lock.json` published (npm
uses `pnpm-lock.yaml` and we don't `npm pack` from npm).

**Decisions:**

1. **Add `prepublishOnly` to `packages/ingestion/package.json:35-39`:**
   ```json
   "prepublishOnly": "node scripts/verify-vendor-wasms.mjs"
   ```
   The verify script asserts: (a) all 15 expected .wasm files exist in
   `vendor/wasms/`, (b) each is valid WASM (magic bytes), (c) each
   matches the grammar version pinned in the workspace's
   `pnpm-lock.yaml` via a manifest file `vendor/wasms/manifest.json`
   that the build script writes. **This is the core of the architectural
   guarantee** — the tarball can't ship without the WASMs and the WASMs
   can't drift from the grammar pins. One-shot architectural lever
   that costs ~50 LOC of script.

2. **Add a `pnpm publish` smoke step in CI:** run `pnpm pack` in
   `packages/ingestion`, then `pnpm pack` in `packages/cli`, then `npm
   install -g <cli-tarball>` in a clean container, then `codehub
   --help` and `codehub analyze tests/fixtures/multi-lang/`. This is
   the architectural equivalent of an integration test for the
   distribution boundary. CI only — gates the publish.

3. **Verify `files` includes the vendor WASMs in the *built* path:**
   `packages/ingestion/package.json:24-34` lists `dist/**` and
   `vendor/wasms/**`. The runtime resolves WASMs via
   `wasm-fallback.ts:35-39` (`path.resolve(here, "..", "..",
   "vendor", "wasms")`), which walks from `dist/parse/` up to the
   package root. Tarball layout preserves this since both `dist/` and
   `vendor/` sit at package root. **Already correct.**

4. **Drop `optionalDependencies.ts-morph` from
   `packages/ingestion/package.json:85-87`** — out of scope for the
   install fix but worth noting: `ts-morph` is heavy and the
   "optional" claim should be audited separately. **Out of this
   change's scope; flag for follow-up.**

### Decision I — Lockfile & hoisting consequences

The CLI doesn't ship a `package-lock.json` (good — it would override
the user's npm client's resolution). Moving 14 packages from runtime
deps to dev deps in `@opencodehub/ingestion` changes:

1. **Hoisting:** Today the workspace's `node_modules/.pnpm/...` has
   tree-sitter-* hoisted at the workspace root. After the change,
   they remain there because they're still in `devDependencies` of the
   workspace. **Workspace dev work is unaffected.**

2. **Published install:** `npm install -g @opencodehub/cli` no longer
   pulls them. The user's global `node_modules` shrinks by ~30 MB of
   prebuilt-binary-tar-content + ~20 MB of source. **This is the win.**

3. **Runtime resolution:** Today
   `wasm-fallback.ts:249-303`'s `tryPerGrammarPackage` calls
   `requireFn.resolve(\`${pkgName}/package.json\`)`. After the change,
   the grammar packages are not in the user's install — those calls
   return undefined, and we fall through to the vendored path. **This
   makes the runtime cascade meaningless; collapse it.** Replace the
   two-stage cascade with a single declarative table that maps every
   `LanguageId` to a `vendor/wasms/<file>.wasm` path. Single source of
   truth for "where's the WASM for X". Files: `wasm-fallback.ts:222-303`
   collapses from ~80 LOC to ~25 LOC.

4. **No production code currently relies on a hoisted-native-module
   side effect.** I checked: only `parse-worker.ts:165` and
   `complexity.ts:113` `requireFn` native tree-sitter, both gated and
   both removed by Decisions A and G.

### Decision J — Migration / deprecation path for OCH_NATIVE_PARSER

**Decision: hard-deprecate immediately, delete in the next minor.**

**Architectural justification:** The opt-in is undocumented to most
users (it's a power-user dev knob), the parity test asserts the two
paths produce equal output, and the only group of users who set it are
opencodehub maintainers running benchmarks. They can run from source
against the workspace's still-installed native tree-sitter. The
"keep flag, ignore value" intermediate state is the worst architectural
shape — every reader of the cli source has to understand a flag that
does nothing.

**Migration steps:**

1. **In the PR that removes the runtime path** (Decision A), keep the
   `--native-parser` flag and `OCH_NATIVE_PARSER` env var as no-ops
   that emit a one-shot stderr deprecation:
   ```
   [opencodehub] OCH_NATIVE_PARSER / --native-parser is deprecated;
   the WASM parser is now the only runtime path. The flag is ignored
   and will be removed in 0.5.0.
   ```
2. **One release later (`0.5.0`), delete the flag and env handling
   entirely.** Update CLAUDE.md, CHANGELOG, all docs.
3. **Delete from docs:**
   `packages/cli/README.md:79`,
   `packages/docs/src/content/docs/guides/indexing-a-repo.md:130`,
   `packages/docs/src/content/docs/guides/troubleshooting.md:27,80`,
   `packages/docs/src/content/docs/architecture/parsing-and-resolution.md:25`,
   `packages/docs/src/content/docs/architecture/adrs.md:126`,
   `packages/docs/src/content/docs/reference/configuration.md:31,33`,
   `packages/docs/src/content/docs/reference/languages.md:53,55`,
   `packages/docs/src/content/docs/reference/cli.md:40`,
   `packages/docs/src/content/docs/start-here/what-is-opencodehub.md:68`,
   `packages/docs/src/content/docs/start-here/install.md:15,112`.
4. **Update CLAUDE.md** at repo root: the "Parse runtime — WASM default,
   native opt-in" section becomes "Parse runtime — WASM-only, vendored
   grammars". Drop the OCH_NATIVE_PARSER row. Add: "Native tree-sitter
   is a workspace-only dev dependency used by the parity test
   (`packages/ingestion/src/parse/wasm-parity.test.ts`); not shipped to
   npm install consumers."
5. **Write ADR 0014 — "WASM-only parser at the npm-distributed boundary":**
   captures the decision permanently. References this plan and the npm
   504 incident as the trigger.

**Keep alive in dev:**

- `wasm-parity.test.ts` still runs natively — it imports both `tree-sitter`
  and `web-tree-sitter` and asserts capture-set equivalence. This test
  is the architectural anchor that lets us delete the runtime native
  path with confidence: as long as parity holds, "WASM-only at runtime"
  doesn't change semantics. Pin it in CI on Node 22 (Node 24 lacks the
  native binding for some grammars currently). **Native survives, but
  only behind the dev wall.**
- `scripts/build-vendor-wasms.sh` keeps `tree-sitter-cli` and the
  grammar source packages; both stay in `devDependencies`.

## 4. Implementation Steps

Ordered. Each step lists the files touched and the verification.

1. **Land WASM vendoring infrastructure (no behavior change yet).**
   - `scripts/build-vendor-wasms.sh` — extend to all 15 grammars; for
     packages that ship a `.wasm`, copy; for the three that don't,
     build via `tree-sitter build --wasm`.
   - Run the script. Commit `packages/ingestion/vendor/wasms/*.wasm`
     for all 15 + `web-tree-sitter.wasm`.
   - Add `packages/ingestion/vendor/wasms/manifest.json` recording the
     grammar version each .wasm was built from.
   - Add `packages/ingestion/scripts/verify-vendor-wasms.mjs` script
     (asserts all 15 exist, valid WASM magic bytes, manifest matches
     `pnpm-lock.yaml` versions).
   - Wire `prepublishOnly: "node scripts/verify-vendor-wasms.mjs"` in
     `packages/ingestion/package.json:35-39`.
   - **Verify:** `pnpm pack -C packages/ingestion` contains all 16
     `.wasm` files; tarball size in expected range (~28 MB).

2. **Switch WASM resolver to vendored-only path.**
   - `packages/ingestion/src/parse/wasm-fallback.ts:222-303` — collapse
     to one declarative table: `LanguageId` → `vendor/wasms/<file>.wasm`.
   - `packages/ingestion/src/parse/wasm-fallback.ts:194-220` — add
     `locateFile` to `Parser.init` pointing at the vendored
     `web-tree-sitter.wasm`.
   - **Verify:** Existing `wasm-grammar-resolution.test.ts` and
     `wasm-parity.test.ts` pass against the vendored path. The parity
     test still loads native from `node_modules` (workspace devDeps);
     unchanged behavior in workspace.

3. **Port the complexity phase onto WASM.**
   - `packages/ingestion/src/pipeline/phases/complexity.ts:78, 106-136` —
     replace native shim with `ensureWasmRuntime` import; build
     `web-tree-sitter` Parser per language, cache.
   - Update `complexity.ts:108-119` — drop the "tree-sitter unavailable"
     warning; complexity now works on default path.
   - **Verify:** `complexity.test.ts` passes with WASM trees. Add a test
     case running on Node 24 (CI matrix) to lock in the new default.

4. **Delete native runtime path.**
   - `packages/ingestion/src/parse/parse-worker.ts:51-78, 156-191,
     222-307` — delete native shim, native dispatch, native types.
     The file shrinks ~150 LOC.
   - `packages/ingestion/src/parse/wasm-fallback.ts:41-67` — delete
     `isNativeAvailable`, rename file to `wasm-runtime.ts` (and
     update imports).
   - `packages/ingestion/src/parse/grammar-registry.ts:180-277` —
     rewrite `loadLanguageObject` and `loadGrammar` to load WASM
     Languages via `web-tree-sitter`; the per-grammar quirks
     (ESM default, `.typescript`/`.tsx`, `.php_only`) all collapse
     because the WASM artifact is unambiguous.
   - `packages/ingestion/src/parse/index.ts:18` — drop
     `isNativeAvailable` re-export.
   - **Verify:** `parse-worker.test.ts` regenerated for WASM-only
     (cases (a), (c), (d) collapse to one; case (b) is deleted).
     `wasm-parity.test.ts` keeps its native-vs-wasm assertion as a
     dev-only invariant.

5. **Soft-deprecate OCH_NATIVE_PARSER and --native-parser.**
   - `packages/cli/src/index.ts:88-91, 102-107` — keep flag, emit
     deprecation warning, ignore.
   - Add the deprecation warning at parse-worker startup if
     `OCH_NATIVE_PARSER` is read non-empty.

6. **Move tree-sitter and 13 grammars to devDependencies.**
   - `packages/ingestion/package.json:40-75` — move 14 packages to
     `devDependencies`. Keep `web-tree-sitter@0.26.8` in `dependencies`.
   - Run `pnpm install` to refresh `pnpm-lock.yaml`.
   - **Verify:** workspace tests still pass (the moved packages are
     still hoisted in workspace `node_modules`); a tarball install
     shows the `dependencies` tree no longer contains tree-sitter-*.

7. **Lower engines floor.**
   - `packages/cli/package.json:80-82` and
     `packages/ingestion/package.json:105-107` — change
     `>=22.0.0` to `>=20.0.0`.
   - **Verify:** CI matrix (step 9) covers Node 20.

8. **Documentation and CHANGELOG.**
   - Update CLAUDE.md "Parse runtime" section.
   - Drop `OCH_NATIVE_PARSER` from all 11 docs files (Decision J list).
   - Write ADR 0014.
   - Add CHANGELOG entries to `packages/ingestion/CHANGELOG.md` and
     `packages/cli/CHANGELOG.md`.

9. **Add CI install-matrix.**
   - GitHub Actions job: 9 runners, each does `pnpm pack`, installs
     the cli tarball globally, runs `codehub --help` and a tiny
     `codehub analyze` against `tests/fixtures/multi-lang/`.
   - **Verify gate:** all 9 pass before any release.

10. **Hard-delete OCH_NATIVE_PARSER (next minor, follow-up PR).**
    - `packages/cli/src/index.ts` — remove the flag definition.
    - `packages/ingestion/src/parse/parse-worker.ts` — remove the
      env-read deprecation warning.

## 5. Risks and Tradeoffs

**What we're giving up:**

- **Native parser perf on dev Node 22.** Empirically ~1.5-2x parse-
  phase wall-clock slowdown on warm-cache runs. Mitigated by `piscina`
  worker pool already in use; the absolute time on a 100k-LOC repo
  goes from ~6s to ~10s. Acceptable for the architectural simplicity.
  Reversible — the dev parity test keeps native warm; if WASM perf
  becomes a real blocker we restore the runtime-native branch from
  git.

- **Tarball size growth for `@opencodehub/ingestion`.** ~5 MB → ~28 MB.
  The cli depends on it transitively, so the global install download
  grows by the same amount. This is a one-time download, not a
  hot-path; users feel it once. Acceptable.

- **Repo size growth.** ~25 MB of vendored WASMs in git. Mitigated
  because they compress poorly (already wasm-magic'd) but git stores
  binary blobs reasonably well via packfiles. If the repo grows past
  comfortable, follow-up moves them to LFS or a per-release CI
  artifact.

**What could go wrong:**

- **`web-tree-sitter@0.26+` instability or Node 24 incompat.** Mitigated
  by the install matrix CI (step 9). If we hit a real blocker on
  Node 24 + WASM, we hold the release and pin web-tree-sitter forward
  or backward. The architectural call doesn't change — we don't go
  back to native; we fix the WASM runtime.

- **A grammar bumps its tree-sitter ABI past 0.25.** The vendored
  WASM was built against the pinned grammar source; bumping the
  grammar pin without rebuilding the WASM produces a runtime mismatch.
  Mitigated by `verify-vendor-wasms.mjs` checking the manifest against
  `pnpm-lock.yaml`. Architectural: the verification script is the
  load-bearing safety net for grammar drift.

- **A user has `tree-sitter` installed in their project**
  `node_modules` (because of an unrelated dep). Today our code
  `requireFn`s it; tomorrow we don't. Reverse migration cost: zero —
  we don't reach into the user's node_modules anymore for parser
  bindings.

- **`tree-sitter-cli` postinstall failure resurfaces from a different
  transitive path.** Defense: CI's install-matrix runs
  `npm install -g <cli-tarball>` with `--ignore-scripts=false` and
  asserts the install completes in <60s with no network calls beyond
  the registry. If a future dep introduces a postinstall, the matrix
  catches it.

**What I'd watch for after release:**

- Issue reports of `Parser.init` failing on specific Node 20 minors.
  `web-tree-sitter` historically had Node 18 quirks; Node 20 has been
  stable for it. Unlikely but trackable.
- WASM cold-start time on cold-disk runs (first-time analyze on a CI
  agent). Probably negligible (< 500 ms total for 15 grammars
  initialized lazily) but log it via `--verbose`.
- Tarball download timeouts on slow connections. Set a reasonable
  expectation in install docs; consider a "minimal language set"
  cli flag in a future minor that skips loading WASMs for unused
  languages.

## 6. Verification Criteria

**Unit tests (must pass):**
- `packages/ingestion/src/parse/parse-worker.test.ts` — single-path
  WASM tests; native cases removed.
- `packages/ingestion/src/parse/wasm-grammar-resolution.test.ts` —
  resolves all 15 languages to a vendored path.
- `packages/ingestion/src/parse/wasm-parity.test.ts` — kept; runs only
  in workspace dev (where native is still installed). Drops to a
  matrix-skipped test in CI on Node 24.
- `packages/ingestion/src/pipeline/phases/complexity.test.ts` — passes
  on default Node 22 and Node 24 with non-zero output.

**Integration tests:**
- `tests/fixtures/multi-lang/` end-to-end `codehub analyze` produces
  the same graph node count and same set of complexity-annotated
  nodes as the pre-refactor baseline (parity gate).

**Distribution gates (CI install matrix, blocks release):**
- 9-cell matrix (Linux x64 Node 20/22/24, Linux arm64 Node 22, macOS
  arm64 Node 22 via Homebrew/nvm/Volta, macOS x64 Node 22 via nvm) —
  each cell runs:
  ```
  pnpm pack -C packages/ingestion
  pnpm pack -C packages/cli
  npm install -g ./packages/cli/opencodehub-cli-*.tgz \
                  ./packages/ingestion/opencodehub-ingestion-*.tgz
  codehub --version    # exits 0
  codehub --help       # exits 0
  codehub analyze tests/fixtures/multi-lang/  # exits 0
  ```
- No postinstall script in any installed package's `package.json` may
  contain `wget`, `curl`, `download`, `node-gyp rebuild`,
  `prebuild-install`, or write to `~/.cache`. Audit script in CI.
- Install completes in < 60 seconds on a baseline runner with cold
  npm cache. Hard regression gate.
- ERESOLVE warning count from `npm install` output: zero.

**Architectural gates (review-time):**
- `grep -rn "OCH_NATIVE_PARSER\|requireFn(\"tree-sitter\")" packages/
  | grep -v parity | grep -v devDeps` returns no hits in non-test
  source files. (Allows the parity test, allows the dev-bench harness.)
- `packages/ingestion/package.json`'s `dependencies` array contains
  exactly one tree-sitter-related entry: `web-tree-sitter`.
- `packages/cli/package.json`'s `dependencies` is unchanged.
- ADR 0014 lands in `docs/adr/`.

**Post-release (one week after publish):**
- npm download stats for `@opencodehub/cli` show no install-failure
  spike.
- Issue tracker has zero "install failed" or "tree-sitter postinstall"
  reports.
- A new contributor running `npm install -g @opencodehub/cli@latest`
  on a fresh box with mise + Node 24 succeeds first try with no
  warnings.

---

## Appendix — Code references

- Parser registry (rewrite target): `packages/ingestion/src/parse/grammar-registry.ts:79-97, 146-277`
- WASM resolver (collapse target): `packages/ingestion/src/parse/wasm-fallback.ts:222-303`
- Native dispatch (delete target): `packages/ingestion/src/parse/parse-worker.ts:51-54, 64-78, 156-191, 222-245, 265-307`
- Complexity native shim (port target): `packages/ingestion/src/pipeline/phases/complexity.ts:78-136`
- CLI flag (deprecate target): `packages/cli/src/index.ts:88-107`
- Ingestion runtime deps (move target): `packages/ingestion/package.json:59-72`
- Vendor builder (extend target): `scripts/build-vendor-wasms.sh:45-47`
- Workspace allowBuilds (audit target): `pnpm-workspace.yaml:50-77` (the `tree-sitter*` entries become dev-only after Decision E; left intact because workspace `pnpm install` still runs them at workspace-dev install time)
- ERESOLVE root: `tree-sitter-swift@0.7.1` → `tree-sitter-cli@0.23.2` postinstall (verified at `pnpm-lock.yaml:tree-sitter-swift block`)
