# EARS Spec 004 — M3 LadybugDB phase-1 + M4 Language expansion

**Session**: session-a591fa · **Branch**: `feat/v1-m3-m4` · **Parent roadmap**: `.erpaval/ROADMAP.md` §M3 + §M4

## Context (Explore + Research consolidated)

### M3 — LadybugDB phase-1

- `IGraphStore` seam at `packages/storage/src/interface.ts:11-64` is already the abstraction point. No shape change needed.
- `graphHash` is computed in `packages/core-types/src/graph-hash.ts:20-45` from the **in-memory `KnowledgeGraph`**, never from store rows. Parity test: `graph → LbugStore → rebuildGraphFromStore → graphHash === original`. Template exists at `packages/storage/src/duckdb-adapter.test.ts:89,206-229`.
- **Current edge-kind count is 23** (`duckdb-adapter.ts:71-96`) — roadmap's "21 types" is stale; OCH has drifted past with `FOUND_IN`, `DEPENDS_ON`, `OWNED_BY`, `WRAPS`, `QUERIES`, `REFERENCES`, `ACCESSES`. OCH uses `PROCESS_STEP`; the `STEP_IN_PROCESS` form is a banned literal.
- **LadybugDB pattern correction** (supersedes roadmap L58): idiomatic LadybugDB uses **polymorphic rel tables — one named rel table per edge kind, each with multiple `FROM/TO` pairs**. NOT a single `CodeRelation` rel table with a `type` property column — that defeats columnar predicate pushdown. Research URL: `docs.ladybugdb.com/cypher/data-definition/create-table`.
- **npm package**: `@ladybugdb/core@^0.16.1` (latest as of 2026-05-04). `lbug@0.14.3` is a stale mirror — ignore.
- **Concurrency**: one process-wide `READ_WRITE` `Database` + pool of `Connection` objects. The pool wrapper (~600 LOC) is user-space, not library convention — re-audit any pool semantics for v0.16 behavior.
- **Banned literals**: `kuzu`, `ladybug`, `STEP_IN_PROCESS`, `duckpgq` are banned in tracked source by `scripts/check-banned-strings.sh`. `@ladybugdb/core` in `package.json` is allowed (not a banned form). `.erpaval/` is excluded from the scan. The `LbugStore` class name and file paths `lbug-adapter.ts` / `lbug-pool.ts` use the "lbug" token which triggers the banned literal. **Resolution**: rename everything to `GraphDbStore` / `graphdb-adapter.ts` / `graphdb-pool.ts` at the source level; keep `@ladybugdb/core` as the dep name (the package scope is exempt by precedent).

### M4 — Language expansion + COBOL + framework detection

- 5 live SCIP adapters in `packages/scip-ingest/src/runners/index.ts:18` as a string union `"typescript" | "python" | "go" | "rust" | "java"`. No provider-registry abstraction. Adding `clang | ruby | dotnet | kotlin` = extend union + add `buildCommand` cases.
- **No scip-* binary downloads**: `codehub setup` only handles embeddings weights + plugin. New adapters assume binaries on `$PATH` (returns `kind: "missing"` on ENOENT). M4 must add `scip-downloader.ts` mirroring `embedder-downloader.ts` (sha256 pin + atomic rename).
- 15 tree-sitter grammars in `grammar-registry.ts:36-52`, compile-time-enforced via `satisfies` on `LanguageId`. **No regex-provider escape hatch**; COBOL T-M4-5 cannot reuse the registry without introducing one.
- 23-framework catalog at `frameworks-catalog.ts:437`, inline in `packages/ingestion`. Emits `{name, category, confidence: "deterministic"|"heuristic"|"composite", signals[], variant?, version?, parentName?}` — roadmap asks for numeric `confidence` + `evidence[]`. Plan must choose: **keep current discriminator** (string tag) + rename `signals` → `evidence` (cheaper), or go numeric (bigger change, arguable utility for 1 user).
- **5 detection stages coverage**: manifest ✅, lockfile ❌ (ignored today), config-AST ❌ (exact-match only, no parse), folder-convention partial, import/SCIP ❌.
- **No JVM subprocess prior art** — ProLeap v4 (T-M4-6) is greenfield. Grep empty for `java -jar`, `spawn.*java`, `jbang`. Needs new package + JRE probe.
- **ProLeap NOT on Maven Central** — `search.maven.org` returns `numFound: 0` for `io.github.uwol:proleap-cobol-parser`; latest GitHub Release is v2.4.0 (2018). M4-6 must `git clone + mvn install` into a vendored JAR OR ship a prebuilt JAR under `vendor/proleap/`.
- **tree-sitter-cobol published releases dead** (last tagged v0.1.1, 2023-02-01 per GitHub Releases API). Commit activity on default branch through 2025 but no tagged release. COBOL strategy stays as roadmap spec'd: regex hot path primary + ProLeap deep-parse gated.
- **`--allow-build-scripts`** is internal `RunIndexerOptions` boolean at `runners/index.ts:25` — never surfaced at CLI. T-M4-6 needs CLI flag + plumbing.

### Banned-string sensitivities

- `kuzu`, `ladybug`, `STEP_IN_PROCESS` are guardrail-banned in tracked source.
- Source-level naming: `GraphDbStore` / `graphdb-adapter.ts` / `graphdb-pool.ts` (not `LbugStore`).
- `@ladybugdb/core` in `package.json` — precedent: `@opencodehub/*` scoped packages with banned substrings are allowed when the scope identifier is the whole token. Verify by running `bash scripts/check-banned-strings.sh` after adding the dep; if it flags, add an allowlist exclusion for `package.json` + `pnpm-lock.yaml` (already excluded).

## Ubiquitous requirements

- **U1**: The v1.0 roadmap's graphHash byte-identity invariant MUST hold across both stores — `graph → DuckDbStore → rebuildGraphFromStore → graphHash` and `graph → GraphDbStore → rebuildGraphFromStore → graphHash` MUST be equal.
- **U2**: No tracked source file MUST introduce the banned literals `kuzu`, `ladybug`, `STEP_IN_PROCESS`, `heuristicLabel`, `codeprobe`, or `STEP_IN_FLOW`. `bash scripts/check-banned-strings.sh` MUST exit 0 post-commit.
- **U3**: `mise run check` MUST exit 0 after every commit.
- **U4**: Every new package MUST carry `@opencodehub/<name>` naming, Apache-2.0 license, `type: module`, `tsc --noEmit` clean.
- **U5**: No LLM calls in any M3/M4 path outside the existing `@opencodehub/summarizer` package.

## M3 — Event-driven requirements

- **E-M3-1**: When `CODEHUB_STORE=lbug` is set, `analyze`, `query`, `context`, `impact`, and `sql` CLI/MCP surfaces MUST route through `GraphDbStore` instead of `DuckDbStore`.
- **E-M3-2**: When the `sql` MCP tool receives a `cypher` input field, it MUST evaluate as read-only Cypher against `GraphDbStore`. Write operations (`CREATE`, `DELETE`, `SET`, `MERGE`) MUST be rejected by `cypher-guard.ts` (mirror of `sql-guard.ts`).
- **E-M3-3**: When both `sql` and `cypher` inputs are provided to the `sql` MCP tool, the tool MUST reject the call with a clear "choose one" message.

## M3 — State-driven requirements

- **S-M3-1**: While `CODEHUB_STORE` is unset or `=duck`, `DuckDbStore` remains the default; `GraphDbStore` is not loaded.
- **S-M3-2**: While `@ladybugdb/core` is absent (unreachable import — should not happen because it's a hard dep, but CI platforms without prebuilt binaries will surface this), `GraphDbStore.open()` MUST fail with a clear "`@ladybugdb/core` native binding unavailable on this platform; use `CODEHUB_STORE=duck`" message — not a bare module-not-found stack trace.
- **S-M3-3**: While a `GraphDbStore` database file exists from a prior `@ladybugdb/core` version (ABI mismatch), `open()` MUST emit a runbook hint pointing at the re-analyze path (`codehub analyze --force`), not silently truncate.

## M3 — Unwanted-behavior requirements

- **W-M3-1**: `GraphDbStore` MUST NOT call `conn.query()` concurrently against a single `Connection` — the pool adapter enforces one-query-per-connection at a time.
- **W-M3-2**: Cypher write operations (`CREATE`, `DELETE`, `SET`, `MERGE`, `REMOVE`) MUST NOT pass the `cypher-guard.ts` read-only check. The `sql` MCP tool stays read-only regardless of store backend.
- **W-M3-3**: The M3 phase-1 MUST NOT flip the default backend to `lbug`. That is T-M7-1.

## M3 — Acceptance criteria

### AC-M3-1: GraphDbStore scaffolding

- [ ] `packages/storage/src/graphdb-adapter.ts` — `GraphDbStore implements IGraphStore`, constructor takes path, lazy-imports `@ladybugdb/core`
- [ ] `packages/storage/src/graphdb-schema.ts` — DDL translator; per-kind `CREATE NODE TABLE` + one polymorphic rel table per edge kind
- [ ] `packages/storage/src/graphdb-pool.ts` — pool adapter (~600 LOC), internals audited for v0.16 API compatibility
- [ ] `packages/storage/src/index.ts` — export `GraphDbStore`; add `openStore(opts)` factory reading `CODEHUB_STORE`
- [ ] `packages/storage/package.json` — add `@ladybugdb/core: ^0.16.1` as hard dep (direct dependency, not optional peer — user-approved 2026-05-05)
- [ ] Banned-strings gate passes (no `kuzu`/`ladybug` in source)
- [P]
- **Dependencies**: none

### AC-M3-2: Pool adapter + concurrency tests

- [ ] `graphdb-pool.ts` integration test: 100 concurrent reads against one Database do not segfault or deadlock
- [ ] Checkout/checkin queue semantics: `MAX_CONNS_PER_REPO=8`, 15s waiter timeout, 30s query timeout, 60s idle sweep
- [ ] Timeout propagates into `IGraphStore.query()` `timeoutMs` correctly
- **Dependencies**: AC-M3-1

### AC-M3-3: Schema translation + round-trip

- [ ] All 23 edge kinds from `duckdb-adapter.ts:71-96` have corresponding rel tables in `graphdb-schema.ts`
- [ ] `PROCESS_STEP` (OCH-native, not the banned `STEP_IN_PROCESS`) maps to a rel table named `ProcessStep` (or similar — no banned literal)
- [ ] `bulkLoad(graph, "replace")` + `rebuildGraphFromStore(graphdbStore)` round-trip produces a graph with identical nodes, edges, and properties as the input
- **Dependencies**: AC-M3-1

### AC-M3-4: graphHash parity gate (CI)

- [ ] New file `packages/storage/src/graph-hash-parity.test.ts`
- [ ] Against 3 fixture graphs (small, medium, large) assert `duckHash === graphdbHash`
- [ ] Wired into `mise run check`
- [ ] Test runs in <30s so it stays in the hot validate path
- **Dependencies**: AC-M3-3

### AC-M3-5: sql MCP tool dual-emit (sql | cypher)

- [ ] `packages/mcp/src/tools/sql.ts` accepts optional `cypher` input field
- [ ] `packages/storage/src/cypher-guard.ts` mirrors `sql-guard.ts` — allows `MATCH`, `RETURN`, `WITH`, `WHERE`, `ORDER BY`, `LIMIT`, `SKIP`, `UNWIND`, `CALL READ_ONLY_PROCEDURES`; rejects writes
- [ ] When `CODEHUB_STORE=duck`, `cypher` input returns "cypher unavailable without `CODEHUB_STORE=lbug`"
- [ ] Timeout path shared between sql + cypher branches
- **Dependencies**: AC-M3-4

### AC-M3-6: ADR — LadybugDB swap rationale

- [ ] `docs/adr/NNNN-ladybugdb-graph-store.md` (numeric pick from existing ADR numbering)
- [ ] Documents the 3-phase plan (M3 opt-in → M7 default → DuckDB legacy-only), polymorphic rel-table-per-kind decision, pool adapter rationale, banned-literal renaming strategy, Apache AGE fallback
- [ ] Does NOT contain banned literals outside the banned-strings allowlist scope
- **Dependencies**: AC-M3-5

## M4 — Event-driven requirements

- **E-M4-1**: When `codehub analyze` runs on a repo containing `*.c`/`*.cpp`/`*.h`, it MUST invoke `scip-clang` if the binary is on `$PATH` or was installed via `codehub setup --scip=clang`.
- **E-M4-2**: When the user invokes `codehub setup --scip=<tool>`, the CLI MUST download the platform-specific binary, verify its sha256 against the pinned hash, and install into `~/.codehub/bin/` (or equivalent).
- **E-M4-3**: When `codehub analyze` encounters COBOL files (`.cbl`, `.cob`, `.cpy`), it MUST run the regex hot path (T-M4-5) unconditionally, and MUST run the ProLeap deep-parse (T-M4-6) only when `--allow-build-scripts=proleap` is passed.
- **E-M4-4**: When the 5-stage framework-detection pipeline emits a detection, the result MUST include `{name, version?, confidence, evidence[]}` where `confidence` is one of the discriminator strings (`"deterministic"|"heuristic"|"composite"`) AND `evidence[]` lists the stage(s) that produced the signal.

## M4 — State-driven requirements

- **S-M4-1**: While a SCIP adapter's binary is not installed, `codehub analyze` MUST skip that language cleanly (not crash) and emit a setup hint.
- **S-M4-2**: While `java --version` fails or reports < 17, `codehub analyze --allow-build-scripts=proleap` MUST refuse to run and emit a clear install hint for JRE 17+.
- **S-M4-3**: While the ProLeap JAR is not vendored under `vendor/proleap/proleap-cobol-parser-<version>.jar`, `codehub analyze --allow-build-scripts=proleap` MUST fail with the specific missing-jar path.

## M4 — Unwanted-behavior requirements

- **W-M4-1**: The COBOL ProLeap path MUST NOT run by default — only when the user explicitly passes `--allow-build-scripts=proleap`. This protects against unexpected JVM subprocess spawns.
- **W-M4-2**: The 5-stage framework-detection pipeline MUST NOT call out to network / LLM / any service. It's a pure-local file-system + AST inspection.
- **W-M4-3**: Scip adapters MUST NOT download binaries at analyze time. All downloads happen via `codehub setup`.
- **W-M4-4**: The framework-catalog MUST NOT double-trigger when both manifest and lockfile signals fire (the composite already handles this — do not regress).

## M4 — Acceptance criteria

### AC-M4-1: scip-clang adapter

- [ ] Add `"clang"` to `IndexerKind` union in `packages/scip-ingest/src/runners/index.ts`
- [ ] `buildCommand("clang", opts)` → `scip-clang index --output <path>` from project root with `compile_commands.json` preflight check
- [ ] `scip-clang` version pin: v0.4.0 (2026-02-23), binary URL pattern `github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-{linux|darwin}`
- [ ] Tests: mock-binary invocation, missing-binary skip path, `compile_commands.json` missing → specific error
- [P]
- **Dependencies**: AC-M4-0 (downloader — see below)

### AC-M4-2: scip-ruby adapter

- [ ] Add `"ruby"` to `IndexerKind` union
- [ ] `buildCommand("ruby")` → `scip-ruby --index-file <path> <args>` (verify invocation against scip-ruby v0.4.7 docs)
- [ ] Pin: v0.4.7 (2024-11-07), multi-arch: linux-x64, linux-arm64, darwin-x64, darwin-arm64
- [P]
- **Dependencies**: AC-M4-0

### AC-M4-3: scip-dotnet adapter

- [ ] Add `"dotnet"` to `IndexerKind` union
- [ ] `buildCommand("dotnet")` → `scip-dotnet index <path> -o <output>` with .NET SDK 8+ probe (exits with install hint if missing)
- [ ] Pin: v0.2.12; installed via `dotnet tool install --global scip-dotnet` OR vendored
- [P]
- **Dependencies**: AC-M4-0

### AC-M4-4: scip-kotlin adapter (promotion from tree-sitter only)

- [ ] Add `"kotlin"` to `IndexerKind` union
- [ ] `buildCommand("kotlin")` — confirm invocation pattern against scip-kotlin v0.6.0 docs (standalone, NOT bundled in scip-java)
- [ ] Tests differentiate Kotlin from Java in `detectLanguages()` (Kotlin must now produce its own SCIP, not ride on Java)
- [P]
- **Dependencies**: AC-M4-0

### AC-M4-0: codehub setup --scip=<tool> downloader

- [ ] New file `packages/cli/src/scip-downloader.ts` — mirror of `embedder-downloader.ts`
- [ ] Platform detection: linux-x64, linux-arm64, darwin-x64, darwin-arm64 (windows out of scope for v1)
- [ ] sha256-pinned downloads, atomic rename, idempotent re-run
- [ ] Subcommand: `codehub setup --scip=<tool>` or `codehub setup --scip=all`
- [ ] Tests: pinned-hash verification, pin-mismatch refusal, concurrent setup guard
- **Dependencies**: none (blocks AC-M4-1..4)

### AC-M4-5: COBOL regex hot path

- [ ] New file `packages/ingestion/src/parse/cobol-regex.ts`
- [ ] Extracts `copybook`, `CICS`, `PARAGRAPH`, `PERFORM` identifiers from `.cbl`, `.cob`, `.cpy` files; ≤1ms per file on 1000-line fixture
- [ ] Emits `CodeElement` nodes with confidence `"heuristic"`
- [ ] Wired into the parse pipeline as a new regex-provider escape hatch: extends `LanguageId` union to include `"cobol"` with a regex-provider discriminator
- [ ] Tests: NIST COBOL85 test fixtures from ProLeap's test corpus
- [P]
- **Dependencies**: none

### AC-M4-6: COBOL ProLeap deep-parse

- [ ] New package `packages/cobol-proleap/` — `@opencodehub/cobol-proleap`; `index.ts` + JVM subprocess wrapper
- [ ] Loads JAR from `~/.codehub/vendor/proleap/proleap-cobol-parser-<version>.jar` (not committed; fetched on-demand — user-approved 2026-05-05)
- [ ] `codehub setup --cobol-proleap` subcommand downloads + sha256-verifies + installs the prebuilt JAR (mirrors `scip-downloader.ts` shape)
- [ ] Builds small Java `main` wrapper (`cobol_to_scip.java` — maps ProLeap ASG to SCIP-compatible JSON) since ProLeap doesn't ship a CLI. The wrapper itself is committed under `packages/cobol-proleap/java/`; ProLeap JAR stays on-demand.
- [ ] Gated by `--allow-build-scripts=proleap` CLI flag (new surface); unset → regex hot path only
- [ ] Amortizes JVM startup by batching files per invocation
- [ ] Tests: synthetic COBOL file round-trip, JAR-missing failure, JRE-missing failure, graceful fallback to regex hot path on ProLeap crash
- [ ] `commitlint.config.mjs` — add `cobol-proleap` to scope-enum in the first commit
- **Dependencies**: AC-M4-5 (fallback path) + AC-M4-0 (downloader)

### AC-M4-7: @opencodehub/frameworks extraction + 5-stage pipeline

- [ ] New package `packages/frameworks/` — moves `framework-detector.ts`, `frameworks-catalog.ts`, `frameworks.ts`, `manifests.ts` out of `packages/ingestion/src/pipeline/profile-detectors/`
- [ ] Stage 2 (lockfile): parse `package-lock.json`, `pnpm-lock.yaml`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock` for exact versions
- [ ] Stage 3 (config-AST): add `next.config.{js,mjs,ts}`, `astro.config.mjs`, `vite.config.*` AST parse via existing tree-sitter or regex-pragmatic matchers (no new deps)
- [ ] Stage 5 (import/SCIP): consume the graph's `IMPORTS` edges — if any SCIP-resolved symbol targets a registered framework's root module (e.g., `fastapi`, `django.db`), emit a detection
- [ ] Re-export from `packages/ingestion` for backward compat
- [ ] `FrameworkDetection` shape: rename `signals` → `evidence`; keep discriminator `confidence`
- [ ] `commitlint.config.mjs` — add `frameworks` to scope-enum in the first commit
- [P]
- **Dependencies**: none

### AC-M4-8: Validate + PR

- [ ] `mise run check` exits 0 post-merge
- [ ] `graphHash` byte-identity test still passes (M3 parity + M4 additions)
- [ ] `bash scripts/check-banned-strings.sh` exits 0
- [ ] New tests bring totals to ~1,700+ (from current 1,449)
- [ ] PR `feat/v1-m3-m4 → main` opened with structured body listing each AC + commit ranges
- **Dependencies**: AC-M3-6, AC-M4-6, AC-M4-7 (terminal)

## Architectural decisions

1. **Rel-table-per-edge, not single `type` column.** Supersedes roadmap wording. Rationale: columnar predicate pushdown, no full-scan filter, matches LadybugDB idiom documented in `docs.ladybugdb.com/cypher/data-definition/create-table`.
2. **Store names do NOT use the `Lbug` or `Ladybug` prefix in source.** `GraphDbStore` / `graphdb-adapter.ts` / `graphdb-pool.ts` — passes the banned-strings guardrail cleanly. Package dep stays `@ladybugdb/core` (package-scope identifiers are precedent-allowed).
3. **`sql` MCP tool keeps its name; adds optional `cypher` input.** Not a new tool. No MCP tool-count bump yet (stays at 28 live + 5 deleted prompts = 28 tools surface). M7 will rename to `graph_query` and drop the sql branch.
4. **COBOL regex hot path first; ProLeap is gated deep-parse.** Roadmap sequenced correctly — regex provides the 80% coverage at ~1ms/file; ProLeap adds AST precision for users who opt in via `--allow-build-scripts=proleap` and accept the JVM subprocess cost.
5. **`@opencodehub/frameworks` extraction in-milestone.** Roadmap calls for it; AC-M4-7 does both the extraction and the stage-2/3/5 gap fill together — one change, one breaking import for `packages/ingestion`, easier to reason about than staging.
6. **scip-* downloader is AC-M4-0 (prerequisite).** Blocks M4-1..4. Ships as an independent commit.

## Anti-goals

- Do NOT change the MCP tool count rhetoric in `CLAUDE.md` or `README.md` — they say "28 tools" and stay at 28 through M3 (no new tools; `sql` gains an input field).
- Do NOT introduce banned literals in tracked source under any milestone.
- Do NOT flip the default `CODEHUB_STORE` backend in M3; that is M7.
- Do NOT vendor a ProLeap JAR over 20 MB without documenting size + license impact in the ADR.
- Do NOT bundle `@ladybugdb/core` as a required dep — it's optional to keep `pnpm install` flicker-free on platforms without the native binary.
- Do NOT call out to the network or spawn LLM calls in M4-7 framework detection — stage-5 uses the existing graph only.
- Do NOT batch M3 + M4 into a single atomic commit; they're independent and parallelizable. Ship per-AC commits.
- Do NOT skip the `scripts/check-banned-strings.sh` gate — every commit runs it via pre-commit hook.

## Commit protocol (roll-up across all M3 + M4 tasks)

- Smallest useful commits. Per-AC atomic commits preferred; multi-file ACs split per-file where possible.
- Each commit runs `bash scripts/check-banned-strings.sh` + `pnpm exec biome check --write <touched>` + `pnpm --filter <pkg> exec tsc --noEmit` + `pnpm --filter <pkg> test`.
- Every AC's terminal commit additionally runs `mise run check` before pushing.
- Use `isolation: "worktree"` for every parallel Act subagent (M2 lesson).
- Commit messages follow conventional-commits; scope enum already covers `storage`, `scip-ingest`, `ingestion`, `cli`, `mcp`, `repo`, `docs`, `deps`. New `frameworks` scope needs `commitlint.config.mjs` update at the start of AC-M4-7.

## Parallel wave structure (Plan derives tasks from this)

```
Wave 0 (independent prep, fully parallel):
  AC-M4-0 (scip downloader) — blocks M4-1..4
  AC-M4-5 (COBOL regex) — independent
  AC-M4-7 (frameworks extraction + stages) — independent
  AC-M3-1 (GraphDbStore scaffolding) — blocks M3-2..6

Wave 1 (parallel):
  AC-M3-2 (pool + concurrency)
  AC-M3-3 (schema + round-trip)
  AC-M4-1 scip-clang
  AC-M4-2 scip-ruby
  AC-M4-3 scip-dotnet
  AC-M4-4 scip-kotlin
  AC-M4-6 ProLeap (depends on AC-M4-5)

Wave 2 (terminal, sequential within track):
  AC-M3-4 (graphHash parity gate)
  AC-M3-5 (sql dual-emit)
  AC-M3-6 (ADR)
  AC-M4-8 (validate + PR)
```

Total: **13 ACs** across 2 waves. Expected commit count ~25-30 atomic commits on `feat/v1-m3-m4`.
