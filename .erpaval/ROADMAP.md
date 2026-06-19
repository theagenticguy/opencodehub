# OpenCodeHub v1.0 Roadmap

**Source**: `https://dw5vh8cb4iz6i.cloudfront.net/artifacts/och-roadmap/opencodehub-roadmap-2026-05-05.html` (CloudFront signed URL, expires 2026-05-05).
**Extracted**: 2026-05-05.
**Owner**: Laith Al-Saadoon (sole user — rip-and-replace latitude).

This is the durable roadmap reference. If it conflicts with in-conversation scope, this file wins. Durable by design — committed to survive context compaction.

## Product thesis

OpenCodeHub is a personal, local-first, self-hosted OSS code-intelligence hub exposing deterministic cross-repo symbol graphs and SARIF findings through stdio MCP and CLI only. Two-surface product per brainstorm 013:

- **Surface 1 — laptop artifact factory (P0)**: Claude Code plugin over stdio MCP. `codehub-document`, `codehub-pr-description`, `codehub-onboarding`, `codehub-contract-map`. Visible, immediate wedge.
- **Surface 2 — CI action surface (P1, deferred)**: OSS GH Actions + GitLab templates shelling `codehub` CLI. Structural, slower wedge. Waits on surface-1 adoption.

## Five hard rails (non-negotiable)

1. Self-hosted OSS only — no hosted / managed / SaaS / OCH-operated tier.
2. Stdio MCP only — no remote / HTTP MCP.
3. No agent SDK — no Python / TS / claude-hooks / framework adapters.
4. No LLM in query path — index-time summarizer is the sole exception (persisted, citation-validated, opt-in `--llm`).
5. No web UI / eval-server / IDE plugin / LSP / model fine-tuning.

## Milestone dependency graph

```
M1 → M2 → (M3 ∥ M4) → (M5 ∥ M6) → M7
```

Sequenced by dependency only. No calendar estimates.

## M1 — Stabilize (COMPLETE)

14 commits on `feat/v1-m1-m2`, landed via PR #53 squash-merge `4431b53`. PASS-WITH-CONCERNS.

| Task | Scope | Commits |
|------|-------|---------|
| T-M1-1 | Dirty-tree guard on analyze fast-path | `d3fa11b`, `b5e7068`, `fcdd9c9` |
| T-M1-2 | Real incremental via `loadPreviousGraph` snapshot; graphHash byte-identity preserved | `7b100fd`, `cca3c34`, `7ebe4eb` |
| T-M1-3 | `EmbeddingHashCacheAdapter` 3-tier content-hash skip; `--force` re-embeds | `3cfb0cf`, `cca3c34`, `8576f53` |
| T-M1-4 | SARIF symbol-level `FOUND_IN` edges via enclosing-symbol lookup | (in T-M1-2 block) |
| T-M1-5 | Delete 5 canned MCP prompts; skills replace | `73d1375`, `b95cc90`, `a6a210f` |

**Open concerns** (non-blocking):
- **C1**: `stringArrayField []→NULL` round-trip asymmetry at `analyze.ts:722-730` + `duckdb-adapter.ts:1353-1359` can drift `canonicalJson` hashes. Tracked, pre-M3 cleanup.

## M2 — Repo split + package surgery (COMPLETE)

14 commits on `feat/v1-m1-m2`, landed via PR #53.

| Task | Scope | Commits |
|------|-------|---------|
| T-M2-1 | Extract `packages/eval` + `packages/gym` + `bench/` → `opencodehub-testbed` repo | `53d9b88`, `f6f5f68`, `6d5bc2c` |
| T-M2-2 | Remove `codehub eval-server` HTTP surface | `60b2982`, `1a1ff05` |
| T-M2-3 | Remove `packages/docs` Starlight + `pages.yml`; retain `docs/adr/` | `690ca5e`, `d95df3c` |
| T-M2-4 | `@opencodehub/policy` v1 (3 rule types: `blast_radius_max`, `license_allowlist`, `ownership_required`); wire into `verdict` | `f25b196`, `9890e17`, `d8bfd15`, `4732396` |
| T-M2-5 | Extract `@opencodehub/wiki` workspace package; compat shim in analysis | `6fcc2f0`, `c538f2d`, `dd624ca` |

## M3 — LadybugDB phase-1 (PENDING, parallel with M4)

Replace recursive-CTE traversals with polymorphic rel-table-per-edge schema (**corrected 2026-05-05** — the v1 roadmap proposed a single rel-table with a `type` column; LadybugDB docs recommend one named rel table per edge kind with multiple `FROM/TO` pairs for columnar predicate pushdown). Current OCH edge-kind count is **23** (post-M2 additions `FOUND_IN`, `DEPENDS_ON`, `OWNED_BY`, `WRAPS`, `QUERIES`, `REFERENCES`, `ACCESSES`), not 21 as originally estimated.

LadybugDB = community successor to Kuzu (Apple acquisition). Pre-1.0 with ABI breaks every few months. **Current npm package: `@ladybugdb/core@0.16.1`** (released 2026-05-04, one day before roadmap review). Source-level naming uses `GraphDbStore` / `graphdb-adapter.ts` / `graphdb-pool.ts` to stay within `scripts/check-banned-strings.sh` limits — the `ladybug` and `kuzu` literals are rejected in tracked source files; the `@ladybugdb/core` dep in `package.json` is permitted under package-scope precedent.

| Task | Scope | Dependency | Test gate |
|------|-------|-----------|-----------|
| T-M3-1 | Implement `LbugStore` behind `IGraphStore` seam, gated by `CODEHUB_STORE=lbug` | M2 | graphHash parity suite |
| T-M3-2 | Pool-adapter (~600 LOC) — LadybugDB `.query()` segfaults on concurrent calls against one `Connection` | M3-1 | Concurrent query test |
| T-M3-3 | Single `CodeRelation` rel-table + per-kind DDL replaces ~60-column polymorphic nodes table | M3-2 | MATCH pattern tests |
| T-M3-4 | graphHash parity test suite — advance iff `DuckStore.graphHash === LbugStore.graphHash` on corpus | M3-3 | CI gate: byte-identical hash |
| T-M3-5 | Convert `sql` MCP tool output to `cypher` (dual-emit during phase 1, drop `sql` at M7) | M3-4 | MCP tool signature tests |
| T-M3-6 | ADR documenting swap rationale + 3-phase plan | M3-5 | Documentation reviewed |

**Fallbacks**: DuckDB remains legacy through M7. Apache AGE on Postgres 18 is survivability fallback if LadybugDB breaks beyond repair (documented, not implemented until M7).

## M4 — Language expansion (PENDING, parallel with M3)

| Task | Scope | Notes |
|------|-------|-------|
| T-M4-1 | `scip-clang` adapter | Needs `compile_commands.json`, 2 GB RAM/core guard |
| T-M4-2 | `scip-ruby` adapter | Sorbet install workflow |
| T-M4-3 | `scip-dotnet` adapter | — |
| T-M4-4 | Kotlin promotion (distinct from Java) | `scip-kotlin` v0.6.0 via `scip-java` |
| T-M4-5 | COBOL regex hot path | ~1 ms/file; `copybook`, `CICS`, `PARAGRAPH`, `PERFORM` extraction |
| T-M4-6 | COBOL ProLeap v4.0.0 backend | ANTLR4/JVM Java subprocess, `--allow-build-scripts` gated. tree-sitter-cobol (v0.1.1, 2023-02-01 — no newer tagged release) remains unreliable. **ProLeap is NOT published to Maven Central** (`search.maven.org` returns 0; last GitHub Release v2.4.0 from 2018); M4-6 must `git clone + mvn install` OR ship a prebuilt JAR under `vendor/proleap/`. ProLeap does not ship a CLI — need a small Java `main` wrapper. |
| T-M4-7 | Framework detection 5-stage pipeline | New `@opencodehub/frameworks` package. No OSS drop-in; custom curated-registry. |

**Framework detection stages** (each emits `{framework, version?, confidence, evidence[]}`):
1. Manifest presence (`package.json`, `pyproject.toml`, `pom.xml`, `Gemfile`, `go.mod`, `Cargo.toml`)
2. Lockfile + exact versions (semver-aware, curated registry)
3. Config AST (`astro.config.mjs`, `next.config.js`, `vite.config.ts`, `spring.factories`)
4. Folder convention (`app/`, `pages/`, `src/main/java/`, `config/routes.rb`)
5. Import / SCIP usage patterns (`import fastapi`, `from django.db`, `@SpringBootApplication`)

## M5 — Deterministic code-packs (PENDING, parallel with M6)

Depends on M4.

| Task | Scope |
|------|-------|
| T-M5-1 | `@opencodehub/pack` package with 9-item BOM contract |
| T-M5-2 | PageRank extraction from `scip-ingest/materialize.ts` dead code → `analysis/page-rank.ts` |
| T-M5-3 | `codehub code-pack` CLI subcommand + MCP tool |
| T-M5-4 | Byte-identity determinism test suite |
| T-M5-5 | `codehub-code-pack` SKILL.md |

**9-item code-pack BOM** (byte-identical given same commit, tokenizer, budget):
1. `manifest.json` — pack_hash, commit SHA, tokenizer ID, schema version, counts
2. PageRank-ranked symbol skeleton
3. File tree with framework labels
4. Dependency graph / lockfile slice (exact versions)
5. Top-N AST-chunked files with byte offsets
6. SCIP-grounded cross-refs (community clusters + call graph)
7. Optional embeddings sidecar (`.parquet`)
8. Salient docstrings / SARIF findings by severity + rule
9. LICENSES / NOTICES + README.md + full determinism contract

## M6 — Cross-repo federation (PENDING, parallel with M5)

Depends on M5.

| Task | Scope |
|------|-------|
| T-M6-1 | First-class `Repo` entity in graph |
| T-M6-2 | `group_list`, `group_status`, `group_contracts`, `group_query` MCP tools |
| T-M6-3 | `codehub-contract-map` skill (group-only, Mermaid consumer → producer) |
| T-M6-4 | Cross-repo link graph in `codehub-document --group` |
| T-M6-5 | `AMBIGUOUS_REPO` sentinel when ≥ 2 repos indexed without explicit `repo:` |

## M7 — LadybugDB default, DuckDB legacy (PENDING)

Depends on M3 + M6.

| Task | Scope |
|------|-------|
| T-M7-1 | Flip default backend to `CODEHUB_STORE=lbug` |
| T-M7-2 | Retain DuckDB only for temporal analytics |
| T-M7-3 | Drop dual-emit `sql|cypher` → `cypher`-only |
| T-M7-4 | Final graphHash parity audit across testbed corpus |
| T-M7-5 | Apache AGE / Postgres 18 escape hatch documented (not implemented) |

## Target package layout at end of roadmap

**Core (11 packages, ~400 files from ~970)**:
- `@opencodehub/cli` — `codehub` binary, 22+ subcommands (adds `verdict`, `code-pack`)
- `@opencodehub/mcp` — stdio MCP (29+ tools, 0 prompts)
- `@opencodehub/analysis` — request-time queries (PageRank, blast, impact)
- `@opencodehub/ingestion` — scan + materialize pipeline
- `@opencodehub/scip-ingest` — SCIP proto parsing
- `@opencodehub/storage` — `IGraphStore` + `DuckStore` + `LbugStore`
- `@opencodehub/embed` (née embedder) — transformers.js default + HTTP endpoint
- `@opencodehub/summarizer` — Bedrock Haiku 4.5, index-time only
- `@opencodehub/sarif` — SARIF 2.1.0 schemas + baseline diff
- `@opencodehub/scanners` — 20-scanner orchestrator
- `@opencodehub/core-types` — shared types

**New (4 packages)**:
- `@opencodehub/frameworks` — 5-stage framework detection
- `@opencodehub/pack` — deterministic code-pack generator
- `@opencodehub/policy` — `opencodehub.policy.yaml` + evaluator (M2 shipped)
- `@opencodehub/wiki` — deterministic wiki (M2 shipped)

## Language coverage targets at v1.0

| Language | Tree-sitter | SCIP | Frameworks | Status |
|----------|-------------|------|-----------|--------|
| TypeScript / JavaScript | ✅ | scip-typescript 0.4.0 | Next.js, Nest, Astro, Remix, Vite, Express | Active |
| Python | ✅ | scip-python | FastAPI, Django, Flask, LangChain, Pydantic | Active |
| Go | ✅ | scip-go 0.2.4 | stdlib, Gin, Echo | Active |
| Java | ✅ | scip-java 0.12.3 | Spring Boot, Micronaut, Gradle, Maven | Active |
| Scala | ✅ | scip-java 0.12.3 | Play, Akka | Active (via java) |
| Kotlin | ✅ | scip-kotlin 0.6.0 | Ktor, Android | M4 promotion |
| Ruby | ✅ | scip-ruby 0.4.7 | Rails, Sinatra | M4 |
| C / C++ | ✅ | scip-clang 0.4.0 | CMake, Conan | M4 |
| C# / .NET | ✅ | scip-dotnet | ASP.NET, EF Core | M4 |
| Rust | ✅ | Gap | cargo, Axum, Tokio | Tree-sitter only; SCIP blocked |
| Swift | ✅ | Gap | SwiftUI, Vapor | Tree-sitter only |
| COBOL | ❌ | None | CICS, IMS, JCL | Regex hot path + ProLeap v4 (gated) |

## Scanner pipeline (20 scanners at v1.0)

SARIF 2.1.0 ingestion + baseline diff + `codehub verdict` CI exit codes + `ci-init` workflow generation.

- **SAST**: Semgrep, CodeQL, Bandit (Py), Brakeman (Rb), GoSec, detect-secrets
- **SCA / license**: OSV-Scanner, internal `license_audit`, CycloneDX/SBOM
- **Type**: tsc, pyright, mypy, ruff-type
- **Lint**: Biome, ruff, golangci-lint, clippy
- **Fingerprinting**: `opencodehub/v1` via `{rule_id, symbol_id, hash(snippet)}` for stable baseline diff across formatters

## Validation constraints (every milestone must satisfy all 10)

| # | Constraint | Check |
|---|-----------|-------|
| 1 | Stdio MCP + CLI only; no HTTP surfaces | `rg -n 'express\|fastify\|http.createServer' packages/ → 0` |
| 2 | No LLM in query path | No `@aws-sdk/client-bedrock-runtime` outside `packages/summarizer/` |
| 3 | Narrative / LLM features ship as skills | `plugins/opencodehub/skills/*/SKILL.md` exists per narrative tool |
| 4 | Fixtures / evals / gyms in testbed repo | absent from core post-M2 |
| 5 | `mise run check` exit 0 | per commit |
| 6 | `graphHash` byte-identical full vs incremental | CI gate |
| 7 | Deterministic code-pack | same commit + tokenizer + budget → same bytes |
| 8 | No time estimates | sequenced by dependency graph only |
| 9 | SARIF 2.1.0 conformance | Zod passthrough + sarif-sdk spec tests |
| 10 | 20-scanner pipeline coverage | scanner registry enumerated |

## Explicitly rejected (no exceptions)

- Hosted / managed / SaaS tier
- Remote / HTTP MCP server
- Agent SDK (Python, TS, claude-hooks, framework adapters)
- `grounding_pack` MCP compositor
- OpenCodeHub-branded coding agent
- LLM-based PR review
- Hosted review UI (GitHub Checks + PR comments only)
- IDE plugin / LSP
- Model fine-tuning
- Single self-contained binary (pkg / SEA / Bun / Deno compile) — Docker image is the sole non-npm distribution artifact.

## Rip-and-replace latitude

1 active user. Roadmap explicitly sanctions rip-and-replace where it produces a better shape. No breaking-change budget to preserve beyond the graphHash byte-identity invariant and the MCP tool contract (tools may be renamed/replaced as long as the skill layer is updated in the same change).
