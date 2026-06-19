# Brainstorm 014 — Three roadmap plans: full SCIP + agent-lsp, binary/Docker distribution, and moves 1–4

**Date:** 2026-06-19
**Requested by:** Laith (sole user, rip-and-replace latitude)
**Grounding:** 5 parallel research subagents (web-search + ydc + Context7 + deepwiki, exa/tavily fallback), all primary-source verified this session. Local ground truth from `packages/scip-ingest`, `packages/pack`, `packages/mcp`, ADR 0005/0006, `.erpaval/ROADMAP.md`.

This doc holds three independent plans plus a cross-plan sequencing recommendation at the end. Each plan states the bet, what must be true, the ground-truth it rests on, and the package(s) it touches. No calendar estimates (roadmap convention); sequenced by dependency.

---

## Plan A — Add every SCIP indexer + every agent-lsp language

### A.0 The honest framing first

The ask reopens **ADR 0005 ("SCIP replaces LSP, end to end")**, which deliberately *deleted* `@opencodehub/lsp-oracle` (~10.6k LOC) because LSP was stateful, per-file, daemon-driven, and editor-oriented. Adding "all agent-lsp" puts an LSP tier back. That is allowed under rip-and-replace latitude, but it is a reversal, so this plan adopts LSP **only where SCIP has no indexer**, at a **labeled lower confidence tier**, **quarantined from the packHash**. It does not re-introduce LSP for any language SCIP already covers.

### A.1 Ground truth (verified 2026-06-19)

**SCIP topology changed under us.** Governance left Sourcegraph on 2026-03-25; the protocol + CLI is now `scip-code/scip` **v0.8.1** (2026-06-04), with a 4-stage SEP RFC process. `scip-go` and `scip-rust` migrated to `scip-code`; the language indexers stayed under `sourcegraph`.

**The indexer matrix (every install channel differs; most must build the repo):**

| Indexer | Langs | Latest (verified) | Install channel | Index-time prereq |
|---|---|---|---|---|
| scip-typescript | TS/JS | v0.4.0 (2025-10-02) | npm `@sourcegraph/scip-typescript` | Node + tsconfig |
| scip-python | Python | 0.6.6 (npm, 2025-09) | npm-only | Node; Pyright resolve |
| scip-go | Go | v0.2.7 (2026-05-25) | `go install scip-code/scip-go` | Go toolchain + go.mod |
| scip-java | Java/Scala/Kotlin | v0.12.3 (2026-04-02) | Coursier / Maven Central JAR | **JVM + Gradle/Maven/sbt** |
| scip-clang | C/C++ | v0.4.0 (2026-02-23) | native binary | **compile_commands.json + built project, ~2 GB RAM/core** |
| scip-ruby | Ruby | v0.4.7 (2025-11-07) | native binary / RubyGems | Sorbet toolchain |
| scip-dotnet | C# | v0.2.14 (2026-05-05) | `dotnet tool` / NuGet | **.NET 8 SDK + .sln** |
| scip-php* | PHP | v0.0.2 (2026-06-11) | Composer (Packagist) | PHP + Composer |
| scip-dart* | Dart | 1.6.2 (2025-05-28) | `dart pub global activate` | Dart SDK |
| rust-analyzer | Rust | subcommand `rust-analyzer scip` | rustup component | cargo + rust-analyzer |

\* `scip-php` (davidrjenni) and `scip-dart` (Workiva) are **third-party, not CSC-governed**; scip-php is pre-alpha (v0.0.2). **No `scip-swift` or `scip-elixir` exists** (probed directly).

**Current code state:** `packages/scip-ingest/src/runners/index.ts` already wires 10 `IndexerKind`s (ts/py/go/rust/java/clang/ruby/dotnet/kotlin/cobol-proleap) behind a closed `ALLOWED_COMMANDS` spawn allowlist. M4 is **half-built**, not greenfield. Gaps vs "all SCIP": scip-php, scip-dart. Gaps vs "all languages": everything with no SCIP path.

**agent-lsp:** `blackwell-systems/agent-lsp` v0.15.0 (2026-06-13), **MIT** (clears the Apache/MIT/BSD/ISC allowlist). It's a single Go binary that wraps LSP subprocesses and exposes them over MCP. Covers ~30 languages incl. the exact SCIP-blind set: **Swift (sourcekit-lsp), Zig (zls), Elixir (elixir-ls), Terraform/HCL (terraform-ls), Clojure (clojure-lsp), Gleam, Nix, Lua, SQL**. It does **not** bundle servers — auto-detects on PATH or takes `lang:server` args.

**The ADR-0005 verdict (the crux):** agent-lsp **overcomes** the "per-file/interactive" objection. `workspace/symbol` with an empty query enumerates all project symbols headlessly, and its `blast_radius` primitive auto-enumerates exported symbols across a file set and resolves cross-file references without the agent supplying positions — the batch primitive ADR 0005 assumed LSP lacked. It does **not** overcome "stateful/running server" (warm index, fsnotify watcher, 5-min cold timeout), but that's an operational cost OCH already pays for SCIP subprocesses, not a correctness barrier.

**Determinism risk (the real friction):** agent-lsp explicitly does not target byte-stability. Outputs aren't globally sorted; server versions aren't pinned; `workspace/symbol` completeness is server-dependent. Its `blast_radius` SQLite cache is keyed by SHA-256 file-content hash + symbol identity and *is* reproducible given identical contents **and identical server versions** — which OCH must control.

### A.2 The plan — a three-tier extraction model

Promote the existing two-tier (SCIP > Tree-sitter) to **three tiers with explicit confidence labels**:

- **Tier 1 — SCIP precise** (compiler-grade): the first-party `sourcegraph` indexers + scip-go/rust-analyzer.
- **Tier 1.5 — SCIP unofficial** (mid-confidence): scip-php, scip-dart, the scip-rust wrapper. Labeled distinctly so a consumer knows the edge came from a pre-alpha/third-party tool.
- **Tier 2 — Tree-sitter heuristic** (unchanged).
- **Tier 3 — LSP-backed** (agent-lsp, lowest precise-ish tier, **for SCIP-blind languages only**): Swift, Zig, Elixir, Terraform, Clojure, etc.

**Milestone A-S (finish "all SCIP"):**

| Task | Scope | Touches |
|---|---|---|
| A-S1 | Add `php` + `dart` to `IndexerKind`, `ALLOWED_COMMANDS`, `detectLanguages` (composer.json / pubspec.yaml), and runners. Label both **Tier 1.5**. | `scip-ingest` |
| A-S2 | Update the SCIP org topology: repoint `scip-go` provenance/install to `scip-code/scip-go`; pin CLI `scip-code/scip@0.8.1`. Refresh ADR 0006 pin table. | `scip-ingest`, `docs/adr/0006` |
| A-S3 | **Containerized per-language runner images** (one per toolchain: node, go, jvm+gradle, dotnet-sdk, clang+compile-db, sorbet, php, dart). OCH invokes the image, captures `index.scip`, ingests. This is the only sane way to provision 9 mutually-incompatible install channels + build steps. Gated behind `--allow-build-scripts`. | `scip-ingest`, new `docker/indexers/*` |
| A-S4 | Confidence-tier provenance: extend `SCIP_PROVENANCE_PREFIXES` with a `scip-unofficial:` class for Tier 1.5; surface tier in `confidence-demote` + MCP confidence breakdown. | `core-types`, `scip-ingest`, `analysis`, `mcp` |

**Milestone A-L (add the LSP tier):**

| Task | Scope | Touches |
|---|---|---|
| A-L1 | New package `@opencodehub/lsp-tier` (note: NOT the deleted `lsp-oracle` — different contract, batch-only). Vendor agent-lsp's MIT Go packages (`pkg/lsp` LSPClient + `blast_radius` enumerate-resolve) OR shell its `--http` server, version-pinned, subprocess-isolated. | new pkg |
| A-L2 | Extraction driver: per SCIP-blind language, `workspace/symbol`(empty) → `blast_radius` over the repo file list → symbols + cross-file edges. Block on full warmup readiness; treat partial results as a **hard failure**, never a cache entry. | `lsp-tier`, `ingestion` |
| A-L3 | **Determinism quarantine** (non-negotiable, defends validation constraint #7). Tag every Tier-3 fact `source=lsp`, `server=<binary>@<pinned-version>`. Canonically re-sort all collections before use. Keep Tier-3 facts in a **separate sidecar excluded from the packHash preimage**, OR fold them in only after server-version pinning + canonical sort, treating a server bump as a deliberate index-version bump. | `lsp-tier`, `pack`, `core-types` |
| A-L4 | License-audit each **wrapped** LSP server separately (jdtls EPL, clangd Apache, etc.). agent-lsp's MIT covers the wrapper; the wrapped server's license governs the subprocess — which aligns with OCH's existing "GPL/MPL are subprocess-only" rule. | `scanners`/`policy`, `docs/adr` |
| A-L5 | New ADR **0019 — "LSP returns as a quarantined Tier-3 for SCIP-blind languages"**, explicitly amending ADR 0005's scope (it rejected LSP *as the oracle*; this adds LSP *as a labeled fallback*, batch-only, never on the packHash hot path). | `docs/adr` |

**Bet:** language *breadth* is worth having as a labeled-confidence feature even though it's commoditizing — but only if it never contaminates the determinism contract, which is the actual moat. **What must be true:** the Tier-3 quarantine holds (validation constraint #6/#7 stays green), and the containerized runners don't balloon the install surface past what Plan B can ship.

**Tension with today's contrarian (move #6):** this run's roadmap argued *cancel* M4 breadth because it's commoditized. Plan A is the steelman of the opposite. Reconciliation: breadth is fine **as a Docker-delivered, confidence-labeled capability** (cheap once the per-language runner images exist), and **not** worth hand-porting into a single binary or onto the packHash. Build breadth in the image; keep the binary lean. That resolves the contradiction instead of pretending it isn't there.

---

## Plan B — Ship a single binary and/or Docker image

> **SUPERSEDED 2026-06-19 (Laith):** the single-binary track is **dropped — no exceptions**. Docker multistage (pnpm + Node 24) is the sole non-npm distribution artifact. The finalized, EARS-specced version of this plan lives at `.erpaval/specs/008-distribution-determinism-breadth/` (spec.md + tasks.md + plan.yaml), which also merges this with Plan A (breadth rides the image) and Plan C. The §B.2 binary milestone (B-B) below is retained only as a record of the rejected option.

### B.1 Ground truth (verified 2026-06-19)

OCH is a pnpm v11 + Node 24 TS/ESM monorepo shipping as `@opencodehub/cli` + a stdio MCP entrypoint. Three native/non-JS pieces dominate every packaging decision:
1. **onnxruntime-node** (embedder) — per-platform prebuilds; known darwin-x64 weakness; dynamic binding path defeats naive bundlers.
2. **`@ladybugdb/core`** — pre-1.0 native graph engine, ABI breaks; single most fragile dep.
3. **scip-java's JVM** (+ the other 8 indexer toolchains) — fundamentally **un-bundleable into a single binary**.

Plus WASM tree-sitter grammars (ADR 0015, easy to embed) and GPL/MPL scanners (hadolint, tflint — subprocess-only, never bundle).

**Binary options (verified):**

| Option | Native addons (onnx/ladybug) | Cross-platform matrix | Verdict |
|---|---|---|---|
| Node 24/25 SEA (`--build-sea`, consolidated v25.5.0) | works via `getRawAsset`+`dlopen` temp-extract, manual per-addon | **weak** — no macOS-x64 (skipped in tests), CJS-only entry | right long-term, blocked today |
| **@yao-pkg/pkg 6.12** | works; needs explicit `assets` glob + onnxruntime dynamic-path workaround | **strong** — ships Node 24.12 patched binaries, cross-compiles incl. macOS-x64 | **best today** |
| Bun `--compile` | **high risk** — JSC not V8; `.node`-in-compile bug (#158) | strong | only for a parser-only "lite" build |
| Deno compile | Node-API only with `--self-extracting` | strong | least proven for this native trio |

### B.2 The plan — "lite binary + full image" split, Docker first

**Milestone B-D (Docker first):**

| Task | Scope |
|---|---|
| B-D1 | Multi-stage: `node:24` builder (corepack pnpm@11, `pnpm install --frozen-lockfile`, build, `pnpm deploy --prod`) → `node:24-slim` runtime. Build **per-arch via buildx** (linux/amd64 + linux/arm64) so onnxruntime/ladybug prebuilds match the exact target — this *eliminates* the darwin-x64-style prebuild pain. |
| B-D2 | Bundle a curated SCIP set inside the image: scip-typescript (npm, already a dep), scip-go (static binary), **jlink-trimmed JRE + scip-java** (~50 MB custom runtime vs 200 MB full JRE). `COPY --from=ghcr.io/astral-sh/uv:latest` for any Python indexer. |
| B-D3 | Keep GPL/MPL scanners (hadolint, tflint) **out** of the OSS image; detect-on-PATH + subprocess if the host has them (license hygiene). |
| B-D4 | Document stdio MCP invocation: `docker run -i --rm <image> och-mcp` for Claude Code / Cursor `.mcp.json` (`command: "docker", args: ["run","-i","--rm",...]`). |
| B-D5 | Image variants: **full** (~500–700 MB: embedder + JVM + curated indexers) and **lite** (~300 MB: parser + graph + MCP, no embedder/JVM). |

**Milestone B-B (lite binary, after Docker proves the dep set):**

| Task | Scope |
|---|---|
| B-B1 | esbuild/tsup the ESM monorepo to a CJS entry (pkg + SEA both need CJS). |
| B-B2 | `@yao-pkg/pkg` build, target matrix `node24-{linux,macos,win}-{x64,arm64}`. Scope = **parser + graph + CLI + MCP stdio**; embedder (onnxruntime) and JVM indexers are **optional/pluggable**, not in the binary. |
| B-B3 | `assets` manifest pins the `.wasm` grammars + each required `.node`; apply the onnxruntime dynamic-binding-path workaround if the embedder is opt-in-bundled. |
| B-B4 | **Runtime capability check, not hard import**: if onnxruntime/ladybug are absent, degrade to parser-only mode rather than crash. Converts the two riskiest natives from build-dealbreakers into optional features. |
| B-B5 | Pin `@ladybugdb/core` exactly (`=x.y.z`, no `^`); CI smoke-test that loads the addon on each target arch on every Ladybug bump. |
| B-B6 | Defer SEA migration to a tracked follow-up for when macOS-x64 SEA lands (drops the pkg patched-node supply chain). |

**Bet:** install friction is OCH's real distribution gap (rivals enter via zero-config binaries/IDE; OCH only reaches devs already running npm + an MCP agent). **What must be true:** the embedder and JVM indexers can be made genuinely optional so the lite binary stays small and the full pipeline lives in Docker. **Why Docker first:** a multi-stage image naturally solves per-platform prebuilds (install on the exact target arch) and is the *only* vehicle that can carry scip-java's JVM; once it proves the working dep versions + arch matrix, the pkg `assets` manifest is just a subset of that proven set.

**Rail check:** self-hosted OSS only — both artifacts are self-hosted, no SaaS. ✅

---

## Plan C — Concrete plans for today's moves 1–4

### Move 1 — `pack --prove` + `replay <hash>` (verifiable reproducibility)

**Foundation already exists:** `packages/pack/src/manifest.ts` computes `packHash = sha256(RFC8785 canonicalJson(manifest))` with `pins` (grammar commits, tokenizer, duckdb version) and a `determinismClass` (`strict`/`best_effort`/`degraded`). The release workflow **already** runs cosign keyless (Fulcio + Rekor) + `actions/attest-build-provenance@v4`. This move wraps proven machinery; it does not build signing from scratch.

| Task | Scope |
|---|---|
| C1-1 | `pack --prove`: emit an in-toto **SLSA Provenance v1** statement whose **subject digest == packHash**, predicate records `(commit, tokenizer, budget)` as `externalParameters` + every BOM input by URI+digest as `resolvedDependencies`. Sign via the existing `attest-build-provenance` (GitHub path) and `cosign sign-blob --bundle` (local/air-gapped path). | `pack`, `cli`, release workflow |
| C1-2 | `codehub replay <hash>`: check out the recorded commit, re-run the packer with recorded tokenizer+budget, recompute packHash, **byte-compare** to the attested subject. Match → "reproduced." | `pack`, `cli` |
| C1-3 | Offline verification: `cosign verify-blob-attestation --bundle` against a **vendored Sigstore root** proves who signed what hash (Rekor inclusion checked offline via the bundle SET); `replay` re-derives bytes locally. Both run air-gapped — the third-party-verifiable property the moat needs. | `cli`, docs |
| C1-4 | Attach a CycloneDX SBOM as a separate attestation (`--type cyclonedxjson`) for the BOM itself. | `pack`, `sarif` |

**Bet:** "deterministic" went from 0 to 2 public claimants this week (Archex Jun 15, LeanCTX Jun 12); a *checkable* contract no one else has is the durable edge. **What must be true:** `replay` is bit-stable across machines for `determinismClass=strict` (the existing graphHash parity discipline says it is).

### Move 2 — cache-prefix stability reframe

**Verified Anthropic mechanics (Context7, claude.com GA post):** cache-read = **0.1× input (90% cheaper)**; cache-write = 1.25× (5-min TTL) / 2.0× (1-hr). Min cacheable prefix on **Opus 4.8 = 1,024 tokens** (Sonnet 4.6 = 1,024; Haiku 4.5 = 4,096; Bedrock minimums differ). Cache hierarchy **tools → system → messages**; a change at any level invalidates that level and everything after; matching is 100%-identical-bytes on the cumulative prefix, ≤4 breakpoints, 20-block lookback. **1M context is flat-rate** on Opus 4.8/4.7/4.6 + Sonnet 4.6 — no long-context premium (one secondary aggregator still shows a >200K tier; the official GA post overrides it).

| Task | Scope |
|---|---|
| C2-1 | Reframe `pack` docs/output: lead with **stable cache prefix**, retire "fewer tokens." The grounded one-liner: *"A byte-identical pack is a reusable cache prefix — second and later calls read it at 0.1× input cost; grep round-trips mutate the prompt every turn and invalidate the `messages` level, so they never cache."* | `pack`, README |
| C2-2 | Emit packs with the stable content **first** (skeleton/file-tree/deps — the parts that change least) so the longest possible prefix is cache-eligible, and document the ≤4-breakpoint placement. | `pack` |
| C2-3 | Publish a cache-hit-rate + cost benchmark on a 1M flat-rate window: OCH pack (stable prefix) vs grep round-trips (no cache). Honest caveat in the writeup: first call pays the 1.25×/2.0× write; the win is every read after + prefix stability across turns. | `eval`/testbed |

**Bet:** flat-rate 1M context killed the token-savings pitch; caching is the surviving cost lever and determinism is what makes a pack cache-stable. **What must be true:** OCH packs are byte-stable turn-to-turn for an unchanged `(commit, tokenizer, budget)` — which is the existing contract.

### Move 3 — publish CORE-Bench LEVEL-3 numbers

**Verified:** **CORE-Bench = arXiv:2606.11864** (cs.IR, 2026-06-09), 3 levels (L1 understanding → L2 issue-to-edit localization → **L3 broader-context retrieval w/ in-repo distractor filtering**), **180K+ queries / 106K relevance labels** from SWE-bench-series. **Metric names UNVERIFIED** — HF dataset card (`zhangfw123/CORE-Bench`) is empty and the abstract is silent; field convention is nDCG@k / Recall@k but confirm from the PDF tables before fixing. **Name-collision warning:** ignore the unrelated arXiv:2409.11363 CORE-Bench (computational reproducibility). Supporting: **CodeCompass / Navigation Paradox arXiv:2602.20048** — graph nav **+23.2 pts** on G3 hidden-dependency tasks (99.4% vs 76.2% ACS), and **BM25 gives ~0 lift on G3** (78.2 vs 76.2) — the precise "graph beats grep exactly where it matters" anchor. **ContextBench arXiv:2602.05892** — 1,136 tasks / 66 repos / 8 langs, human gold contexts, recall/precision/efficiency trajectory metrics, live leaderboard.

| Task | Scope |
|---|---|
| C3-1 | Read the CORE-Bench PDF tables; pin the exact L3 metric (nDCG@k vs Recall@k) and dataset repo/lang counts before building the harness. | `eval`/testbed |
| C3-2 | Build the harness in the testbed repo (validation constraint #4 — evals live there, not core): embed L3 queries + corpus via OCH's retrieval, rank, score against gold relevance labels. | testbed |
| C3-3 | Publish OCH's L3 numbers (first-mover claim is open — no code-graph platform has published L3), framed by CodeCompass's +23.2-pt result as the "why graphs win" citation. | testbed, README |

**Bet:** "graph beats long-context dump" needs a citable number now that dump is cheap; CORE-Bench is 10 days old and the L3 leaderboard slot is empty. **What must be true:** OCH's deterministic graph-context retrieval actually wins on L3 distractor-filtering (CodeCompass evidence says graph nav does).

### Move 4 — conform to the MCP 2026-07-28 stateless RC

**CRITICAL CORRECTION to this morning's roadmap post:** for a **stdio-only** server, the `Mcp-Method`/`Mcp-Name` routing headers do **NOT** apply (Streamable-HTTP only), and **EMA / ID-JAG / OAuth do NOT apply** (the spec says stdio servers SHOULD NOT follow the authz framework — use env-var creds). There is also **no spec requirement to sign tool descriptions** (only "treat descriptions as untrusted unless from a trusted server"). The morning post over-scoped these; this is the corrected change-list.

**What genuinely applies to a stdio server (transport-agnostic):**

| Task | Effort/Risk | Scope |
|---|---|---|
| C4-1 | **Stateless `_meta` model** — read `io.modelcontextprotocol/protocolVersion` + `clientInfo` + `clientCapabilities` from each request's `_meta`; drop reliance on the `initialize` handshake; return `UnsupportedProtocolVersionError` on mismatch. **This is the spine and the hardest-clocked item** — it touches every handler and depends on the SDK shipping 2026-07-28 support. | M / **High** | `mcp` |
| C4-2 | Implement `server/discover` (advertise protocol versions + the ~28 tools' capabilities + identity). | S / Med | `mcp` |
| C4-3 | Remove `ping`, `logging/setLevel`, `notifications/roots/list_changed`; move log level to per-request `_meta.logLevel`. | S / Med | `mcp` |
| C4-4 | Add `ttlMs` + `cacheScope` JSON fields (NOT `etag` — corrected) to `tools/list` / `resources/list` / `prompts/list` + resource reads. OCH's catalog is static → generous `ttlMs`, shareable `cacheScope`. | S / Low | `mcp` |
| C4-5 | Deprecation hygiene: migrate any Roots/Sampling/Logging client-feature use; pin `protocolVersion=2026-07-28` gated on SDK support. | S–M / Low | `mcp` |
| C4-6 | Tool-description security audit across all ~28 tools (injection/poisoning); no signing required by spec. | S / Low | `mcp` |
| C4-7 | **Document the stdio-only rail in the MCP package README** so a future contributor doesn't "helpfully" add HTTP headers / OAuth / EMA / session IDs. | trivial | `mcp`, docs |

**Hard clock:** July 28, 2026. **Bet:** a stdio MCP server still must match the new JSON-RPC/schema shape or fall out of compatibility; over-engineering HTTP concerns the rail forbids is wasted work. **What must be true:** the upstream MCP SDK ships 2026-07-28 support in time (it was on 2025-11-25 / 2026-03-26 this session — watch it; don't hand-roll the transport).

---

## Cross-plan sequencing (if you run all three)

```
C4 (MCP RC) ──────────────► hard external clock: July 28. Start now, SDK-gated.
C1 (pack --prove) ────────► cheapest, defends the moat under live attack. Do first.
C2 (cache reframe) ───────► rides on C1's stable pack. Docs + benchmark.
B-D (Docker) ─────────────► unblocks the full pipeline + becomes the home for Plan A breadth.
   └─► A-S (all SCIP) ────► needs B-D's per-toolchain images to be sane.
        └─► A-L (LSP tier) ► last; highest determinism risk, must stay quarantined.
   └─► B-B (lite binary) ─► after B-D proves the dep set.
C3 (CORE-Bench) ──────────► independent; testbed repo; run in parallel whenever.
```

**The single thread that ties it together:** Plan B's Docker image is the delivery vehicle that makes Plan A's "all SCIP + all LSP" affordable (per-toolchain runner images) **without** putting breadth into the lean binary or onto the packHash. That reconciles the maximalist ask with this morning's contrarian "cancel breadth" move: **build breadth in the image, keep the binary and the determinism contract lean.**

**If forced to pick one to start:** C1 (`pack --prove`) — smallest surface, reuses cosign/attest machinery already in CI, and directly defends the one differentiator two competitors attacked this week.

**Open question for Laith:** Plan A reopens ADR 0005. Are you ok amending it (new ADR 0019) to allow a quarantined Tier-3 LSP fallback for SCIP-blind languages only — or do you want breadth to stop at "all SCIP" (add scip-php/scip-dart, skip agent-lsp) and leave Swift/Elixir/Zig on Tree-sitter heuristics?
