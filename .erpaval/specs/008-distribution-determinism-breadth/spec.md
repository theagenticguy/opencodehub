# EARS Spec 008 — Docker distribution + full SCIP/LSP breadth + determinism receipts

**Session**: session-008 (TBD) · **Branch**: `feat/v1-distribution-breadth` (cut from `main`) · **Parent roadmap**: `.erpaval/ROADMAP.md` + brainstorm `014-scip-lsp-packaging-determinism-plans.md`

**Decision (Laith, 2026-06-19):** drop the single-binary track entirely. The **Docker multistage image (pnpm + Node 24) is the sole new distribution artifact**, and it doubles as the delivery vehicle for the SCIP/LSP language breadth. This collapses the old Plan A (breadth) and Plan B (packaging) into one coherent track: *build breadth inside the image, keep the npm CLI and the packHash lean.* Track C (determinism receipts + MCP conformance + eval) runs in parallel.

This spec supersedes the binary half of brainstorm 014 §Plan B. The `@yao-pkg/pkg` lite binary, SEA, Bun, and Deno options are **rejected — no exceptions** (added to ROADMAP §Explicitly rejected; see AC-D0).

## Three tracks

- **Track A — language breadth** (`all SCIP + all agent-lsp`): finish the SCIP indexer set (php/dart at a new mid-confidence tier) and add an LSP-backed Tier-3 for SCIP-blind languages, **quarantined from the packHash**. Delivered via Track B's image.
- **Track B — Docker distribution**: one multistage `node:24` image, built per-arch, carrying the curated indexer toolchains the npm package can't ship.
- **Track C — determinism receipts + conformance + eval**: `pack --prove`/`replay`, cache-prefix reframe, CORE-Bench L3 harness, MCP 2026-07-28 stateless conformance.

Tracks are sequenced by dependency in `tasks.md`. Docker (B) is the hinge: A's heavy indexers are only affordable once the image exists.

---

## Context (Explore + Research consolidated — grounded 2026-06-19, primary sources)

Full grounding in brainstorm `014-...md` and memory `mem_9f849d7ed887`.

### Track A — SCIP + LSP breadth

- **SCIP governance migrated** off Sourcegraph 2026-03-25 → independent `scip-code` org; protocol/CLI is **`scip-code/scip@0.8.1`** (2026-06-04) with a 4-stage SEP RFC process. **`scip-go` (now `scip-code/scip-go@v0.2.7`) and `scip-rust` moved**; language indexers stayed under `sourcegraph`. **ADR 0006 pin table is stale on the scip-go module path** — must repoint.
- **Code state**: `packages/scip-ingest/src/runners/index.ts` already wires 10 `IndexerKind`s (`typescript, python, go, rust, java, clang, ruby, dotnet, kotlin, cobol-proleap`) behind a closed `ALLOWED_COMMANDS` spawn allowlist. M4 is **half-built**, not greenfield.
- **SCIP gaps to "all SCIP"**: `scip-php` (davidrjenni v0.0.2, third-party, pre-alpha) and `scip-dart` (Workiva 1.6.2, third-party). Both **not CSC-governed** → a distinct mid-confidence label, *not* the same tier as first-party indexers.
- **No `scip-swift`, no `scip-elixir`** exist (probed directly). These + Zig/Terraform/Clojure are the SCIP-blind set Track A's LSP tier targets.
- **Every indexer uses a different install channel** (npm / `go install` / Maven JAR via Coursier / native binary / `dotnet tool` / Composer / pub / rust-analyzer subcommand) and **most must build the target repo** (JVM+Gradle, .NET 8, clang compile-db, Sorbet, cargo+rust-analyzer) before emitting an edge. → "add all SCIP" is a **subprocess-orchestration + per-toolchain-provisioning** problem, which is exactly why it rides Track B's image.
- **agent-lsp** = `blackwell-systems/agent-lsp@v0.15.0` (2026-06-13), **MIT** (clears the Apache-2.0/MIT/BSD/ISC/CC0/BlueOak/0BSD allowlist). Single Go binary wrapping LSP subprocesses over MCP/`--http`. Covers the SCIP-blind set: Swift(sourcekit-lsp), Zig(zls), Elixir(elixir-ls), Terraform(terraform-ls), Clojure(clojure-lsp), Gleam, Nix, Lua, SQL. **Does not bundle servers** — auto-detects on PATH.
- **ADR-0005 verdict**: agent-lsp **overcomes** the "per-file/interactive" objection — `workspace/symbol` (empty query) enumerates all project symbols headlessly, and `blast_radius` auto-enumerates exported symbols across a file set and resolves cross-file references without the agent supplying positions. It does **not** overcome "stateful/running server" (warm index, fsnotify, 5-min cold timeout) — but OCH already pays that cost for SCIP subprocesses. **This spec adds LSP as a labeled fallback, not as the oracle ADR 0005 rejected** → new ADR 0019 (AC-A6).
- **Determinism risk**: agent-lsp output is not globally sorted and servers are not version-pinned; its `blast_radius` SQLite cache is keyed by `sha256(file content) + symbol identity` and *is* reproducible **given identical contents AND identical server versions**. → Tier-3 facts must be re-sorted, server-version-pinned, tagged `source=lsp`, and **kept out of the packHash preimage** (AC-A4).

### Track B — Docker distribution

- OCH is pnpm `11.1.0` (packageManager-pinned) + Node `>=24.15.0`, ships as `@opencodehub/cli` + a stdio MCP entrypoint. **No Dockerfile exists** (`find -iname Dockerfile` → 0).
- Three native / non-JS pieces dominate: **onnxruntime-node** (embedder; per-platform prebuilds; known darwin-x64 weakness), **`@ladybugdb/core`** (pre-1.0 native graph engine, ABI breaks — most fragile dep), and the **indexer toolchains** (scip-java needs a JVM; the rest need their own runtimes). `mise.toml` already keeps `node-gyp` as the native-build fallback for `@duckdb/node-api`/`onnxruntime-node`, and parsing is WASM-only (ADR 0015).
- **Multistage `node:24` solves the prebuild problem structurally**: installing on the exact target arch (via buildx `linux/amd64` + `linux/arm64`) makes onnxruntime/ladybug prebuilds match — the darwin-x64-style pain disappears because we build the image for Linux targets only.
- **jlink-trimmed JRE** (~50 MB vs ~200 MB full) hosts scip-java inside the image. `COPY --from=ghcr.io/astral-sh/uv:latest` provisions any Python indexer.
- **GPL/MPL scanners (hadolint, tflint) stay OUT of the OSS image** — detect-on-PATH + subprocess (license hygiene; same rule applies to GPL/EPL LSP servers).
- **stdio MCP in a container**: `docker run -i --rm <image> och-mcp` (the `-i` keeps stdin open for JSON-RPC).

### Track C — determinism receipts + conformance + eval

- **`pack --prove` foundation exists**: `packages/pack/src/manifest.ts` already computes `packHash = sha256(canonicalJson(manifest))` (RFC 8785, snake_case wire form) with `pins` (grammar commits, tokenizer, duckdb version) + a `determinismClass` (`strict`/`best_effort`/`degraded`). The release workflow **already** runs **cosign keyless** (Fulcio+Rekor) + **`actions/attest-build-provenance@v4.1.0`**. → `pack --prove` wraps proven machinery (in-toto SLSA v1 statement, subject digest == packHash), not new crypto.
- **Anthropic cache mechanics (verified, Context7 + claude.com GA)**: cache-read = **0.1× input (90% cheaper)**, write = 1.25× (5-min TTL) / 2.0× (1-hr); min cacheable prefix on **Opus 4.8 = 1,024 tok** (Sonnet 4.6 = 1,024, Haiku 4.5 = 4,096; Bedrock minimums differ); hierarchy **tools → system → messages** (a change at a level invalidates that level and everything after); 100%-identical-byte prefix match, ≤4 breakpoints, 20-block lookback; **1M context is flat-rate** on Opus 4.8/4.7/4.6 + Sonnet 4.6.
- **CORE-Bench = arXiv:2606.11864** (cs.IR, 2026-06-09); 3 levels (L1 understanding → L2 issue-to-edit localization → **L3 broader-context retrieval w/ in-repo distractor filtering**); 180K+ queries / 106K relevance labels. **Metric names UNVERIFIED** — HF card empty, abstract silent; field convention is nDCG@k / Recall@k — **read the PDF tables before fixing the metric** (AC-C8). Name-collision: ignore arXiv:2409.11363 (computational-reproducibility CORE-Bench). Supporting: **CodeCompass arXiv:2602.20048** (graph nav **+23.2 pt** on G3 hidden-dependency, 99.4 vs 76.2 ACS; **BM25 ~0 lift on G3**); **ContextBench arXiv:2602.05892** (1,136 tasks / 66 repos / 8 langs, human gold contexts, recall/precision/efficiency).
- **MCP 2026-07-28 RC — stdio-relevant changes ONLY** (the morning roadmap over-scoped this): for a stdio server the `Mcp-Method`/`Mcp-Name` headers and EMA/ID-JAG/OAuth **do NOT apply** (HTTP-transport only; stdio uses env creds), and there is **no spec mandate to sign tool descriptions**. What applies: **stateless `_meta` model** (drop the `initialize` handshake; read protocolVersion/clientInfo/clientCapabilities per-request — touches every handler, SDK-gated, hardest item), `server/discover`, remove `ping`/`logging/setLevel`/`notifications/roots/list_changed`, add **`ttlMs`+`cacheScope` JSON fields** (NOT `etag`) to list/read results. **Hard cutover July 28, 2026.**

### Convention & guardrail constraints

- **`commitlint.config.mjs` scope-enum** has every existing package scope but **lacks `docker` and `lsp-tier`**. Both MUST be added to `scope-enum` in the first commit that introduces each (prior lesson: "new packages/scopes need scope-enum update in their first commit"). `build:` is the correct *type* for the Dockerfile work.
- **`scripts/check-banned-strings.sh`** `BANNED_LITERALS` includes `kuzu`, `ladybug`, `duckpgq`, `STEP_IN_PROCESS`, `heuristicLabel`, `codeprobe`, `STEP_IN_FLOW`; excludes `vendor/`, `.erpaval/`, `docs/adr/`, `pnpm-lock.yaml`. **`docker`, `lsp`, `lsp-tier`, `php`, `dart`, `prove`, `replay`, `attest` are all safe.** The Dockerfile MUST refer to the graph engine by its `@ladybugdb/core` package dep only (package-scope precedent), never the bare literal in tracked non-excluded source.
- **Worktree + biome root-config collision** (MEMORY): remove sibling worktrees before root-level `mise run check`, or scope via `--filter`.
- **Worktree native-binding failures** (MEMORY): pnpm-install-in-worktree test failures are expected; verify regressions on `main`, not in worktrees.
- **`mise run check`** = lint(biome) → typecheck(`tsc --noEmit`) → test(build then `pnpm -r test`) → banned-strings. `check:full` adds licenses + osv.
- **graphHash byte-identity** (ROADMAP constraint 6) and **packHash byte-identity** (constraint 7) MUST hold across every commit.
- **`@opencodehub/summarizer` is the only LLM-calling package** (constraint 2) — no new LLM calls in any track.

---

## Ubiquitous requirements

- **U1** — `graphHash` byte-identity MUST hold before/after every commit (existing `DuckStore`/`GraphDbStore` parity suite stays green).
- **U2** — `packHash` byte-identity MUST hold for unchanged `(commit, tokenizer, budget, pins)`. Tier-3 LSP facts MUST NOT enter the packHash preimage (see U7, AC-A4).
- **U3** — No tracked, non-excluded source file MUST introduce a banned literal; `scripts/check-banned-strings.sh` exits 0 post-commit.
- **U4** — `mise run check` MUST exit 0 after every commit.
- **U5** — Every new package MUST be `@opencodehub/<name>`, Apache-2.0, `type: module`, `tsc --noEmit` clean. Every new commit scope MUST exist in `scope-enum` before first use.
- **U6** — No LLM calls outside `@opencodehub/summarizer`.
- **U7** — Every MCP tool and CLI output MUST stay deterministic (alpha-sort, lex-stable tiebreak). Any extraction tier whose upstream is nondeterministic (LSP) MUST be canonically re-sorted and version-pinned before any consumer reads it.
- **U8** — The repo MUST retain a working `@opencodehub/cli` npm install path unchanged; the Docker image is **additive**, never a replacement (validation constraint: `verify-global-install.yml` stays green).
- **U9** — No HTTP server surface is introduced (ROADMAP rail #2). The Docker image runs the **stdio** MCP server; `docker run -i` is the transport, not a network listener. (`rg 'express|fastify|http.createServer' packages/` → 0.)

---

## Track B (Docker) — requirements

*Sequenced first; it is the hinge for Track A.*

- **AC-D0** — ROADMAP §"Explicitly rejected" MUST gain: "Single self-contained binary (pkg / SEA / Bun / Deno compile) — Docker image is the sole non-npm distribution artifact." Recorded so a future contributor doesn't reopen the binary track.
- **E-D1** — When `docker build` runs against the repo, it MUST be a **multistage build**: stage 1 (`node:24` builder) runs `corepack enable && corepack prepare pnpm@11.1.0`, `pnpm install --frozen-lockfile`, the workspace build, then `pnpm deploy --prod --filter @opencodehub/cli` to prune; stage 2 (`node:24-slim` runtime) copies the pruned app + `node_modules` (native `.node` intact) + `.wasm` grammars.
- **E-D2** — When the image is built for release, it MUST be built for **both `linux/amd64` and `linux/arm64`** via buildx, so onnxruntime-node and `@ladybugdb/core` prebuilds match the target arch (no cross-arch prebuild mismatch).
- **E-D3** — When the **full** image variant is built, it MUST bundle the **curated SCIP set**: scip-typescript (npm, already a dep), scip-go (`scip-code/scip-go` static binary), and a **jlink-trimmed JRE + scip-java**; and provision Python indexers via `COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/`. Each indexer pinned to the ADR-0006 versions.
- **E-D4** — When the **lite** image variant is built, it MUST contain parser + graph + CLI + stdio MCP only (no embedder, no JVM), targeting ~300 MB; the full variant targets ~500–700 MB.
- **S-D5** — While running as the MCP server, the container MUST be invoked `docker run -i --rm <image> och-mcp` and speak JSON-RPC over stdio; the README + a `.mcp.json` snippet for Claude Code / Cursor MUST document this exact invocation.
- **AC-D6** — The OSS image MUST NOT contain GPL/MPL binaries (hadolint, tflint, GPL/EPL LSP servers); these are detect-on-PATH-and-subprocess only. `license_audit` over the image MUST stay on the allowlist.
- **AC-D7** — A `mise` task (`docker-build`, `docker-build-full`) MUST wrap the buildx invocation; a CI job MUST build both variants on push to main and on release tags and smoke-test `docker run -i --rm <image> och-mcp` answers an `initialize`/`server/discover` round-trip.
- **AC-D8** — `.dockerignore` MUST exclude `node_modules`, `.git`, `.erpaval/`, sibling worktrees, and test fixtures so the build context stays lean and the worktree-biome collision can't leak in.

## Track A (SCIP + LSP breadth) — requirements

*Blocked on Track B's per-toolchain image for the heavy indexers.*

### Milestone A-S — finish "all SCIP"

- **E-A1** — When a project with `composer.json` is indexed and `--allow-build-scripts` is set, the `php` runner MUST shell `scip-php` (Composer/Packagist), capture `index.scip`, and ingest its edges at the **`scip-unofficial` (Tier 1.5)** confidence label. `php` MUST be added to `IndexerKind`, `ALLOWED_COMMANDS`, and `detectLanguages`.
- **E-A2** — When a project with `pubspec.yaml` is indexed, the `dart` runner MUST shell `scip-dart` (`dart pub global activate`) at the **Tier 1.5** label; `dart` added to the same three surfaces.
- **AC-A3** — `SCIP_PROVENANCE_PREFIXES` (`core-types`) MUST gain a `scip-unofficial:` class distinct from `scip:`; `confidence-demote` and the MCP confidence-breakdown helper MUST surface the tier so a consumer can tell a first-party edge from a pre-alpha one.
- **AC-A3b** — ADR 0006 pin table MUST be updated: scip-go path → `github.com/scip-code/scip-go/cmd/scip-go@v0.2.7`; CLI pinned `scip-code/scip@0.8.1`; php/dart rows added with their channels.

### Milestone A-L — LSP-backed Tier-3 (SCIP-blind languages only)

- **E-A4 / U7 / U2** — When a SCIP-blind language (Swift, Zig, Elixir, Terraform, Clojure, Gleam, Nix, Lua, SQL) is indexed, a new package **`@opencodehub/lsp-tier`** MUST drive extraction as `workspace/symbol`(empty) → `blast_radius` over the repo file list, producing symbols + cross-file edges. Every Tier-3 fact MUST be tagged `source=lsp`, `server=<binary>@<pinned-version>`, canonically re-sorted, and **excluded from the packHash preimage** (kept in a separate sidecar, or folded in only after server-version pinning + sort, treating a server bump as a deliberate index-version bump).
- **S-A4b** — While the LSP server has not reached full warmup readiness, the runner MUST block; a query returning partial results MUST be treated as a **hard failure**, never written to cache.
- **AC-A5** — Wrapped LSP servers (jdtls EPL, clangd Apache, elixir-ls Apache, etc.) MUST be license-audited individually; the wrapped-server license governs the subprocess (aligns with the existing "GPL/MPL are subprocess-only" rule). agent-lsp's MIT covers only the vendored wrapper code.
- **AC-A6** — New **ADR 0019 — "LSP returns as a quarantined Tier-3 for SCIP-blind languages"** MUST be written, explicitly amending ADR 0005's scope (0005 rejected LSP *as the oracle*; 0019 adds LSP *as a labeled, batch-only fallback* off the determinism hot path). `lsp-tier` MUST be added to `scope-enum` in its first commit.
- **O-A7** (optional/unwanted-behavior) — If the operator has NOT opted into Tier-3, the LSP servers MUST NOT be spawned and SCIP-blind languages MUST degrade to Tree-sitter heuristics silently (no daemon, no warmup cost).

## Track C (receipts + conformance + eval) — requirements

*Parallel; C1/C2/C4 are independent of A and B. C3 lives in the testbed repo.*

### Move 1 — `pack --prove` + `replay`

- **E-C1** — When `codehub pack --prove` runs, it MUST emit an in-toto **SLSA Provenance v1** statement whose **subject digest == packHash**, predicate recording `(commit, tokenizer, budget, pins)` as `externalParameters` and every BOM input by URI+digest, signed via the existing `attest-build-provenance` (CI path) and `cosign sign-blob --bundle` (local/air-gapped path).
- **E-C2** — When `codehub replay <hash>` runs, it MUST check out the recorded commit, re-run the packer with the recorded `(tokenizer, budget, pins)`, recompute the packHash, and **byte-compare** against the attested subject; match → exit 0 "reproduced", mismatch → non-zero with a diff of which BOM item drifted.
- **AC-C3** — Verification MUST be offline-capable: `cosign verify-blob-attestation --bundle` against a vendored Sigstore root proves who signed which hash (Rekor inclusion checked offline via the bundle SET); `replay` re-derives bytes locally. No network required for either step.

### Move 2 — cache-prefix reframe

- **AC-C4** — `@opencodehub/pack` docs + `manifest.json` README MUST lead with cache-prefix stability and retire the "fewer tokens" framing. Grounded claim: *"A byte-identical pack is a reusable cache prefix — second and later calls read it at 0.1× input cost; grep round-trips mutate the prompt every turn, invalidating the `messages` level, so they never cache."*
- **E-C5** — When a pack is assembled, the most-stable BOM items (skeleton, file-tree, deps) MUST be ordered **first** so the longest possible prefix is cache-eligible, and the doc MUST note the ≤4-`cache_control`-breakpoint placement and the 1,024-token Opus-4.8 minimum.

### Move 3 — CORE-Bench L3 (testbed repo)

- **AC-C6** — The CORE-Bench L3 harness MUST live in the testbed repo (validation constraint #4 — evals are not in core).
- **E-C7** — When the harness runs, it MUST embed L3 queries + corpus via OCH retrieval, rank, and score against the gold relevance labels, reporting OCH's L3 number framed by CodeCompass's +23.2-pt G3 result.
- **AC-C8** — Before the metric is fixed in code, the CORE-Bench **PDF tables MUST be read** to confirm whether L3 is scored by nDCG@k or Recall@k (HF dataset card is empty; do not assume).

### Move 4 — MCP 2026-07-28 stateless conformance

- **E-C9** — When the MCP server receives any request, it MUST read `io.modelcontextprotocol/protocolVersion`, `clientInfo`, and `clientCapabilities` from `_meta` per-request and MUST NOT depend on remembered `initialize`-handshake state; a version mismatch MUST return `UnsupportedProtocolVersionError`. *(Hardest item; touches every handler; SDK-gated.)*
- **E-C10** — The server MUST implement `server/discover` advertising supported protocol versions, the ~28 tools' capabilities, and server identity.
- **E-C11** — The server MUST remove `ping`, `logging/setLevel`, and `notifications/roots/list_changed`; log level moves to per-request `io.modelcontextprotocol/logLevel` in `_meta`.
- **E-C12** — `tools/list`, `resources/list`, `prompts/list`, and resource reads MUST carry **`ttlMs` + `cacheScope`** JSON fields (NOT `etag`); OCH's static catalog → generous `ttlMs`, shareable `cacheScope`.
- **AC-C13** — The MCP package README MUST document the stdio-only rail as the reason `Mcp-Method`/`Mcp-Name` headers, OAuth/EMA, and session IDs are intentionally absent — so a future contributor does not "helpfully" add HTTP-transport machinery the rail forbids.
- **AC-C14** — `protocolVersion` MUST be pinned to `2026-07-28` gated on the upstream MCP SDK shipping support (it was on 2025-11-25 / 2026-03-26 at spec time); the transport MUST NOT be hand-rolled.

---

## Open decision (blocks Milestone A-L only)

**Q1 — ADR 0005 amendment.** Track A-L reopens ADR 0005. Two options:
1. **Amend (recommended)** — write ADR 0019, allow a quarantined Tier-3 LSP fallback for SCIP-blind languages only. Unlocks Swift/Elixir/Zig/Terraform/Clojure at a labeled lower-confidence tier.
2. **Stop at "all SCIP"** — ship A-S (php/dart only), skip A-L, leave SCIP-blind languages on Tree-sitter heuristics. ADR 0005 stands unchanged; smaller surface, no daemon/warmup cost, no determinism-quarantine complexity.

Everything in Milestone A-L branches on Q1. A-S, all of Track B, and all of Track C proceed regardless.
