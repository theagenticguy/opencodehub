# EARS Spec 006 — OpenCodeHub v1.0 finalize (M7 + constraint-10 + debt sweep + dogfood polish)

**Session**: session-33f24f · **Branch**: `feat/v1-finalize` (cut from `main` after PR #70 is in) · **Parent roadmap**: `.erpaval/ROADMAP.md` §M7 + §Scanner pipeline (20) + §Validation constraints

**Decision:** bundle four v1.0 closeout tracks into one spec. Track A (M7) is the critical-path spine: `CODEHUB_STORE=lbug` becomes the default, `sql|cypher` dual-emit collapses to `cypher`-only, and the `IGraphStore` abstraction is hardened just enough that a third-party AGE/Memgraph/Neo4j/Neptune adapter can slot in without touching core packages. Track B adds the 20th scanner (`detect-secrets`) to satisfy ROADMAP constraint 10. Track C sweeps six outstanding debt items carried from prior milestones. Track D polishes the CI / git-hook / mise surface to match `claude-sql`'s reference shape and wire `codehub` onto itself (self-scan / self-verdict / self-pack). **Out of scope**: implementing an AGE/Memgraph/Neo4j/Neptune adapter (only the interface additions that would make one possible land here); a full 108-raw-SQL-site migration (Track A migrates only the critical MCP-tool path; wiki/ + pack/ + analysis/ migration deferred to a follow-on PR); the `.gitmodules` thiserror-pin fix (file was removed with `packages/gym`, debt item closed as stale).

## Context (Explore + Research consolidated)

Full detail in `.erpaval/sessions/session-33f24f/{intake,explore-storage,explore-debt,explore-ci,research-graphdb-backends,research-detectsecrets-scip}.yaml`.

### Track A — M7 LadybugDB default + IGraphStore hardening

- **Flip is ready**: `GraphDbStore` implements the full `IGraphStore` surface except `CochangeStore` + `SymbolSummaryStore` (`packages/storage/src/graphdb-adapter.ts:881-916` throws `NotImplementedError`). These two rows are the hard blockers for `CODEHUB_STORE=lbug` default.
- **Interface bias leaks**: `IGraphStore.query(sql, params)` (`packages/storage/src/interface.ts:46-51`) is SQL-biased in the parameter name; `GraphDbStore.query()` (`graphdb-adapter.ts:537-552`) re-interprets `sql:string` as Cypher. `VectorQuery.whereClause` (`interface.ts:294-312`) is a raw SQL predicate with `?` placeholders — another dialect leak.
- **41 concrete-class type pins** outside storage reference `DuckDbStore` directly (full list in `explore-storage.yaml§ambient_couplings.concrete_class_type_pins`); `packages/cli/src/commands/code-pack.ts:39,71,120,129,131,182` includes an `instanceof DuckDbStore` branch that controls ownership — breaks on LadybugDB.
- **108 raw-SQL call sites** go through `store.query()` from outside storage (46 in mcp, 17 in cli, 15 in wiki+pack, 27+ in analysis). Every one is silently DuckDB-only today — `GraphDbStore.query()` routes them to `assertReadOnlyCypher` which rejects `SELECT` as a write verb. Spec scope: migrate only the critical MCP-tool path (`query.ts`, `group-contracts.ts`, `dependencies.ts`, `list-findings.ts`). Wiki/pack/analysis migration is follow-on.
- **Duplicated column-encoders**: `NODE_COLUMNS`, `dedupeLastById`, `nodeToRow`/`nodeToParams`, the `*OrNull` encoder family, `languageStatsJsonOrNull` all live twice (once in each adapter). A third backend would triple-copy them. Hoist into `packages/storage/src/column-encode.ts` so a third adapter reuses one canonical set.
- **Paths leak**: `packages/storage/src/paths.ts:14` hard-codes `DB_FILE_NAME = 'graph.duckdb'`; `packages/cli/src/commands/list.ts:37,48` checks `existsSync('.codehub/graph.duckdb')` as the "is indexed" probe; `packages/mcp/src/tools/shared.ts:170` puts `.codehub/graph.duckdb` in a user-facing error. Needs to be backend-aware.
- **Doctor asymmetry**: `packages/cli/src/commands/doctor.ts:217-247` only probes `@duckdb/node-api`; no symmetric LadybugDB binding probe.
- **Parity-test rebuilders are inlined**: `rebuildFromDuckDb` (`graph-hash-parity.test.ts:377-416`) and `rebuildFromGraphDb` (`418-475`) are hand-written per backend; `assertParity` (`516-550`) hard-codes two branches. A third-party adapter currently requires editing the parity-test file. Hoist the rebuilders + the node-column map + `assertParity` into a reusable harness so a third adapter plugs in by importing.
- **`exportEmbeddingsParquet`** (`duckdb-adapter.ts:465-496`) is NOT on `IGraphStore` — `packages/pack/src/embeddings-sidecar.ts:77-113` duck-types it. On LadybugDB default, the sidecar silently becomes absent. Promote to an `IGraphStore.exportEmbeddingsToSidecar?(path)` optional method OR move sidecar emission into pack/ with a generic `listEmbeddings()` reader.
- **Research-confirmed union surface** for a plausible AGE/Memgraph/Neo4j/Neptune adapter includes `connectRemote(url, auth)` + tagged `BackendAuth` + `tx<T>()` + optional `bulkLoadFromS3` / `bulkLoadFromFile` + `engineCapabilities()` + `registerScalarCodec()`. None of these ship in this spec; ADR 0013 documents them as the escape-hatch surface.

### Track B — constraint-10 (detect-secrets as 20th scanner)

- Yelp detect-secrets v1.5.0, Apache-2.0, released 2024-05-06 — staleness noted in catalog comment.
- NOT SARIF-native — `detect-secrets scan <path>` emits JSON on stdout; converter is required (~120-180 LOC TS + ~80 LOC test fixtures).
- 25 detectors; **unique value over `betterleaks`** comes from `KeywordDetector` + `BasicAuthDetector` + baseline-audit workflow — classes of secrets regex-shape scanners structurally miss (`admin_password = "hunter2"`, `https://user:pass@host`).
- Wrapper slots into the existing `createXxxWrapper(deps)` contract (`packages/scanners/src/wrappers/osv-scanner.ts:1-32` is the canonical minimal example). Test convention is `makeFakeDeps` + `fakeSarif` (`wrappers.test.ts:21-72`).
- Catalog total-entry assertion at `packages/scanners/src/catalog.test.ts:43-45` rises from 19 → 20.

### Track C — debt sweep

- **C-1 parse-cache eviction**: `packages/ingestion/src/pipeline/phases/content-cache.ts:133` JSDoc says "older entries simply become unreachable and are cleaned up lazily by a future eviction pass." No eviction implementation exists today. `computeCacheSize()` (lines 196-232) is report-only. Zero eviction tests.
- **C-2 stringArrayField asymmetry**: `stringArrayOrNull` (`duckdb-adapter.ts:1557-1564`) turns `[] → null` on write; readers at `analyze.ts:731-739` + `duckdb-adapter.ts:1853-1860` drop null → absent. Author intent `{keywords: []}` does not survive round-trip. Affects `keywords` + `responseKeys` fields. Canonical decision: preserve `[]` vs absent as semantically distinct.
- **C-3 SageMaker embedder rebuild-on-switch**: NO `embedder_model_id` column persisted. `store_meta` schema (`schema-ddl.ts:172-183`) carries `schema_version, cache_hit_ratio, cache_size_bytes` only. A run that used ONNX `gte-modernbert-base` followed by a run that used SageMaker `gte-modernbert-base:<endpoint>` at same 768 dims silently corrupts hybrid-search ranking.
- **C-4 openDefaultEmbedder consolidation**: the 6-line `tryOpenHttpEmbedder → openOnnxEmbedder` block is duplicated verbatim at `packages/mcp/src/tools/query.ts:453-458` and `packages/cli/src/commands/query.ts:122-127`. The fuller ingestion variant at `packages/ingestion/src/pipeline/phases/embeddings.ts:514-537` adds offline flag + ONNX variant + pool + canary; it stays separate.
- **C-5 SCIP REFERENCES + TYPE_OF emission**: `DerivedRelation` (`derive.ts:31-35`) carries `IMPLEMENTS | TYPE_OF`; consumer at `scip-index.ts:245-252` currently ignores `derived.relations` entirely. `REFERENCES` + `IMPLEMENTS` + `EXTENDS` are already in `core-types/src/edges.ts` (positions 21, 6, 5). `TYPE_OF` is NEW — appended at END of union per the append-only comment at `edges.ts:29-32`. `SCIP_ROLE_REFERENCE` is just "DEFINITION bit unset" in the proto — not a separate constant. derive.ts today gates non-definition occurrences behind `isFunctionLike` filter at line 136 — widen that filter to also emit REFERENCES for non-call occurrences.
- **C-6 four missing READMEs**: `packages/cli/`, `packages/mcp/`, `packages/ingestion/`, `packages/scanners/`. Template per `packages/policy/README.md` (middle-ground: Surface / Rules table / Design). Not the richer `summarizer/README.md` shape (81 lines).
- **C-7 `.gitmodules` stale comment — CLOSE AS STALE**: `git show HEAD:.gitmodules` returns "fatal: path .gitmodules does not exist in HEAD" — gym was removed (commit 378f79f) and moved to `opencodehub-testbed`. Debt item is moot. Flagged in Open Question Q8.

### Track D — dogfood polish (CI / lefthook / mise / release-asset)

- **Missing workflows**: `.github/workflows/semgrep.yml` (not present), `.github/workflows/och-self-scan.yml` (not present), `.github/workflows/osv.yml` (not present — OSV currently lives as an embedded job at `ci.yml:94-117`).
- **Reference shape** is `/efs/lalsaado/workplace/claude-sql/.github/workflows/{semgrep,osv,sbom}.yml` — weekly cron, concurrency group, SARIF category, codeql-action/upload-sarif@v4.
- **Lefthook gaps** (`lefthook.yml` is 22 lines): no `min_version`, no `assert_lefthook_installed`, no `glob_matcher`, no `output` block, no `templates.pnpm`, no `fail_text`, no `priority`, no `skip: [merge, rebase]`, no pre-push diff-scoping (`files: "git diff --name-only @{push} HEAD || git diff --name-only HEAD~"`), no pnpm-lockfile-freshness gate.
- **Mise**: `mise.toml` has 20+ tasks but zero `och:self-*` tasks. `scripts/pack-determinism-audit.sh` exists but is NOT wired into `check`/`check:full`/`acceptance`.
- **Release-asset**: `release-please.yml` has no artifact attach; `sbom.yml:20-28` shows the exact working pattern (`actions/upload-artifact@v7` → `gh release upload "$TAG" FILE --clobber`) for reuse on a code-pack asset.
- **codehub self-hosting surface** is already there: `codehub analyze`, `codehub scan` (emits `.codehub/scan.sarif` at `scan.ts:62,101`), `codehub verdict` (`verdict.ts:42-65` has full CLI contract), `codehub code-pack` all exist. `codehub verdict --base origin/main --head HEAD --exit-code` is the pre-push gate shape.

### Convention & guardrail constraints (applies to all four tracks)

- **`commitlint.config.mjs`** scope-enum: no new package added in this spec, so no scope addition needed. `pack`, `storage`, `mcp`, `cli`, `scanners`, `ingestion`, `core-types`, `embedder` cover everything touched.
- **`scripts/check-banned-strings.sh`**: literals `STEP_IN_PROCESS, heuristicLabel, codeprobe, STEP_IN_FLOW, kuzu, ladybug, duckpgq`. **The `ladybug` banned literal is deliberate** — code must refer to the backend as `lbug` / `GraphDbStore` / `@ladybugdb/core`, never as a bare `ladybug` token. No new banned-string collisions for any of the four tracks (`detect-secrets`, `rawQuery`, `TYPE_OF`, `REFERENCES`, `cypher`, `self-scan` are all safe).
- **Worktree + biome collision** (MEMORY.md): sibling worktrees with their own `biome.json` roots cause root-config collisions on root-level `mise run check`. Act subagents on parallel worktrees remove sibling worktrees before `mise run check` OR scope to specific packages via `--filter`.
- **`mise run check`** = `lint` (biome) → `typecheck` (`pnpm -r exec tsc --noEmit`) → `test` → `banned-strings`. `check:full` adds `licenses` + `osv`. Track D wires `pack:determinism` into `check:full` deps.
- **`graphHash` byte-identity** (ROADMAP constraint 6) holds across every track iff: (a) `TYPE_OF` is appended at END of `RelationType` union per `edges.ts:29-32`; (b) `REFERENCES` emission is a content-side delta (expected, documented in the commit as a schema minor bump) not a schema-shape break; (c) the DuckDb ↔ LadybugDB parity test (`graph-hash-parity.test.ts`) stays green after every AC.
- **`@opencodehub/summarizer`** remains the only LLM-calling package (ROADMAP constraint 2). No new LLM calls in any of the four tracks.

## Ubiquitous requirements

- **U1**: `graphHash` byte-identity invariant MUST hold before and after every commit in every track — existing `graph-hash-parity.test.ts` stays green on DuckDb and on GraphDb legs for every fixture.
- **U2**: `pack_hash` byte-identity invariant — same `(commit, tokenizer, budget, chonkie_version, duckdb_version, grammar_commits)` → same `pack_hash`. Verified by the Track D-wired `scripts/pack-determinism-audit.sh` plus the existing `packages/pack/src/pack-determinism.test.ts`.
- **U3**: Stdio MCP + CLI only — no HTTP surface added. `rg -n 'express|fastify|http.createServer' packages/ → 0` stays true.
- **U4**: No LLM in the query path. No new `@aws-sdk/client-bedrock-runtime` import outside `packages/summarizer/`.
- **U5**: `IGraphStore` capability declaration invariant — every adapter that lands under `packages/storage/` MUST return a stable `engineCapabilities()` or equivalent record so callers do not duck-type features. Retained for the M7 escape-hatch ADR; enforced this spec only through `Store.dialect: "sql" | "cypher"`.
- **U6**: `mise run check` exit 0 after every commit. `bash scripts/check-banned-strings.sh` exit 0 after every commit.
- **U7**: Narrative / LLM / wiki / pack features ship as skills — no new CLI-embedded narrative behavior. No new skills are required by this spec (Track B's detect-secrets surfaces through the existing `/audit-deps` skill; no dedicated skill is needed).

## Track A — M7 LadybugDB default + IGraphStore hardening

### A — Event-driven requirements

- **E-A-1**: When a user runs any `codehub` subcommand without `CODEHUB_STORE` set, the opened store MUST be `GraphDbStore` (LadybugDB). `DuckDbStore` is selected only when `CODEHUB_STORE=duck` is set explicitly, when a legacy `.codehub/graph.duckdb` is present without a `.codehub/graph.lbug`, or when `codehub query --sql` is invoked (temporal analytics escape hatch).
- **E-A-2**: When an `IGraphStore` consumer calls `store.rawQuery(statement, params)`, the statement MUST be interpreted per `store.dialect: "sql" | "cypher"` declared at construction. Calling `rawQuery` against a backend whose dialect differs from the statement MUST throw a typed `StoreDialectMismatchError`, not silently fall through to the wire driver.
- **E-A-3**: When `codehub doctor` runs, it MUST probe every registered backend binding (`@duckdb/node-api` + `@ladybugdb/core`) and print a green/red row per backend, not only DuckDB.
- **E-A-4**: When a third-party adapter implements the parity harness (by importing the hoisted rebuilders + `assertParity`), the parity test MUST pass without editing `packages/storage/src/graph-hash-parity.test.ts`.
- **E-A-5**: When `codehub code-pack` runs against a LadybugDB-backed repo, the Parquet embeddings sidecar MUST NOT silently become absent — it either succeeds via a portable `listEmbeddings()` reader path, or it is explicitly documented as absent via the `determinism_class: degraded` manifest stamp.

### A — State-driven requirements

- **S-A-1**: While `@ladybugdb/core` is unavailable (missing native binding, unsupported OS), `codehub` MUST fall back to `DuckDbStore` and print a one-shot stderr warning naming the missing binding. The MCP server startup MUST NOT abort.
- **S-A-2**: While a repo has BOTH `.codehub/graph.duckdb` AND `.codehub/graph.lbug` present, `codehub` MUST prefer the newer-mtime artifact and print a one-shot stderr warning recommending `codehub analyze --force` to rebuild on the chosen backend.
- **S-A-3**: While a caller passes `--engine duckdb` or `CODEHUB_STORE=duck`, the SQL dialect MUST remain available and `codehub query --sql` MUST work end-to-end (temporal analytics escape hatch per ROADMAP T-M7-2).

### A — Unwanted-behavior requirements

- **W-A-1**: `IGraphStore` MUST NOT expose a parameter named `sql` on its raw-query method — rename to `rawQuery(statement, params)` with `Store.dialect` as the mode marker. Compat shim for the old `query(sql, params)` name stays available for exactly one milestone (through M7 merge), then is removed.
- **W-A-2**: Adding `TYPE_OF` to `RelationType` MUST NOT insert mid-union — it is appended at END per the `edges.ts:29-32` append-only rule. The `graph-hash-parity.test.ts` medium+large fixtures remain byte-identical.
- **W-A-3**: `cli/src/commands/code-pack.ts` MUST NOT contain an `instanceof DuckDbStore` branch — ownership control flows through `IGraphStore.open()/close()` on both backends.
- **W-A-4**: The M7 commit bundle MUST NOT introduce an AGE / Memgraph / Neo4j / Neptune adapter in core — these are documented in ADR 0013 as the escape-hatch shape only, not shipped.

### A — Acceptance criteria

#### AC-A-1: rename `IGraphStore.query` → `rawQuery` + add `Store.dialect` marker

- [ ] `packages/storage/src/interface.ts:46-51` — rename `query(sql, params)` → `rawQuery(statement, params)`; add `readonly dialect: "sql" | "cypher"` to `IGraphStore`
- [ ] `packages/storage/src/duckdb-adapter.ts` — implement `rawQuery` + `dialect = "sql"`; alias `query()` → `rawQuery()` with a one-milestone deprecation notice (JSDoc + runtime no-op)
- [ ] `packages/storage/src/graphdb-adapter.ts` — implement `rawQuery` + `dialect = "cypher"`; same alias shim
- [ ] `packages/storage/src/interface.ts` — add `StoreDialectMismatchError` export
- [ ] `packages/storage/src/interface.test.ts` — assert `dialect` presence on both adapters; assert mismatch throw
- [ ] All internal call sites in `packages/storage/**`, `packages/mcp/**`, `packages/cli/**`, `packages/analysis/**`, `packages/pack/**`, `packages/wiki/**` — migrate to `rawQuery` (mechanical rename)
- **Dependencies**: none — **MUST land first in Track A**
- [P]

#### AC-A-2: hoist duplicated column-encoders into `storage/src/column-encode.ts`

- [ ] `packages/storage/src/column-encode.ts` — new file, exports `NODE_COLUMNS`, `nodeToRow`, `nodeToParams`, `dedupeLastById`, `coveredLinesOrNull`, `jsonArrayOrNull`, `jsonObjectOrNull`, `stringOrNull`, `numberOrNull`, `booleanOrNull`, `stringArrayOrNull` (PRESERVING round-trip per AC-C-2), `repoStringOrNull`, `languageStatsJsonOrNull`, `normalizeDeadness`
- [ ] `packages/storage/src/duckdb-adapter.ts` — drop local definitions (lines 72-97, 1367-1475 et al), import from `./column-encode.js`
- [ ] `packages/storage/src/graphdb-adapter.ts` — drop local definitions (lines 103-178, 1029-1111 et al), import from `./column-encode.js`
- [ ] Parity test stays green on small + medium + large + repo + repo-null fixtures
- **Dependencies**: AC-A-1
- [P]

#### AC-A-3: fill `CochangeStore` + `SymbolSummaryStore` on `GraphDbStore`

- [ ] `packages/storage/src/graphdb-adapter.ts:881-916` — replace `NotImplementedError` on `bulkLoadCochanges`, `lookupCochangesForFile`, `lookupCochangesBetween`, `bulkLoadSymbolSummaries`, `lookupSymbolSummary`, `lookupSymbolSummariesByNode` with real implementations against Cochange / SymbolSummary NODE TABLEs already defined in `packages/storage/src/graphdb-schema.ts:204-227`
- [ ] Canonicalize `stats_json` via `canonicalJson(meta.stats)` (matching `duckdb-adapter.ts:1177`, NOT `JSON.stringify` as today at `graphdb-adapter.ts:843`) — removes latent key-order divergence
- [ ] `packages/storage/src/graphdb-adapter.test.ts` — round-trip tests for all 6 methods, same fixture shapes as DuckDb's tests
- [ ] `packages/storage/src/graph-hash-parity.test.ts` — extend fixture coverage to include a cochange row + a symbol-summary row; parity holds
- **Dependencies**: AC-A-1, AC-A-2
- [P]

#### AC-A-4: promote `exportEmbeddingsParquet` to portable interface method

- [ ] `packages/storage/src/interface.ts` — add optional `exportEmbeddingsToSidecar?(outPath: string): Promise<void>`
- [ ] `packages/storage/src/duckdb-adapter.ts:465-496` — rename `exportEmbeddingsParquet` to `exportEmbeddingsToSidecar`
- [ ] `packages/storage/src/graphdb-adapter.ts` — implement `exportEmbeddingsToSidecar` by streaming `listEmbeddings()` rows into DuckDB-free Parquet writer (`@dsnp/parquetjs` fallback already in OCH per prior research OR implement as deterministic JSON lines and convert via a one-shot helper) — alternative acceptable: return `undefined` and let pack/ stamp `determinism_class: degraded`
- [ ] `packages/pack/src/embeddings-sidecar.ts:77-113` — replace duck-typed probe with `store.exportEmbeddingsToSidecar?.(outPath)` interface call
- [ ] Test: sidecar round-trips byte-identically on DuckDb path; graceful absent+degraded on LadybugDB when `exportEmbeddingsToSidecar` returns undefined
- **Dependencies**: AC-A-1
- [P]

#### AC-A-5: replace `DuckDbStore` parameter types with `IGraphStore` (41 files)

- [ ] `packages/mcp/src/tools/shared.ts:15,141,162` — `executeToolWithStore` factory types store as `IGraphStore`
- [ ] `packages/mcp/src/connection-pool.ts:22,26,43,45,48,91` — pool accepts `IGraphStore`-compatible construction (falls through to `openStore({path, backend})` factory)
- [ ] `packages/mcp/src/repo-uri-for-entry.ts:20,30,32` — migrate; SELECT becomes `listNodes({kind:"Repo", id})` via new typed finder (see AC-A-6)
- [ ] `packages/mcp/src/tools/{query,shape-check,api-impact,group-contracts,route-map,pack-codebase}.ts` — migrate 6 files
- [ ] `packages/mcp/src/resources/{repo-cluster,repo-process,store-helper}.ts` — migrate 3 files
- [ ] `packages/cli/src/commands/{open-store,analyze,augment,scan,ingest-sarif,group,query,code-pack}.ts` — migrate 8 files; delete `instanceof DuckDbStore` branch in `code-pack.ts`
- [ ] `packages/cli/src/commands/list.ts:37,48` — replace `existsSync('.codehub/graph.duckdb')` with backend-aware `codehubIsIndexed(repoPath)` helper that checks both `.codehub/graph.duckdb` + `.codehub/graph.lbug` + meta.json
- [ ] Per-file test files updated
- [ ] `packages/cli/src/commands/doctor.ts:217-247` — add symmetric `@ladybugdb/core` probe branch + a generic `openStore+healthCheck` check
- **Dependencies**: AC-A-1, AC-A-2, AC-A-3, AC-A-4
- [P]

#### AC-A-6: typed finder methods for critical MCP-tool path (partial 108-SQL migration)

- [ ] `packages/storage/src/interface.ts` — add `listNodesByKind(kind, opts?)`, `listEdgesByType(type, opts?)`, `listDependencies(opts?)`, `listFindings(opts?)` — the minimum set that unblocks the four MCP tools below
- [ ] Both adapters implement the four methods
- [ ] Migrate MCP tool critical path (drops 4 of the 46 mcp/ raw-SQL sites):
  - `packages/mcp/src/tools/query.ts` — migrate the 4 raw-SQL sites at L46,206,236,261 (WITH RECURSIVE walks stay as rawQuery for now; migrate only the trivial SELECTs)
  - `packages/mcp/src/tools/group-contracts.ts:24,85,104` — migrate
  - `packages/mcp/src/tools/dependencies.ts:94` — migrate
  - `packages/mcp/src/tools/list-findings.ts:103` — migrate
- [ ] Test: each MCP tool runs end-to-end on BOTH DuckDb and LadybugDB backends
- [ ] **Deferred to follow-on PR** (explicit non-scope): the remaining 104 raw-SQL sites in wiki/, pack/, analysis/, remove-dead-code, route-map; noted in Open Question Q2.
- **Dependencies**: AC-A-1, AC-A-5
- [P]

#### AC-A-7: hoist parity-test rebuilders into reusable harness

- [ ] `packages/storage/src/test-utils/parity-harness.ts` — new file, exports `rebuildFromDuckDb`, `rebuildFromGraphDb`, `assertParity(fixture, {stores})`, `NODE_COLUMN_MAP`, `applyNodeColumns`, `applyRepoNullables`, the step-zero sentinel convention, the `languageStats={}` coercion, `hasGraphDbBinding()`
- [ ] `packages/storage/src/graph-hash-parity.test.ts` — shrink to just the fixtures + `assertParity` calls; rebuild helpers imported
- [ ] Contract: `assertParity(fixture, {stores: [duckStore, graphDbStore, ...otherStores]})` supports N-way transitive check
- [ ] Add a doc-comment pointing third-party adapter authors at the harness import path
- **Dependencies**: AC-A-2, AC-A-3
- [P]

#### AC-A-8: generalize `paths.ts` and schema-name leaks

- [ ] `packages/storage/src/paths.ts:14` — replace `DB_FILE_NAME = 'graph.duckdb'` with a backend-aware resolver `describeArtifacts(backend): { dbFileName, schemaName }`; default backend `"lbug"` returns `"graph.lbug"`
- [ ] `packages/cli/src/commands/list.ts:37,48` — use the helper
- [ ] `packages/mcp/src/tools/shared.ts:170` — user-facing error message lists both candidate paths
- [ ] `packages/cli/src/skills-gen.ts:25` — update docstring reference to `IGraphStore`
- **Dependencies**: AC-A-5
- [P]

#### AC-A-9: flip `CODEHUB_STORE=lbug` default

- [ ] `packages/cli/src/commands/open-store.ts:8,18,23` — default `backend: "lbug"` when `CODEHUB_STORE` is unset AND `@ladybugdb/core` is importable; fall back to `"duck"` otherwise with stderr warning (S-A-1)
- [ ] Dual-artifact detection (S-A-2): if both `graph.duckdb` + `graph.lbug` present, prefer newer-mtime, warn
- [ ] `docs/adr/0013-m7-default-flip-and-abstraction.md` — new ADR documenting T-M7-1 + T-M7-3 + the Apache AGE / Memgraph / Neo4j / Neptune escape-hatch interface additions (T-M7-5 lives INSIDE this ADR, not a separate doc)
- [ ] `README.md` and `AGENTS.md` — one-paragraph update naming the new default, the opt-out env var, and the temporal-analytics escape hatch
- [ ] Every existing test suite passes on the new default (enforced by running `mise run check` with `CODEHUB_STORE=lbug`)
- **Dependencies**: AC-A-3, AC-A-5, AC-A-6, AC-A-8
- **Not [P]** — this is the flip; must land after all hardening

#### AC-A-10: final graphHash parity audit on testbed corpus (T-M7-4)

- [ ] `scripts/m7-parity-audit.sh` — new shell script: runs `codehub analyze` on the testbed corpus under both backends, extracts `graphHash` from `store_meta`, asserts byte-identity
- [ ] Wire into `scripts/acceptance.sh`
- [ ] Capture parity output into `docs/adr/0013-m7-default-flip-and-abstraction.md` as the "empirical evidence" footnote
- **Dependencies**: AC-A-9
- **Not [P]**

## Track B — constraint-10 (detect-secrets)

### B — Event-driven requirements

- **E-B-1**: When `codehub scan` runs with default scanners on a Python/TypeScript/Go/Java/Kotlin monorepo, the run MUST include `detect-secrets` output merged into the final `.codehub/scan.sarif`, indistinguishable from the 19 existing scanners in consumption.
- **E-B-2**: When `detect-secrets` is not on PATH, the wrapper MUST emit an empty SARIF with `skipped: ["not found on PATH"]` and the merged SARIF MUST preserve the `tool.driver.name: "detect-secrets"` (per `emptySarifFor(spec)` convention at `packages/scanners/src/spec.ts:86-101`).

### B — Unwanted-behavior requirements

- **W-B-1**: The `detect-secrets` SARIF converter MUST NOT advertise `hashed_secret` (SHA-1) as a cryptographic fingerprint — use a `partialFingerprints` field labeled `detect_secrets_sha1` per the research recommendation.
- **W-B-2**: The wrapper MUST NOT drop overlapping findings — if `KeywordDetector` + `AWSKeyDetector` both fire on the same line, both pass through and rely on OCH's downstream SARIF dedupe.

### B — Acceptance criteria

#### AC-B-1: add `DETECT_SECRETS_SPEC` to catalog

- [ ] `packages/scanners/src/catalog.ts` — append `DETECT_SECRETS_SPEC` between `BANDIT_SPEC` and `BIOME_SPEC`; priority P1, languages `all`, `sarifNative: false`, `install: "pipx install detect-secrets==1.5.0"`, staleness comment noting v1.5.0 released 2024-05-06
- [ ] `packages/scanners/src/catalog.test.ts:43-45` — total-entry assertion rises from 19 to 20
- [ ] `packages/scanners/src/catalog.test.ts:12-27` — P1_SPECS stable-order assertion updated (P1 count rises from 11 to 12)
- **Dependencies**: none
- [P]

#### AC-B-2: `detect-secrets` wrapper + JSON→SARIF converter

- [ ] `packages/scanners/src/wrappers/detect-secrets.ts` — new file; follows the `createXxxWrapper(deps)` contract (osv-scanner.ts:1-32 is the model); invoke args `["scan", ".", "--all-files"]`; parse stdout JSON → pass through converter → return SARIF
- [ ] `packages/scanners/src/converters/detect-secrets.ts` — new file; ~120-180 LOC; maps `{results: {"<path>": [{type, line_number, hashed_secret, is_verified, ...}]}}` → SARIF 2.1.0; `type → ruleId` lookup table for all 25 detectors; line_number → region.startLine (1-indexed); hashed_secret + is_verified → `partialFingerprints.detect_secrets_sha1` + `properties.is_verified`
- [ ] `packages/scanners/src/converters/detect-secrets.test.ts` — synthesize detect-secrets JSON fixture, assert SARIF output shape
- [ ] `packages/scanners/src/wrappers/wrappers.test.ts` — add test block per convention (`makeFakeDeps`, `fakeSarif` pattern): happy path, missing-binary, malformed stdout, overlapping-finding pass-through
- **Dependencies**: AC-B-1
- [P]

## Track C — debt sweep

### C — Event-driven requirements

- **E-C-1**: When the parse cache on disk exceeds `CODEHUB_PARSE_CACHE_MAX_BYTES` (default `1073741824` = 1 GiB) at write time, the next write MUST trigger LRU eviction (mtime-ordered) of oldest entries until the cache is at most 90% of the cap.
- **E-C-2**: When a round-trip reads a node whose `keywords` was authored as `[]`, the reader MUST return `{keywords: []}`, not `{keywords: undefined}`. Same for `responseKeys`.
- **E-C-3**: When `codehub query` runs against a `store_meta.embedder_model_id` different from the current embedder's `modelId`, the command MUST refuse with exit code 2 and print a remediation hint `Re-run 'codehub analyze --force' or pass --force-backend-mismatch to query with potentially stale vectors`.
- **E-C-4**: When SCIP ingest completes, `derived.relations` MUST be emitted — `IMPLEMENTS` reuses its existing edge kind at `edges.ts:9`, `TYPE_OF` uses the newly appended kind. Non-call `SCIP_ROLE_REFERENCE` occurrences (detected as "Definition bit unset AND symbol has a DEFINITION elsewhere") emit `REFERENCES` edges using the existing kind at `edges.ts:24`.

### C — Acceptance criteria

#### AC-C-1: parse-cache LRU eviction

- [ ] `packages/ingestion/src/pipeline/phases/content-cache.ts` — add `evictIfOverCap(cacheDir, capBytes)` that lists all shards, stats each file, sorts mtime-ascending, deletes oldest until total ≤ 0.9 × cap; integrate into `writeCacheEntry` so it runs after every new write that would exceed cap (short-circuit if under cap)
- [ ] Env var `CODEHUB_PARSE_CACHE_MAX_BYTES` default 1 GiB; 0 disables (keeps current unbounded behavior for CI ephemeral runners); parsed via `parseHumanSizeBytes("1GiB")`-style helper
- [ ] `packages/ingestion/src/pipeline/phases/content-cache.test.ts` — new test block: write 12 entries @ 100 KB each under 1 MiB cap → assert youngest 9 present, oldest 3 evicted; delete one manually → next write re-evicts only if over cap
- [ ] JSDoc at content-cache.ts:133 — replace the "future eviction pass" punt with a pointer to the new helper
- **Dependencies**: none
- [P]

#### AC-C-2: stringArrayField round-trip symmetry

- [ ] `packages/storage/src/column-encode.ts` (post-AC-A-2) — `stringArrayOrNull` preserves `[]` distinct from `undefined`: `[] → "[]"` written as canonical-JSON string in a sentinel TEXT[] encoding, OR rely on a side-column sentinel `<field>_empty: BOOLEAN` — whichever keeps DuckDB FTS/HNSW behavior intact
- [ ] Symmetric reader drop at `duckdb-adapter.ts:1853-1860` and `analyze.ts:731-739` — preserves `[]` vs absent
- [ ] `packages/storage/src/graphdb-adapter.ts` reader mirror — same semantics
- [ ] `packages/storage/src/graph-hash-parity.test.ts` — add a fixture variant with `{keywords: []}` on a Query node; assert round-trip holds cross-adapter
- [ ] `packages/core-types/src/graph-hash.ts` — verify `canonicalJson` treats empty array as distinct from absent key (should already — document)
- **Dependencies**: AC-A-2
- [P]

#### AC-C-3: SageMaker rebuild-on-switch refusal

- [ ] `packages/storage/src/schema-ddl.ts:172-183` — add `embedder_model_id TEXT` column to `store_meta` (nullable for migration)
- [ ] `packages/storage/src/graphdb-schema.ts` — mirror on `StoreMeta` NODE TABLE
- [ ] Migration: on store open, if the column is null, backfill from the currently-active embedder's `modelId` AND print a one-shot stderr warning `embedder_model_id backfilled from current embedder; re-run 'codehub analyze --force' if the active embedder differs from the one that produced the existing vectors`
- [ ] `packages/cli/src/commands/query.ts` + `packages/mcp/src/tools/query.ts` — read `store_meta.embedder_model_id`, compare to current embedder's `modelId`; refuse with exit 2 + hint (E-C-3) unless `--force-backend-mismatch` is passed
- [ ] `packages/cli/src/commands/query.ts` — add `--force-backend-mismatch` flag plumbing
- [ ] `docs/adr/0014-scip-references-and-embedder-fingerprint.md` — new ADR documenting both C-3 + C-5 (single ADR per Q7)
- **Dependencies**: AC-A-2
- [P]

#### AC-C-4: `openDefaultEmbedder` factory consolidation

- [ ] `packages/embedder/src/factory.ts` — new file, exports `openDefaultEmbedder(opts?: { allowOnnxFallback?: boolean }): Promise<Embedder>`; body = the 6-line `tryOpenHttpEmbedder → openOnnxEmbedder` block
- [ ] `packages/embedder/src/index.ts` — re-export `openDefaultEmbedder`
- [ ] `packages/mcp/src/tools/query.ts:453-458` — replace local `defaultOpenEmbedder` with imported `openDefaultEmbedder`
- [ ] `packages/cli/src/commands/query.ts:122-127` — same replacement
- [ ] `packages/ingestion/src/pipeline/phases/embeddings.ts:514-537` — NOT consolidated (fuller variant kept separate); add a one-line comment pointing at `openDefaultEmbedder` and explaining why ingestion intentionally diverges (offline flag + ONNX variant/pool/canary)
- [ ] `packages/embedder/src/factory.test.ts` — unit test covering HTTP-priority + ONNX fallback + no-embedder-setup EmbedderNotSetupError branches
- **Dependencies**: none
- [P]

#### AC-C-5: SCIP REFERENCES + TYPE_OF emission

- [ ] `packages/core-types/src/edges.ts` — append `TYPE_OF` at END of `RelationType` union (position 25) + end of `RELATION_TYPES` runtime list per lines 29-32 append-only comment
- [ ] `packages/scip-ingest/src/derive.ts:136` — widen `isFunctionLike` filter to also emit `REFERENCES` for non-call occurrences whose symbol has a DEFINITION elsewhere in the same SCIP document (guard: skip IMPORT-only occurrences)
- [ ] `packages/scip-ingest/src/derive.ts:184-199` — `collectRels` already maps `is_implementation → IMPLEMENTS` and `is_type_definition → TYPE_OF`; verify both branches populated; add test fixture coverage
- [ ] `packages/ingestion/src/pipeline/phases/scip-index.ts:245-252` — after the existing `emitEdges` call, add a sibling `emitRelations(ctx, nodesByFile, derived.relations, symbolDef, reason, existingEdgeKeys)` call converting `IMPLEMENTS`/`TYPE_OF` into graph edges
- [ ] `packages/ingestion/src/pipeline/incremental-determinism.test.ts` — regenerate fixtures (one-time content delta, expected per the append-only convention); commit the regenerated fixture alongside the code change
- [ ] `packages/storage/src/graph-hash-parity.test.ts` — medium fixture gains an IMPLEMENTS + TYPE_OF + REFERENCES edge; parity holds
- [ ] `docs/adr/0014-scip-references-and-embedder-fingerprint.md` — documents the edge-kind addition + graphHash minor-bump justification (shared ADR with AC-C-3)
- **Dependencies**: none (but sequences with Track A — see cross-track section)
- [P]

#### AC-C-6: four missing READMEs

- [ ] `packages/cli/README.md` — middle-ground template (Surface / Commands table / Design), ~40-60 lines
- [ ] `packages/mcp/README.md` — Surface / Tools table / Design, ~40-60 lines
- [ ] `packages/ingestion/README.md` — Surface / Phases table / Design, ~40-60 lines
- [ ] `packages/scanners/README.md` — Surface / Scanners table / Design, ~40-60 lines; reflects 20-scanner count post-AC-B-1
- [ ] Cross-link each from root `README.md` package-map section if one exists
- **Dependencies**: AC-B-1 (scanners README cites 20)
- [P]

#### AC-C-7: close `.gitmodules` debt as stale

- [ ] `.erpaval/debt.md:291-295` — update the `.gitmodules` line-19 entry to status `CLOSED-STALE`, rationale: "file removed with packages/gym in commit 378f79f; submodule set moved to opencodehub-testbed"
- [ ] No code change
- **Dependencies**: none
- [P]

## Track D — dogfood polish

### D — Event-driven requirements

- **D1-E-1**: When a PR is opened or a commit lands on main, `.github/workflows/semgrep.yml` MUST run `p/auto` + `p/owasp-top-ten` and upload SARIF with `category: semgrep` via `codeql-action/upload-sarif@v4`.
- **D1-E-2**: When `osv.yml` exists as a standalone workflow, the embedded OSV job at `ci.yml:94-117` MUST be removed in the same commit.
- **D1-E-3**: When `release-please` publishes a release, the workflow MUST generate a deterministic `codehub code-pack` artifact and attach it to the GitHub release via `gh release upload "$TAG" <pack>.tar.gz --clobber`.
- **D1-E-4**: When a user runs `git push` on a branch with staged changes, `lefthook` pre-push MUST run `codehub verdict --base origin/main --head HEAD --exit-code` — a policy-block verdict aborts the push.
- **D1-E-5**: When a user runs `mise run check:full`, `pack:determinism` MUST run as a dependency.

### D — Acceptance criteria

#### AC-D-1: `.github/workflows/semgrep.yml`

- [ ] `.github/workflows/semgrep.yml` — new file mirroring `/efs/lalsaado/workplace/claude-sql/.github/workflows/semgrep.yml` shape: triggers `push [main] + pull_request [main] + schedule "20 17 * * 1"`; concurrency group; `permissions: {contents: read, security-events: write}`; container `semgrep/semgrep`; configs `p/auto` + `p/owasp-top-ten`; SARIF upload via `codeql-action/upload-sarif@v4` with `category: semgrep`, `if: always()`
- **Dependencies**: none
- [P]

#### AC-D-2: `.github/workflows/osv.yml` split

- [ ] `.github/workflows/osv.yml` — new file mirroring `claude-sql/.github/workflows/osv.yml`; triggers `push [main] + pull_request [main] + schedule "33 5 * * 2"`; concurrency group; OSV install via `curl -sL google/osv-scanner v2.3.5` → `/tmp/osv-scanner`; `lockfile: pnpm-lock.yaml`; dual-run pattern (SARIF write `|| true`, then exit-code gate run); SARIF upload with `category: osv-scanner`
- [ ] `.github/workflows/ci.yml` — **same commit**: delete the embedded OSV job at lines 94-117; remove `security-events: write` from the job-level permissions that only existed for it
- **Dependencies**: none
- [P]

#### AC-D-3: `.github/workflows/och-self-scan.yml`

- [ ] `.github/workflows/och-self-scan.yml` — new file mirroring `packages/cli/src/commands/ci-templates/github-weekly.yml` shape; runs `codehub analyze` → `codehub scan` → upload `.codehub/scan.sarif` via `codeql-action/upload-sarif@v4` with `category: opencodehub-self`; triggers `push [main] + pull_request [main] + schedule "47 6 * * 3"`; uses local workspace via `pnpm link` (not `npm install -g @opencodehub/cli@latest` since this is dogfood)
- [ ] Optional jq-based license-tier gate mirroring `github-weekly.yml:29-33`
- **Dependencies**: none
- [P]

#### AC-D-4: code-pack release-asset

- [ ] `.github/workflows/release-please.yml` — extend existing workflow OR new `code-pack-release.yml`; triggers `release: [published]`; runs `codehub code-pack <repo> --budget 100000 --tokenizer openai:o200k_base@tiktoken-0.8.0 --out-dir /tmp/pack`; `tar -czf opencodehub-pack.tar.gz -C /tmp/pack .`; `actions/upload-artifact@v7` + `gh release upload "${{ github.event.release.tag_name }}" opencodehub-pack.tar.gz --clobber` per `sbom.yml:20-28` pattern
- [ ] Verify deterministic output by re-running in same commit and diffing
- **Dependencies**: none
- [P]

#### AC-D-5: lefthook polish

- [ ] `lefthook.yml` — top-level: `min_version: 2.1.6`, `assert_lefthook_installed: true`, `glob_matcher: doublestar`, `output: [meta, summary, failure, execution_info]`, `templates: {pnpm: "pnpm exec"}`
- [ ] Add `fail_text` on every job: biome, banned-strings, commitlint, typecheck, test
- [ ] Add `priority` on pre-commit jobs: `biome: 1`, `banned-strings: 2`
- [ ] Add `skip: [merge, rebase]` on typecheck + test (pre-push)
- [ ] Add `files: "git diff --name-only @{push} HEAD || git diff --name-only HEAD~"` to typecheck + test (pre-push)
- [ ] Add pre-commit `pnpm-lock-sync` job: `run: "pnpm install --frozen-lockfile --lockfile-only"`, `glob: "{pnpm-lock.yaml,package.json,pnpm-workspace.yaml}"`, `fail_text: "pnpm-lock is stale — run 'pnpm install' then re-stage"`
- [ ] Add pre-push `verdict` job: `run: "{pnpm} codehub verdict --base origin/main --head HEAD --exit-code"`, `skip: [merge, rebase]`, `fail_text: "codehub verdict failed — run 'mise run och:self-verdict' locally to reproduce"`
- [ ] Scope banned-strings to a glob instead of whole-repo (current line 8-9 has no glob): `glob: "**/*.{ts,tsx,js,jsx,md,yaml,yml,json}"` with exclusions list matching `scripts/check-banned-strings.sh`
- **Dependencies**: AC-A-9 (pre-push verdict job needs abstraction-hardened `codehub verdict` to reflect the flipped default)
- **Not [P]**

#### AC-D-6: mise `och:self-*` tasks

- [ ] `mise.toml` — add `[tasks."och:self-analyze"]`, `[tasks."och:self-scan"]`, `[tasks."och:self-verdict"]`, `[tasks."och:self-pack"]` — each runs the corresponding `codehub` subcommand on the local repo, using the workspace `pnpm link`ed binary
- [ ] Add `[tasks."pack:determinism"]` wrapping `bash scripts/pack-determinism-audit.sh`
- [ ] `[tasks.check:full]` — append `pack:determinism` to `depends`
- **Dependencies**: none for `och:self-analyze`/`scan`/`pack`; `och:self-verdict` implicitly depends on AC-A-9 for default-flip alignment (but task definition itself is fine)
- [P]

## Wave structure (Act phase)

### Track A waves

- **Wave A.1** (serial) — AC-A-1 (rename `query` → `rawQuery`) FIRST. This is the type-system ripple that every other Track A AC rides on.
- **Wave A.2** (parallel) — AC-A-2 (column-encoders), AC-A-4 (Parquet sidecar) can run in parallel after A.1.
- **Wave A.3** (parallel) — AC-A-3 (CochangeStore + SymbolSummaryStore on GraphDbStore), AC-A-7 (parity-harness hoist) after A.2.
- **Wave A.4** — AC-A-5 (41-file migration) + AC-A-6 (typed finders on critical path) + AC-A-8 (paths.ts) in parallel after A.3.
- **Wave A.5** (serial) — AC-A-9 (flip default) → AC-A-10 (parity audit). Serial because A-10 depends on A-9's flip.

### Track B waves

- **Wave B.1** (serial within track, parallel with A/C/D) — AC-B-1 (catalog spec) then AC-B-2 (wrapper + converter + tests). Both trivially isolated — no cross-package impact.

### Track C waves

- **Wave C.1** (fully parallel) — AC-C-1, AC-C-4, AC-C-5, AC-C-6, AC-C-7 all parallel (no interdependencies among themselves and none with Track A once A-1 and A-2 land).
- **Wave C.2** (after Track A Wave A.2) — AC-C-2 (stringArrayField) needs AC-A-2's column-encode.ts module; AC-C-3 (embedder fingerprint) needs AC-A-2 for the store-meta migration path.

### Track D waves

- **Wave D.1** (fully parallel, no OCH code dependency) — AC-D-1, AC-D-2, AC-D-3, AC-D-4, AC-D-6.
- **Wave D.2** (serial with Track A) — AC-D-5 (lefthook pre-push verdict) after AC-A-9.

### Cross-track sequencing

- **Track A Wave A.1 blocks everything that touches `IGraphStore.query`** — AC-A-1 must land first. Because `store.rawQuery` is called throughout, all other Track A ACs, plus AC-A-5's 41-file migration, plus any AC that imports storage types, wait on A.1.
- **Track B is fully isolated** from Track A — `packages/scanners/**` does not touch `packages/storage/**`. Track B and Track A Wave A.1 can run concurrently in sibling worktrees.
- **Track C: C-1 (parse-cache), C-4 (embedder factory), C-5 (SCIP edges), C-6 (READMEs), C-7 (gitmodules)** are all isolated from Track A. **C-2 (stringArrayField) and C-3 (embedder fingerprint)** ride on Track A Wave A.2 (AC-A-2's column-encode.ts).
- **Track D: D-1..D-4 + D-6** are isolated (just CI workflow files + mise.toml). **D-5** (lefthook pre-push verdict) runs after Track A Wave A.5 (AC-A-9 default flip) so that the pre-push verdict gate reflects post-M7 behavior.
- **Merge strategy**: single PR `feat/v1-finalize` per prior convention (PR #64 and PR #68 both bundled multi-track). If ultraplan critic flags the 108-SQL migration as too heavy (SPEC ASSUMES partial scope per Q2), split only AC-A-6 + the deferred wiki/pack/analysis follow-on into a sibling PR `feat/v1-finalize-sql-migration` landing immediately after.

## Open questions carried into Gate 1

All have working assumptions baked into the spec above. Override only to steer.

1. **Q1 — Single bundled PR vs split?** SPEC ASSUMES single `feat/v1-finalize` per M3+M4 and M5+M6 precedent. Override → split Track A Wave A.5 (flip + audit) into its own PR landing last.
2. **Q2 — Raw-SQL migration scope?** SPEC ASSUMES minimal finder-method additions in AC-A-6 (`listNodesByKind`, `listEdgesByType`, `listDependencies`, `listFindings`) migrating only the four critical MCP tools (`query.ts`, `group-contracts.ts`, `dependencies.ts`, `list-findings.ts`). Wiki / pack / analysis / remove-dead-code / route-map raw-SQL sites (104 sites remaining) deferred to a follow-on PR. Override → migrate all 108 in-spec and widen AC-A-6 to cover analysis/verdict.ts + analysis/impact.ts hot paths.
3. **Q3 — `IGraphStore.query` rename?** SPEC ASSUMES rename to `rawQuery(statement, params)` with `Store.dialect: "sql" | "cypher"` marker AND a one-milestone alias shim on `query()`. Override → hard rename (no shim) and migrate every internal caller in the same commit.
4. **Q4 — `TYPE_OF` edge kind addition?** SPEC ASSUMES YES, appended at END of `edges.ts` union per append-only rule. The first emission is a one-time content delta on re-index, documented as a schema minor bump. Override → hold `TYPE_OF` until a later milestone and emit only `REFERENCES` + `IMPLEMENTS` in C-5.
5. **Q5 — Parse-cache eviction env var + default?** SPEC ASSUMES `CODEHUB_PARSE_CACHE_MAX_BYTES=1073741824` (1 GiB) default; LRU sweep on every new write that would exceed cap; 0 disables. Override → different default (512 MiB or 4 GiB), or time-based eviction (TTL) instead of size-based.
6. **Q6 — detect-secrets priority tier?** SPEC ASSUMES P1 (matches `betterleaks` position; secret leakage is always high-signal). Override → P2 if the AC wants `betterleaks` to remain the single P1 secrets scanner and `detect-secrets` runs only on weekly deep scans.
7. **Q7 — ADR count?** SPEC ASSUMES 2 new ADRs — `0013-m7-default-flip-and-abstraction.md` (T-M7-1 + T-M7-3 + T-M7-5 escape-hatch interface sketch) and `0014-scip-references-and-embedder-fingerprint.md` (C-3 + C-5 combined). Override → split into 3-4 ADRs (separate doc for the AGE/Memgraph/Neo4j/Neptune interface sketch; separate doc for SCIP REFERENCES; separate doc for embedder fingerprint).
8. **Q8 — `.gitmodules` debt item?** SPEC ASSUMES CLOSE AS STALE — file removed when `packages/gym` moved to `opencodehub-testbed` (commit 378f79f). No action needed beyond AC-C-7's `.erpaval/debt.md` status update. Override → re-add `.gitmodules` and restore the thiserror@v2.0.17 pin if the gym corpus is being re-introduced.

## Validation constraints (cross-check against ROADMAP 10-constraint list)

| # | Constraint | Track A posture | Track B posture | Track C posture | Track D posture |
|---|-----------|-----------------|-----------------|-----------------|-----------------|
| 1 | Stdio MCP + CLI only | No HTTP added; default flip is local-file storage | No HTTP in detect-secrets wrapper | No HTTP added | No HTTP; CI workflows only |
| 2 | No LLM in query path | No LLM call in storage / abstraction work | No LLM in wrapper or converter | No LLM in any C-* item | No LLM in CI / lefthook / mise |
| 3 | Narrative features ship as skills | N/A | No new skill required (detect-secrets surfaces through existing `/audit-deps`) | N/A | N/A |
| 4 | Fixtures / evals in testbed | Testbed corpus used by AC-A-10 parity audit; no new fixtures in core beyond `@fixtures__/` | Converter test fixtures in `packages/scanners/src/converters/__fixtures__/` (small, in-core) | C-1 eviction fixture small, in-core; C-5 SCIP fixture updated in-core | N/A |
| 5 | `mise run check` exit 0 | Every AC carries this; AC-A-9 runs the full matrix with `CODEHUB_STORE=lbug` | AC-B-1 + AC-B-2 carry this | Every AC carries this | D-5 is itself part of `check` |
| 6 | `graphHash` byte-identical | **Load-bearing** — U1 ubiquitous + W-A-2 guards TYPE_OF insertion; AC-A-10 parity audit is the final gate | N/A | **Load-bearing on C-5** — W-A-2 and the edges.ts append-only rule govern TYPE_OF emission; incremental-determinism fixture regenerated once | N/A |
| 7 | Deterministic code-pack | AC-A-4 preserves byte-identity on DuckDb path; LadybugDB path stamps `determinism_class: degraded` when sidecar absent — matches prior S-M5-3 contract | N/A | N/A | **Load-bearing on D-4 + D-6** — release-asset + `pack:determinism` task enforce U2 |
| 8 | No time estimates | Waves only, no calendar | Waves only | Waves only | Waves only |
| 9 | SARIF 2.1.0 conformance | N/A | **Load-bearing** — AC-B-2 converter emits SARIF 2.1.0 validated via `SarifLogSchema`; wrapper goes through `parseSarifOrEmpty` | N/A | AC-D-1/D-2/D-3 SARIF uploads keep format |
| 10 | 20-scanner pipeline | N/A | **Load-bearing** — AC-B-1 + AC-B-2 are THE constraint-10 items; total rises 19 → 20 | N/A | AC-C-6 scanners/README.md cites 20 |

## References

- `.erpaval/ROADMAP.md` §M7, §Scanner pipeline, §Validation constraints, §Target package layout
- `.erpaval/debt.md` (W2-E.4 parse cache, C1 stringArrayField, SageMaker 1+2, SCIP REFERENCES, 4 READMEs, .gitmodules)
- `.erpaval/sessions/session-33f24f/intake.yaml`
- `.erpaval/sessions/session-33f24f/explore-storage.yaml` (IGraphStore audit)
- `.erpaval/sessions/session-33f24f/explore-debt.yaml` (scanner catalog, parse-cache, C1, SageMaker, SCIP, READMEs)
- `.erpaval/sessions/session-33f24f/explore-ci.yaml` (lefthook/mise/workflows surface + claude-sql patterns)
- `.erpaval/sessions/session-33f24f/research-graphdb-backends.yaml` (AGE/Memgraph/Neo4j/Neptune union surface + risks)
- `.erpaval/sessions/session-33f24f/research-detectsecrets-scip.yaml` (detect-secrets adapter + SCIP REFERENCES emission)
- `.erpaval/specs/004-m3-m4/spec.md` (wave structure precedent)
- `.erpaval/specs/005-m5-m6/spec.md` (spec shape + [P] marker convention)
- `docs/adr/0011-graph-db-backend.md` (M3 rationale; M7 adds ADR 0013)
- `docs/adr/0012-repo-as-first-class-node.md` (M6; M7's repo_uri remains canonical for AMBIGUOUS_REPO)
- `/efs/lalsaado/workplace/claude-sql/.github/workflows/{semgrep,osv,sbom}.yml` (reference shape for Track D)
- `/efs/lalsaado/workplace/claude-sql/lefthook.yml` (reference shape for AC-D-5)

## Status

- **Drafted**: 2026-05-09 (session-33f24f, Plan phase).
- **Gate 1 approval**: pending.
- **Accepted**: on merge of `feat/v1-finalize` → `main`.
