# OpenCodeHub v1.0 finalize — PR-split generator-critic analysis

**Session**: `session-33f24f`
**Date**: 2026-05-09
**Status**: Gate 1 input — not code. Three strategies proposed; a critic pass follows each; a top-level recommendation closes with a sub-recommendation for the 108-raw-SQL migration.

---

## 0. Inputs and ground truth

Every bullet below is grounded in an ERPAVal packet cited as `<file>:<section>`.

- **Track A scope — storage M7 flip**. `explore-storage.yaml:summary_for_spec` enumerates:
  - Priority-0 blockers: rename `IGraphStore.query`, add `CochangeStore`/`SymbolSummaryStore` on `GraphDbStore` (currently `NotImplementedError` per `graphdb-adapter.ts:881-916`), promote or relocate `exportEmbeddingsParquet`.
  - Priority-1 fixes: **41 concrete-class type pins** (`explore-storage.yaml:ambient_couplings.concrete_class_type_pins.count:221`), **108 raw-SQL call sites** (`explore-storage.yaml:raw_sql_through_IGraphStore_query.count:254`), hoist column encoders (`shared_helpers:140-143`), hoist parity rebuilders (`test_fixtures.third_party_adapter_reuse:185-195`), generalise `paths.ts` DB_FILE_NAME (`:110`), doctor symmetry (`:278-279`).
  - Hash-parity divergences that MUST not drift: `step` sentinel, empty-record `languageStats`, deadness normalisation, Cochange/SymbolSummary PK shape, `stats_json` canonicalisation (`explore-storage.yaml:schema_surface.divergences_that_could_fork_the_hash:162-169`).

- **Track B — detect-secrets (20th scanner)**. Per `research-detectsecrets-scip.yaml:thread_1_detect_secrets`: Apache-2.0, v1.5.0 (stale-since-2024 flag required), non-SARIF native, `~120-180 LOC TS + ~80 LOC fixture` converter, wrapper shape matches `wrappers/osv-scanner.ts` template (`explore-debt.yaml:wrapper_anatomy:31-45`). Adds 20th catalog entry — `explore-debt.yaml:section_1_scanner_catalog.total_entries:7` = 19 today.

- **Track C — debt sweep**. Six sub-items with different hash-impact profiles:
  - **C1**: parse-cache eviction (`explore-debt.yaml:section_2_parse_cache_eviction`) — NO eviction exists today (`:87-92`); eviction is a NEW code path; neutral to graphHash because cache is content-addressed (not materialised into the graph).
  - **C2**: `stringArrayField` round-trip asymmetry (`explore-debt.yaml:section_3_stringArrayField_asymmetry`) — writer `stringArrayOrNull` turns `[]` → NULL (`:106-109`); reader silently drops to `undefined`. Parity-test-adjacent but does NOT currently diverge across adapters because both adapters apply the same coercion (`:131`). Touches the graphHash contract via canonicalJson indirectly for downstream consumers that intentionally carry `[]`.
  - **C3**: SageMaker embedder items #1 (rebuild-on-switch refusal) + #2 (`defaultOpenEmbedder` consolidation) per `explore-debt.yaml:section_4_sagemaker_embedder_consolidation`. Neither touches graphHash: modelId is not persisted today (`:192-201`) and the factory move is a pure refactor.
  - **C4**: SCIP REFERENCES edge + TYPE_OF (`explore-debt.yaml:section_5_scip_references_and_heritage`, `research-detectsecrets-scip.yaml:thread_2_scip_references_heritage`). REFERENCES already in the `RELATION_TYPES` union (position 21 per `research:proposed_edge_kinds.references`). TYPE_OF is NOT in the union — must be appended at tail per `edges.ts:29-32` append-only rule. **This IS a graphHash-shape touch**: first emission produces a one-time content delta on re-index (`research:graph_hash_impact.caveats`). Incremental-determinism fixtures need regeneration (`research:graph_hash_impact.caveats`).
  - **C5**: 4 missing READMEs — cli, mcp, ingestion, scanners (`explore-debt.yaml:section_6_readmes_and_gitmodules.packages_missing_readme`). Pure doc. Zero hash impact.
  - **C6**: `.gitmodules` close-out — file does not exist at HEAD (`explore-debt.yaml:section_6_readmes_and_gitmodules.gitmodules.status:293`); debt item is stale. One-line "close-out" in debt.md is the real action.

- **Track D — dogfood polish**. Per `explore-ci.yaml:summary_for_ears_spec.additions_needed`:
  - `semgrep.yml` new workflow (copy from `/efs/lalsaado/workplace/claude-sql/.github/workflows/semgrep.yml` pattern).
  - `osv.yml` split out of `ci.yml:94-117` (`explore-ci.yaml:section_1.osv_job_shape:26-33`).
  - `self-scan.yml` mirroring `github-weekly.yml` (`explore-ci.yaml:section_5.github_weekly_template:334-349`) with SARIF at `.codehub/scan.sarif` and category `opencodehub-self`.
  - Release-please delta: attach code-pack to release as asset (mirror `sbom.yml:24-28` pattern per `explore-ci.yaml:section_3.sbom_yml.release_asset_upload_pattern:215-224`).
  - lefthook polish — `min_version: 2.1.6`, `assert_lefthook_installed`, `glob_matcher: doublestar`, output block, `fail_text` per job, priority ordering, skip `[merge, rebase]`, pre-push `@{push} HEAD` diff scoping, `pnpm-lock.yaml` freshness gate — all currently absent per `explore-ci.yaml:section_2.gaps_relative_to_claude_sql_pattern:110-121`.
  - mise additions: `och:self-*` namespace + `pack:determinism` wired into `check:full` — none exist today (`explore-ci.yaml:section_4.pack_determinism_audit_wiring:268-280`).

- **Hard rails (ROADMAP §M7 and §"Validation constraints")**:
  1. Stdio-only; no HTTP (constraint 1).
  2. No LLM in query path (constraint 2).
  3. `mise run check` exit 0 per commit (constraint 5).
  4. **graphHash byte-identical every commit** (constraint 6) — "per commit", not "per milestone merge".
  5. Deterministic code-pack (constraint 7).
  6. No time estimates (constraint 8).
  7. 20-scanner pipeline coverage (constraint 10 — motivates Track B in v1.0).
  8. Rip-and-replace latitude (`ROADMAP.md:217-219`): 1 active user, no breaking-change budget *beyond* graphHash byte-identity and MCP contract stability.
  9. Prior milestone-bundle precedent: PR #53 (M1+M2), PR #64 (M3+M4), PR #68 (M5+M6) — two-milestone bundles with commit sequences in the teens.

- **M7 is the terminal milestone**. The v1.0 tag follows this merge. Tag discipline (release-please-driven per `explore-ci.yaml:section_1.release-please.yml:49-56`) means the tree at the squash-merge commit is what gets cut.

---

## 0a. Cross-track dependency and risk matrix

Before evaluating strategies, it helps to project tracks onto two axes: graphHash-shape touch and file overlap with other tracks.

| Track / sub-item | graphHash shape touch? | File-path hot zone | Cross-track file overlap |
|---|---|---|---|
| A — IGraphStore rename (`query` → `rawQuery`) | No (interface shape only) | `packages/storage/src/interface.ts` | None — isolated to storage |
| A — CochangeStore + SymbolSummaryStore impls on `GraphDbStore` | Yes — bulkLoad path writes rows that feed `graphHash` via the Cochange/SymbolSummary PK handling at `graphdb-schema.ts:204-227`; must not drift from DuckDB PK shape | `packages/storage/src/graphdb-adapter.ts:881-916` | None |
| A — 41 concrete-class type pins → `IGraphStore` | No (type-only) | `packages/cli/src/commands/*`, `packages/mcp/src/tools/*`, `packages/mcp/src/resources/*` | Overlaps C3 (cli/query.ts, mcp/tools/query.ts) |
| A — 108 raw-SQL sites → typed finders | No per site; Yes cumulatively if `nodes`/`relations` result ordering silently diverges across dialects (`research-graphdb-backends.yaml:compatibility_risks.hash_determinism:347-351`) | `packages/analysis/src/*`, `packages/mcp/src/tools/*`, `packages/pack/src/*`, `packages/wiki/src/wiki-render/*` | Moderate overlap with C3 on `query.ts` paths |
| A — `CODEHUB_STORE=lbug` default flip | Yes — this is the commit where parity must hold end-to-end on the default path | `packages/storage/src/factory.ts`, `packages/cli/src/commands/open-store.ts` | None |
| A — dual-emit drop `sql|cypher` → `cypher` | No (MCP tool output shape; not graph) | `packages/mcp/src/tools/query.ts` | Overlaps A type-pin pass |
| A — `exportEmbeddingsParquet` promote-or-move | No (sidecar artifact; not in graph) | `packages/pack/src/embeddings-sidecar.ts`, maybe `packages/storage/src/interface.ts` | None |
| B — detect-secrets wrapper + converter | No | `packages/scanners/src/catalog.ts`, `packages/scanners/src/wrappers/detect-secrets.ts` (new), `packages/scanners/src/converters/` (new) | None |
| C1 — parse-cache eviction | No (cache is off-graph) | `packages/ingestion/src/pipeline/phases/content-cache.ts` | None |
| C2 — `stringArrayField` symmetry | Indirect — keywords/responseKeys are TEXT[] columns, not JSON, so canonicalJson bypass (`explore-debt.yaml:section_3.canonicalJson_graphHash_impact:128-131`). Both adapters currently symmetric, so no live divergence but future-facing | `packages/storage/src/duckdb-adapter.ts:1557-1564`, `packages/cli/src/commands/analyze.ts:731-739` | Overlaps A storage hoist |
| C3 — SageMaker #1 rebuild-on-switch | Marginal — new `embedder_model_id` column on `store_meta`. `store_meta` is excluded from graph hash input in current design (`explore-debt.yaml:section_4.rebuild_on_switch_implication:201`); exclusion must be preserved | `packages/storage/src/schema-ddl.ts:172-183`, `packages/storage/src/duckdb-adapter.ts` meta path | Touches storage |
| C3 — SageMaker #2 `defaultOpenEmbedder` consolidation | No | `packages/embedder/src/factory.ts` (new), 3 call sites | Overlaps A's type-pin changes on `query.ts` paths |
| C4 — SCIP REFERENCES + TYPE_OF emission | **Yes — one-time content delta**. REFERENCES is already in the union (position 21); TYPE_OF must be appended at tail (position 25 after OWNED_BY). Incremental-determinism fixtures regen required (`research-detectsecrets-scip.yaml:thread_2.graph_hash_impact.caveats:251-254`) | `packages/core-types/src/edges.ts`, `packages/scip-ingest/src/derive.ts:31-35, :128-148, :184-199`, `packages/ingestion/src/pipeline/phases/scip-index.ts:238-252` | None |
| C5 — 4 READMEs | No | `packages/cli/README.md`, `packages/mcp/README.md`, `packages/ingestion/README.md`, `packages/scanners/README.md` | None |
| C6 — `.gitmodules` close-out | No (file already deleted) | `.erpaval/debt.md` only | None |
| D — `semgrep.yml` | No | `.github/workflows/semgrep.yml` | None |
| D — `osv.yml` split + `ci.yml` osv-job removal | No | `.github/workflows/osv.yml`, `.github/workflows/ci.yml:94-117` | None |
| D — `self-scan.yml` | No | `.github/workflows/self-scan.yml` | None |
| D — release-please code-pack asset | No | `.github/workflows/release-please.yml` (or new `release-pack.yml`) | None |
| D — lefthook polish | No | `lefthook.yml` (22 lines → ~80 lines) | None |
| D — mise `och:self-*` + pack:determinism | No | `mise.toml` edits | None |

**Key observations**:
1. Only **two commits** across the entire finalize wave carry a direct graphHash delta: the `CODEHUB_STORE=lbug` flip in A (where parity must hold byte-identically on the default path) and C4's TYPE_OF emission (where a one-time content delta is expected and fixtures regenerate).
2. The 108-SQL migration does not shift graphHash per-site, but it CAN shift it via result-ordering drift if a migrated site reads `ORDER BY id` under DuckDB but natively unordered under LadybugDB. Per `research-graphdb-backends.yaml:compatibility_risks.hash_determinism.details`, every hash-contributing read MUST carry a total-order `ORDER BY`. The parity suite catches this if the site is exercised by the fixtures; the risk is unexercised sites.
3. File overlap between A and C is concentrated at `packages/cli/src/commands/query.ts` and `packages/mcp/src/tools/query.ts` (A replaces `DuckDbStore` type with `IGraphStore`; C3 item 2 extracts `defaultOpenEmbedder`). A conflict here is trivial (different lines) but the order of merges matters for the rebase cost.

---

## 1. Strategy S1 — single bundled PR `feat/v1-finalize`

### Shape

| Field | Value |
|---|---|
| **Name** | `feat/v1-finalize` |
| **Branches** | `feat/v1-finalize` (single) |
| **Precedent** | Matches PR #53 / #64 / #68 two-milestone bundle pattern — this is a terminal one-milestone bundle with associated debt/dogfood. |

### Scope per branch

| Branch | Tracks | AC subsets |
|---|---|---|
| `feat/v1-finalize` | A + B + C + D | All of M7 T-M7-1..T-M7-5; Track B detect-secrets wrapper + SARIF converter + catalog bump to 20 (constraint 10); Track C six sub-items (C1-C6); Track D all five CI/mise items |

Commits within the branch should be ordered so every commit keeps graphHash byte-identical against the previous HEAD. Recommended sequencing inside the single PR:

1. Hoist column encoders and parity rebuilders (pure refactor, hash-neutral — `explore-storage.yaml:shared_helpers:140-143`).
2. Add `CochangeStore` + `SymbolSummaryStore` on `GraphDbStore` (fills `NotImplementedError` at `graphdb-adapter.ts:881-916`).
3. Rename `IGraphStore.query` (interface evolution; parameter-shape only; hash-neutral).
4. Replace 41 concrete-class type pins with `IGraphStore` (type-only; hash-neutral).
5. Flip `CODEHUB_STORE=lbug` default. graphHash parity suite (`graph-hash-parity.test.ts:1-638`) gates this commit.
6. Drop dual-emit `sql|cypher` → `cypher`-only (T-M7-3).
7. Migrate or defer the 108 raw-SQL call sites — see §5.
8. Promote `exportEmbeddingsParquet` OR move to `pack` (single decision per `explore-storage.yaml:priority_0_blockers:283-286`).
9. Track B wrapper + converter + catalog bump.
10. Track C ordered: C5 READMEs → C6 gitmodules close-out → C1 eviction → C3 SageMaker consolidation → C2 `stringArrayField` fix → C4 SCIP REFERENCES+TYPE_OF (**last in track — this commit is the one-time hash delta**; bump `SCHEMA_VERSION` per `explore-debt.yaml:section_2.store_meta` shape and regenerate `incremental-determinism.test.ts` per `research-detectsecrets-scip.yaml:thread_2.graph_hash_impact.caveats`).
11. Track D ordered: mise `och:self-*` first (testable locally) → lefthook polish → `osv.yml` split → `semgrep.yml` → `self-scan.yml` → release-please code-pack asset.
12. ADR 0013.

### Merge order and deps

Single merge. No cross-PR coordination. Release-please cuts v1.0 automatically on push to `main` (`explore-ci.yaml:section_1.release-please`).

### Pros

1. **Precedent fit**. PR #53, #64, #68 all bundled a milestone pair plus adjacent debt; reviewer muscle memory is already calibrated for 15-25 commit PRs at this seam.
2. **One-shot graphHash gate**. The parity suite runs once at the end; any drift surfaces on a single red CI, not across three merge boundaries that might mask interaction bugs.
3. **Atomic v1.0 cutline**. release-please picks up `BREAKING CHANGE` + `feat(M7)` footers from a single squash; the v1.0 tag's changelog is clean and auto-generated without manual stitching.
4. **Rip-and-replace latitude**. ROADMAP §"Rip-and-replace" explicitly sanctions this for one active user. No multi-PR coordination overhead.
5. **No intermediate "half-M7" states**. Between commits, the branch owner holds the tree internally consistent; no published PR ever shows a tree where `CODEHUB_STORE=lbug` is default but `NotImplementedError` still lives on `GraphDbStore.bulkLoadCochanges`.

### Cons

1. **Reviewer fatigue compounds**. Adding up from the ERPAVal packets: 41 type-pin files + up to 108 SQL sites + ~10 storage/graph hoist changes + wrapper+converter+test for detect-secrets + 6 debt items + 5 CI/mise items ≈ **150-200 files changed in a single review surface**. Prior PR #68 (M5+M6) was 85 files; this would be ~2.3x.
2. **Bisect cost on regression**. If v1.0 ships and a user hits a DuckDB-degradation path in `pack/embeddings-sidecar.ts` (which falls through to `absent:true` for non-DuckDB backends per `explore-storage.yaml:duckdb_leaks.outside_storage_leaks.pack:100-101`), the offending commit is buried in a squash of 20+ commits. `git bisect` granularity collapses to "the whole M7 merge or nothing".
3. **graphHash invariant is per-commit, not per-PR**. Hard rail #6 says "graphHash byte-identical every commit". A single PR with 20 commits — each of which must individually pass the parity test — is equivalent in per-commit work to three PRs with 7 commits each. Bundling saves review cost, not invariant-maintenance cost.
4. **Track D in-flight risk**. Lefthook polish and self-scan workflow changes can break local dev loop (`mise run check`) for the branch owner DURING development. If Track A also broken, there's no isolated "just revert Track D" path — the whole branch carries the risk.
5. **ADR 0013 ambiguity**. When M7 + debt + dogfood are one PR, the ADR has to describe four separate decision axes (store flip, SQL/Cypher cutover, pluggability guidance, 108-SQL disposition). Readers often want one ADR per decision.

### hash_parity_risk

**Medium.** Justification: graphHash invariant U1 runs in the parity-test suite on every commit — `graph-hash-parity.test.ts:1-638` with 5 fixtures (`test_fixtures.fixtures:174-179`) and `assertParity` checking `duckHash === graphDbHash` byte-identically (`test_fixtures.parity_assertion.contract:183`). The divergences enumerated at `explore-storage.yaml:schema_surface.divergences_that_could_fork_the_hash:162-169` (step sentinel, languageStats empty-record, Cochange/SymbolSummary PK surrogate, stats_json canonicalisation) are all live risks during M7. Bundled PRs concentrate those risks into one review window — higher chance that a late-stage fix-up commit silently touches an encoder without triggering a fixture regeneration. BUT: the parity suite is genuinely strict and U1 will catch a divergence on CI before squash, so "High" is not warranted.

### reviewer_fatigue

**High.** 150-200 files across 4 tracks; 2.3x the PR #68 volume. Even with the single-user rip-and-replace latitude, the *author* is also the *reviewer* here; context-switching across `storage/`, `scanners/`, `analysis/`, `cli/`, `.github/workflows/`, `lefthook.yml`, and `mise.toml` within one review window is the practical cost.

### total_estimated_files_changed

Citing packet counts:
- 41 concrete-class type pins (`explore-storage.yaml:ambient_couplings.concrete_class_type_pins.count:221`).
- 108 raw-SQL sites, distributed 46 mcp + 17 cli + 15 wiki+pack + 27+ analysis (`explore-storage.yaml:outside_storage_leaks.analysis/mcp/cli/pack/wiki:54-57`) — in files the type-pin set already covers for most, but the SQL migration adds new helper files (typed finders) estimated at 8-12 new files.
- Storage internal hoists: 4-6 files (column-encode extraction + parity-test utility hoist + paths generalization).
- Track B: ~4 new files (catalog entry, wrapper, converter, test) + 2 edits (`catalog.ts`, `wrappers.test.ts` per `explore-debt.yaml:wrapper_test_convention:47-66`).
- Track C: C1 ~3 files (new eviction function + test + wiring), C2 ~2, C3 ~5-7 files (factory extraction + 3 call-site edits + metadata persistence), C4 ~3-5 files (derive.ts + edges.ts + fixture regeneration + scip-index.ts emit wiring), C5 4 READMEs, C6 1 debt.md line.
- Track D: ~8 files (semgrep.yml, osv.yml, self-scan.yml, ci.yml delete, lefthook.yml rewrite, mise.toml edits, release-please.yml code-pack step, pack-determinism wiring).

**Total: ~160-190 files** (upper bound including the 108 raw-SQL migration if folded in; lower bound if deferred).

### rollback_shape

Post-merge rollback = revert the single squash-merge commit. release-please will either:
1. Not yet have opened a v1.0 release PR — rollback is `git revert <squash>` + push; release PR never opens.
2. Have opened but not merged a v1.0 release PR — close the release PR; revert the squash; release PR reopens at the prior state.
3. Have merged v1.0 tag — revert the squash; cut a v1.0.1 patch with the revert + clear changelog note.

The graveness of path (3) is the blast radius of a bundled rollback: reverting M7 drops *detect-secrets*, *all 4 READMEs*, *lefthook polish*, *osv.yml split*, and *self-scan.yml* in a single revert — even if only the store-flip was broken. Rollback granularity collapses to "all of v1.0 finalize or none".

---

## 2. Strategy S2 — split by risk

### Shape

| Field | Value |
|---|---|
| **Name** | `feat/v1-finalize-{core,polish}` |
| **Branches** | `feat/v1-finalize-core`, `feat/v1-finalize-polish` |
| **Ordering** | `core` → `polish` (sequential; polish rebases on core) |

### Scope per branch

| Branch | Tracks | AC subsets |
|---|---|---|
| `feat/v1-finalize-core` | Track A (all) + C-hash-touching = **C2 (`stringArrayField`) + C4 (SCIP REFERENCES + TYPE_OF)** | All M7 AC (T-M7-1..T-M7-5), ADR 0013, parity suite extensions for TYPE_OF + regenerated incremental-determinism fixtures |
| `feat/v1-finalize-polish` | Track B (detect-secrets) + Track D (full) + C-non-hash = **C1 (eviction) + C3 (SageMaker) + C5 (4 READMEs) + C6 (.gitmodules close-out)** | 20th scanner, all CI/mise/lefthook additions, non-graph debt |

### Merge order and deps

1. `core` merges first. release-please opens a v1.0-rc PR or holds until polish lands.
2. `polish` rebases on `main` post-`core` merge. Runs through parity suite again (cheap — no schema touch in polish).
3. `polish` merges. v1.0 tag cuts.

Dep justification:
- C4 (TYPE_OF edge append) MUST land with the M7 store flip because the incremental-determinism fixtures regenerated for C4 must match the fixtures regenerated for the store-default flip. Splitting them across two PRs would force double-regen.
- C2 (`stringArrayField`) fixes a round-trip asymmetry that, per `explore-debt.yaml:section_3.parity_test:132`, is already enforced in `graphdb-adapter.test.ts:1076-1116` — so the fix lives with storage work.
- Track B ships the 20th scanner (constraint 10) but does not touch graphHash; safe to land after store flip.
- Track D modifies only `.github/workflows/`, `lefthook.yml`, `mise.toml` — zero graph touch.
- C1 eviction, C3 SageMaker — also hash-neutral.
- C5 READMEs and C6 are pure docs.

### Pros

1. **Clean hash-risk quarantine**. Every line in `core` is screened for hash impact; every line in `polish` is provably hash-neutral (modifies no `packages/storage/`, `packages/core-types/src/edges.ts`, `packages/core-types/src/nodes.ts`, `packages/ingestion/src/pipeline/phases/` files that feed the graph).
2. **Bisectable rollback**. If v1.0 regressions surface, a team can revert `polish` alone (leave the store-flip in place) or revert both sequentially. Rollback granularity is at the risk seam, which is where rollbacks usually happen.
3. **release-please friendly**. release-please handles staged merges to `main` by opening/updating a single release PR — two merges to main between release-PR cycles is a supported pattern per `explore-ci.yaml:section_1.release-please.yml:49-56`.
4. **ADR 0013 can split cleanly too**. Core carries the "M7 store flip + pluggability escape hatch" decision; polish carries no ADR. Decision narrative is cleaner.
5. **Reviewer cadence**. Two medium PRs is a gentler cognitive load than one giant PR, especially when the same person is authoring and reviewing.

### Cons

1. **Intermediate `main` state**. Between `core` merge and `polish` merge, `main` has `CODEHUB_STORE=lbug` default + 20 scanners claimed by ROADMAP but only 19 in the catalog. A v1.0-rc cut at this point would fail constraint 10. Mitigation: hold the release-please release PR closed until `polish` lands.
2. **Double-rebase cost on the 108 SQL sites**. If the SQL migration is in `core`, `polish` rebases on top of 108 changed files; likely no conflict (different packages) but the test-utils fake at `analysis/src/test-utils.ts:214-482` may need re-sync.
3. **Track D self-scan.yml can't test `polish`'s own changes until it merges**. Mitigation: run self-scan.yml via `workflow_dispatch` on the feature branch before merge.
4. **C4 TYPE_OF hash bump in `core` means incremental-determinism fixtures are regenerated twice** (once for the store flip, once for the edge kind append) if both are split into different commits inside `core`. Low cost, but a subtle commit-order trap.
5. **Two ADR reviews if `polish` grows a secondary ADR** (e.g., a "dogfood workflow split" ADR). Not currently required — but the split invites over-documentation.

### hash_parity_risk

**Low.** Justification: all hash-touching work is confined to `core`. `polish` changes nothing under `packages/storage/`, `packages/core-types/`, `packages/ingestion/` (the three packages that feed graphHash inputs per `explore-storage.yaml:shared_helpers:135-139`). CI parity gate (`graph-hash-parity.test.ts`) runs on every commit in both PRs; polish can only fail it via unrelated regression which is structurally implausible.

### reviewer_fatigue

**Medium.** `core` is still the largest of the two; estimated 100-140 files. `polish` is ~50-70 files but spans detect-secrets wrapper, 4 READMEs, CI workflows, lefthook, mise — same number of *files* as a typical debt PR but more *concept surfaces*.

### total_estimated_files_changed

- `core`: 41 type-pins + 108 SQL sites (if folded) + ~6 storage hoists + ~3 C2 files + ~5 C4 files ≈ **155-170 files**.
- `polish`: ~6 detect-secrets + ~3 C1 + ~7 C3 + 4 C5 + 1 C6 + 8 Track D ≈ **28-35 files**.

### rollback_shape

Per-PR revert. If `polish` is in flight and `core` breaks production, revert `core` and close `polish`; release-please drops the pending release PR. If `polish` breaks after merge, revert `polish`; v1.0.1 patch ships with `core` intact + 20-scanner constraint deferred by one patch.

---

## 3. Strategy S3 — split by track

### Shape

| Field | Value |
|---|---|
| **Name** | `feat/v1-finalize-{A,B,C,D}` |
| **Branches** | `feat/v1-finalize-a-m7`, `feat/v1-finalize-b-detect-secrets`, `feat/v1-finalize-c-debt`, `feat/v1-finalize-d-dogfood` |
| **Ordering** | A → C → B → D (dep-driven, see below) |

### Scope per branch

| Branch | Tracks | AC subsets |
|---|---|---|
| `feat/v1-finalize-a-m7` | Track A | Full M7: `CODEHUB_STORE=lbug` default, dual-emit drop, `IGraphStore.query` rename, CochangeStore+SymbolSummaryStore on `GraphDbStore`, `exportEmbeddingsParquet` disposition, 41 type-pin replacements, column-encoder hoist, parity-rebuilder hoist, ADR 0013. **108 raw-SQL migration: see §5 sub-recommendation.** |
| `feat/v1-finalize-c-debt` | Track C | C1 eviction, C2 `stringArrayField`, C3 SageMaker #1+#2, C4 SCIP REFERENCES + TYPE_OF (**this PR carries a hash delta — fixture regen required**), C5 4 READMEs, C6 .gitmodules close-out |
| `feat/v1-finalize-b-detect-secrets` | Track B | 20th scanner: catalog entry + wrapper + SARIF converter + tests; ROADMAP constraint 10 satisfied |
| `feat/v1-finalize-d-dogfood` | Track D | semgrep.yml, osv.yml split (and ci.yml osv-job removal), self-scan.yml, release-please code-pack asset, lefthook polish, mise `och:self-*` + pack-determinism wiring |

### Merge order and deps

1. **A first.** M7 is the backbone. All later PRs need to rebase on the new `CODEHUB_STORE=lbug` default so their CI runs exercise the new store.
2. **C second.** C4 (TYPE_OF edge append) is the only non-A PR that touches graphHash. Landing it right after A means one rebase cycle for the incremental-determinism fixtures. C2's `stringArrayField` fix is in the same space.
3. **B third.** Detect-secrets is hash-neutral but satisfies constraint 10 which release-please should see as part of v1.0.
4. **D last.** Dogfood polish is outermost; self-scan.yml exercises the prior three PRs' tree. Release-please code-pack asset wiring only matters at release time.

Alternate order: A → B → C → D also works (B is hash-neutral and has no cross-dep on C); A → C → B → D is preferred because C4's fixture regen is minimally intrusive when A is fresh in memory.

### Pros

1. **Maximum bisect granularity**. Git bisect across v1.0 regressions lands on a single track's PR, which is a single decision surface with one ADR (A has 0013; others have none).
2. **Each PR matches a natural code-review unit**. A = "did the store flip work?"; B = "is the wrapper correct?"; C = "did the debt items land?"; D = "does CI stay green?". Each gates on one CI dimension.
3. **Rollback is surgical**. A v1.0.1 revert-only-D is trivial; revert-only-B yanks detect-secrets without touching the store; etc.
4. **ADR discipline**. One ADR per decision, in one PR. ADR 0013 stays with A.
5. **Hash-risk fully contained in A+C4**. B and D are provably hash-free by file-path screen.

### Cons

1. **4x PR creation/review overhead** for a 1-user repo. Prior precedent (PR #53, #64, #68) never went below 2 milestones per PR — a 4-PR split breaks precedent sharply.
2. **release-please coordination friction**. release-please auto-opens a release PR on every merge to `main`; 4 merges means 4 release-PR updates and the team has to keep the release PR closed/open across the sequence until D lands.
3. **Inter-PR rebase cost**. A changes 41 type-pin files across `cli/` and `mcp/`; when C lands, C3's SageMaker factory touches `cli/src/commands/query.ts` and `mcp/src/tools/query.ts` — both already edited by A. Rebase conflicts are likely but trivial.
4. **Cycle time inflation**. Four PRs × (author → review → CI → merge) sequential is slower than one bundled PR by a constant factor. With 1 user, author-review is the same person, but CI is real clock time.
5. **Intermediate "incomplete v1.0" states on main**. After A+C+B land but before D lands, `main` has 20 scanners and the LadybugDB default but `lefthook.yml` still missing `min_version`, `osv.yml` still embedded in `ci.yml`, and no `self-scan.yml`. A release-please release PR would want to cut v1.0 at this moment, which is undesirable because D is part of the "finalize" scope. Mitigation: keep the release PR closed until D merges.

### hash_parity_risk

**Low.** Same justification as S2: hash-touching work is confined to A + C4. B and D are hash-neutral by file-path. Three-way split adds no new risk vs. S2; the main difference is that C (debt) is its own PR rather than splitting C2+C4 off into core. C2+C4 land together in C, which is fine because C4's fixture regen covers C2's empty-array drift.

### reviewer_fatigue

**Low per PR, Medium aggregate.** Each PR is ≤ 60 files (A is the biggest at ~130-160 files if the 108-SQL migration folds in, or ~60 if it splits/defers — see §5). The per-PR cognitive load is lower than S1 or S2, but the aggregate of four review cycles approaches S1 in total token cost.

### total_estimated_files_changed

- A: 41 type-pins + 6 hoists + 3 store-flip + ADR ≈ **50-55 files** if 108-SQL defers; **~160 files** if 108-SQL folds.
- C: 3 C1 + 2 C2 + 7 C3 + 5 C4 + 4 C5 + 1 C6 ≈ **22 files**.
- B: wrapper + converter + tests + catalog bump ≈ **6 files**.
- D: 3 new workflows + 1 ci.yml edit + 1 release-please.yml edit + 1 lefthook.yml + 1 mise.toml + pack-determinism wiring ≈ **8-10 files**.

### rollback_shape

Per-PR revert. Best granularity of the three strategies. Post-merge blast radius for a bad landing is limited to that track's scope. If A breaks, revert A + reopen C, B, D as rebased-on-main PRs for later re-landing. If D breaks, revert D alone; store flip and everything else stays intact.

---

## 4. Side-by-side comparison

| Axis | S1 bundled | S2 risk-split | S3 track-split |
|---|---|---|---|
| **# PRs** | 1 | 2 | 4 |
| **Hash parity risk** | Medium | Low | Low |
| **Reviewer fatigue** | High | Medium | Low per PR / Medium aggregate |
| **Files changed (with 108-SQL folded)** | ~160-190 | core ~155-170 + polish ~30 | A ~160 + C ~22 + B ~6 + D ~10 |
| **Files changed (108-SQL deferred)** | ~55-85 | core ~55 + polish ~30 | A ~55 + C ~22 + B ~6 + D ~10 |
| **Bisect granularity on regression** | Worst (single squash) | Medium (2 squashes) | Best (4 squashes) |
| **Rollback blast radius** | All of v1.0 finalize | core or polish | One track |
| **Precedent fit (vs PR #53/#64/#68)** | Closest | Moderate deviation | Sharpest deviation |
| **ADR narrative quality** | Conflates 4 decisions | 1 ADR in core, 0 in polish | 1 ADR per track (A only) |
| **release-please coordination** | 1 release PR cycle | 1 release PR cycle (hold until polish) | 1 release PR cycle (hold until D) |
| **CI clock time** | 1 × full CI | 2 × full CI | 4 × full CI |
| **Per-commit U1 invariant load** | Same (invariant is per-commit, not per-PR) | Same | Same |
| **Risk of "tree in bad state on main"** | None (atomic) | Brief (between core and polish) | Longer (three intermediate states) |

---

## 5. The 108-raw-SQL sub-decision

### Options

| Option | Description |
|---|---|
| **(a)** | Fold the 108-site migration into Track A — `feat/v1-finalize-a-m7` or `feat/v1-finalize-core` |
| **(b)** | Split into a separate `feat/v1-finalize-sql-migration` follow-on PR inside the finalize wave, merged before v1.0 tag |
| **(c)** | Defer to M7.1 post-v1.0 tag — ship v1.0 with the raw-SQL sites still in the tree |

### Grounded context

- Runtime symptom per `explore-storage.yaml:raw_sql_through_IGraphStore_query.runtime_symptom:266-267`: "GraphDbStore.query() receives these strings and routes them to `assertReadOnlyCypher`, which will reject `SELECT` as a write verb or pass through and fail at the native binding. Result: every tool above is silently DuckDB-only today."
- The 108 sites are distributed: 46 `packages/mcp/src/`, 17 `packages/cli/src/`, 15 `packages/wiki+pack/src/`, 27+ `packages/analysis/src/` per `explore-storage.yaml:outside_storage_leaks:56-57`.
- The remediation recipe per `explore-storage.yaml:raw_sql_through_IGraphStore_query.remediation:268`: "Introduce typed finder methods on IGraphStore: listNodesByKind, listEdgesByType, traverseFrom, countNodesByKind, matchDependencies, etc. Migrate raw SQL call sites incrementally."
- The ROADMAP ships v1.0 as the *terminal* milestone post-M7. ROADMAP.md:130-141 does not list SQL-migration as an M7 AC — it lists T-M7-1..T-M7-5. The 108 migration is de facto M7 scope because without it the LadybugDB default breaks every tool that touches the raw SQL. BUT: there is nuance.

### Critique per option

**Option (a) — fold into Track A.**
- Pro: ships a coherent v1.0 in which `CODEHUB_STORE=lbug` actually works end-to-end. No user-visible tool is silently DuckDB-only post-flip.
- Pro: the typed-finder surface is a one-time API break on `IGraphStore`; doing it after the flip is worse than doing it with the flip.
- Pro: test-utils regex fake at `packages/analysis/src/test-utils.ts:214-482` (per `explore-storage.yaml:dialect_helper_leaks:274`) is already broken for any non-SQL backend — it has to be rewritten when A lands anyway. Folding in the SQL migration lets the test-utils rewrite land once, not twice.
- Con: blows Track A to ~160 files (vs ~55 if deferred). Reviewer fatigue climbs.
- Con: any mis-migration of a raw SQL site produces a runtime bug that may not be caught by CI (test coverage of the MCP tool surface is per `explore-storage.yaml:raw_sql_through_IGraphStore_query.high_value_targets:255-266` — `impact.ts` has "WITH RECURSIVE USING KEY" which is specifically DuckDB-only; the equivalent Cypher is subtly different and mis-translation is a real risk).

**Option (b) — split into a separate SQL-migration PR inside finalize wave.**
- Pro: bisect granularity is surgical — "was the regression in the flip or the SQL migration?"
- Pro: reviewer fatigue is partitioned. Each PR stays reviewable.
- Con: creates a *fifth* PR in S3 or a *third* in S2. Breaks precedent harder.
- Con: until the migration PR lands, `main` has the LadybugDB default but 108 tool call-sites silently fail. Per ROADMAP §"Validation constraints", `mise run check` must exit 0 per commit — meaning either (i) the test suite has no coverage of those 108 call-sites (partial truth — test-utils fake at `test-utils.ts:214-482` lets the suite pass even against a broken backend, which is the debt-source) or (ii) the test suite breaks. A check of `impact.test.ts`, `verdict.test.ts`, `detect-changes.test.ts`, `rename.test.ts` would resolve; the packet data suggests they use the test-utils fake, which is DuckDB-shaped.
- Con: v1.0 tag sits between PRs for an awkward interval.

**Option (c) — defer to M7.1 post-v1.0.**
- Pro: ships v1.0 now. Minimum-scope M7.
- Pro: Track A stays small (~55 files) and reviewable.
- Pro: `mise run check` exits 0 against the test-utils fake (DuckDB-dialect fixtures remain valid because DuckDB is still available as a non-default backend per ROADMAP §M7 T-M7-2 "retain DuckDB only for temporal analytics").
- Critical problem: post-v1.0 the default store flip means every user-visible tool that hits `packages/analysis/src/impact.ts`, `verdict.ts`, `detect-changes.ts`, `rename.ts`, `dead-code.ts`, `risk-snapshot.ts`, plus the MCP tools at `packages/mcp/src/tools/query.ts`, `dependencies.ts`, `list-findings.ts`, `pack-codebase.ts`, etc., is silently degraded or broken against the LadybugDB default. The product thesis in ROADMAP §"Product thesis" — "Claude Code plugin over stdio MCP" as P0 — means users will hit these tools immediately.
- Critical problem: ROADMAP §M7 T-M7-2 says "Retain DuckDB only for temporal analytics." If 108 raw-SQL sites are still DuckDB-only, we have two user-configurable defaults pulling in opposite directions — an anti-pattern for a product that promises "no breaking changes beyond graphHash byte-identity and the MCP tool contract" (ROADMAP §"Rip-and-replace latitude").
- Real problem: deferring invalidates the M7 success criterion. M7 is the final milestone; post-v1.0 "M7.1" is not a sanctioned ROADMAP milestone.

### Sub-recommendation: (a) fold into Track A

**Reasoning**:
1. The test-utils regex fake at `analysis/src/test-utils.ts:214-482` (per `explore-storage.yaml:dialect_helper_leaks`) must be rewritten when A lands to unblock the non-DuckDB backends. Folding the SQL migration in means the rewrite lands once.
2. The 108 sites are not "polish" — they are the actual wiring that makes the store flip user-visible. Deferring them produces a v1.0 where the store flip is nominally shipped but functionally degraded, which ROADMAP constraints 5 and 6 (`mise run check` + graphHash invariant) cannot catch because both currently run against the DuckDB-dialect fake.
3. Option (b) pushes reviewer fatigue to a fifth PR that exists only to accommodate the split; option (c) produces a v1.0 that does not satisfy its own milestone definition.
4. The packet's own recommendation at `explore-storage.yaml:summary_for_spec.priority_1_fixes:288`: "Replace raw SQL in analysis/, wiki/, pack/, mcp/ with typed IGraphStore finder methods (108 sites)." is listed as Priority-1 **fix**, not Priority-2 nice-to-have. Priority-1 is ship-blocking per the packet's own taxonomy.

The cost is adding ~100 files to Track A. Mitigation: migrate per subsystem as separate commits inside A — `analysis/` commit, `mcp/` commit, `pack/+wiki/` commit, `cli/` commit — so a squash doesn't lose the intra-commit granularity for git bisect purposes and so individual commits stay reviewable.

---

## 6. Top-level recommendation: S3 (split by track), A → C → B → D, with (a) folded into A

### The decision

Use **S3 — four PRs in dep order A → C → B → D — with the 108-raw-SQL migration folded into Track A (option a).**

### Why S3 over S1 and S2

**Against S1 (bundled)**:
- ROADMAP §M7 is the terminal milestone — the v1.0 tag commits are the long-tail-maintained snapshot. A bundled 160-file PR squashes into a changelog entry that conflates four decision axes (store, detect-secrets, debt, dogfood). release-please's changelog hygiene (`.release-please-config.json:3` type: node) favors one logical decision per squash.
- hash_parity_risk is Medium under S1, Low under S3. Hard rail #6 ("graphHash byte-identical every commit") means per-commit discipline is the same across strategies, but per-PR review quality is not. When a single PR bundles store-flip (A), edge-kind append (C4), `stringArrayField` fix (C2), SCIP REFERENCES emission (C4), and an ADR, the reviewer (who is also the author, per `ROADMAP.md:5` "1 active user") cannot cleanly separate "is the hash still parity-consistent?" from "is the detect-secrets SARIF converter correct?".
- Bisect granularity. v1.0 regressions have an extremely long tail — 6 months post-tag a user hits a bug in `codehub verdict` that turns out to trace to a 108-SQL mis-migration. Under S1, `git bisect` lands on a single 20+ commit squash. Under S3, it lands on Track A's squash.

**Against S2 (risk-split)**:
- S2 is a local improvement on S1, not a structural improvement. It buys hash-quarantine at the cost of bundling detect-secrets, dogfood, READMEs, eviction, and SageMaker into one "polish" PR that is itself 30-70 files of heterogeneous concerns.
- The prior-PR precedent (PR #53, #64, #68) bundled *two milestones* per PR. S2's "core" is structurally one milestone (M7) plus associated hash-touching debt — identical in scope to prior precedent. "Polish" is novel — prior precedent did not ship "polish" PRs separately from milestone PRs. So S2 partially breaks precedent without capturing S3's bisect-granularity win.
- S3 additionally separates constraint-10 compliance (detect-secrets) from detect-secrets-adjacent dogfood (self-scan.yml that will exercise detect-secrets). Landing B before D means D's self-scan workflow immediately has the 20-scanner surface to exercise.

**For S3**:
1. **Hash invariant U1 is per-commit, not per-PR** (hard rail #6). S3 does not change per-commit discipline but concentrates hash-touching work in two PRs (A, C) that are reviewed with hash-awareness primed. B and D reviewers can trust the packet's file-path screen and skip re-verifying hash parity.
2. **Bisect granularity matches the finalize scope**. v1.0 ships four distinct capabilities (lbug default, 20 scanners, debt cleared, dogfood polish). A post-tag regression in one capability should rollback only that capability. S3 delivers rollback granularity aligned to capabilities.
3. **ADR 0013 lives in A alone**. The decision about LadybugDB default + pluggability escape-hatch guidance is an M7 decision. Separating it from debt and dogfood lets the ADR be cited crisply from future milestone planning.
4. **release-please 1-release-PR workflow handles S3 cleanly**: four merges to `main` during the finalize window, one release PR auto-updated on each merge, cut v1.0 after D lands. `.release-please-config.json` already supports this (per `explore-ci.yaml:section_1.release-please.yml:49-56`).
5. **The single-user rip-and-replace latitude does not argue for bundling**. The latitude removes *breaking-change budget constraints* on API surfaces. It does not argue against PR hygiene. Bundling is a review-ergonomics choice, not a user-contract choice. Four small PRs are easier to re-review if future context-compaction drops the early review state.
6. **Prior precedent of bundled PRs was milestone-*bundle*, not debt-and-dogfood-bundle**. PR #53 bundled M1+M2 (two milestones); PR #64 bundled M3+M4 (two milestones); PR #68 bundled M5+M6 (two milestones). **M7 has no paired milestone to bundle with** — the finalize scope is M7 + adjacent debt + dogfood, not "M7 + M8". So precedent does not mandate bundling here; it mandates "ship M7 in one coherent unit", which Track A satisfies.

### Commit-level discipline inside Track A (the riskiest PR)

Because Track A is the longest (≈150-160 files with 108-SQL folded), its commit sequence matters disproportionately. Recommended sequence, each passing graphHash parity + `mise run check`:

1. Hoist column encoders + dedupeLastById + nodeToRow/nodeToParams into `@opencodehub/storage/src/column-encode.ts` (`explore-storage.yaml:shared_helpers:140-142`).
2. Hoist parity rebuilders into `@opencodehub/storage/test-utils` (`explore-storage.yaml:test_fixtures.third_party_adapter_reuse:185-195`).
3. Add CochangeStore + SymbolSummaryStore impls on `GraphDbStore` (remove `NotImplementedError` at `graphdb-adapter.ts:881-916`).
4. Rename `IGraphStore.query` → `rawQuery` (interface-shape only; no semantic change).
5. Replace 41 concrete-class type pins with `IGraphStore` (type-only edits across `cli/`, `mcp/`).
6. Introduce typed finder methods on `IGraphStore` (listNodesByKind, listEdgesByType, traverseAncestors, listDependencies, listFindings, countNodesByKind per `explore-storage.yaml:summary_for_spec.priority_1_fixes:288`).
7. Migrate 108 raw-SQL sites, one subsystem per commit: `analysis/` → `mcp/` → `pack/+wiki/` → `cli/`.
8. Rewrite `analysis/src/test-utils.ts:214-482` to be backend-shape-agnostic (use typed finders).
9. Generalise `packages/storage/src/paths.ts:14` — replace `DB_FILE_NAME='graph.duckdb'` with per-backend `describeArtifacts()` or similar (`explore-storage.yaml:schema_name_leaks:269-272`).
10. Extend `cli/doctor.ts:217-247` to probe every registered backend (`explore-storage.yaml:doctor_asymmetry:278-279`).
11. Promote `exportEmbeddingsParquet` — decide: add to interface as `exportEmbeddingsToSidecar(path)` OR move sidecar emission into `packages/pack/` with a generic `listEmbeddings()` (`explore-storage.yaml:summary_for_spec.priority_0_blockers:286`).
12. Flip `CODEHUB_STORE=lbug` default in `packages/storage/src/factory.ts` + update `packages/cli/src/commands/open-store.ts`.
13. Drop dual-emit `sql|cypher` → `cypher`-only from MCP tool `packages/mcp/src/tools/query.ts` + any other dual-emit site (T-M7-3).
14. ADR 0013 (`docs/adr/0013-m7-ladybugdb-default.md`) — flip rationale + pluggability escape-hatch guidance per research on Apache AGE / Memgraph / Neo4j / Neptune at `research-graphdb-backends.yaml:igraphstore_union_surface:309-341`.

### Commit-level discipline inside Track C (the hash-touching debt PR)

1. C6: one-line `.gitmodules` close-out in `.erpaval/debt.md` (mark as stale — file removed when `packages/gym` extracted per `explore-debt.yaml:section_6_readmes_and_gitmodules.gitmodules.history_note:294-296`).
2. C5: 4 READMEs — `packages/cli/README.md`, `packages/mcp/README.md`, `packages/ingestion/README.md`, `packages/scanners/README.md`. Template: `packages/policy/README.md` middle-ground per `explore-debt.yaml:readme_template_candidates:275-289`.
3. C1: parse-cache eviction pass. New function in `content-cache.ts`; default cap derived from existing `computeCacheSize` telemetry (`explore-debt.yaml:section_2_parse_cache_eviction.cache_stats_current:93-100`); 16-test suite already exists in `content-cache.test.ts` — extend with eviction tests.
4. C3 item 2: `defaultOpenEmbedder` consolidation. Extract to `packages/embedder/src/factory.ts` or add `openEmbedderFromEnv()` to `packages/embedder/src/index.ts` per `explore-debt.yaml:section_4.factory_candidate:174-175`. Update 3 call sites (`mcp/tools/query.ts:453`, `cli/commands/query.ts:122`, `ingestion/pipeline/phases/embeddings.ts:514-537`).
5. C3 item 1: rebuild-on-switch refusal. New `embedder_model_id` column on `store_meta` per `explore-debt.yaml:section_4.rebuild_on_switch_implication:201`. **This DOES touch graphHash** because it adds a column to `schema-ddl.ts`. Bump `SCHEMA_VERSION`. Parity suite needs fixture regen OR the field must be excluded from hash input. Safer: exclude from hash input (`store_meta` is per `explore-storage.yaml:test_fixtures.parity_assertion` not part of the graph proper).
6. C2: `stringArrayField` symmetry fix. Choose one behavior — either writer preserves `[]` as explicit empty (requires `TEXT[]` NOT NULL or a sentinel) OR reader's early-return is made explicit in interface docs. Recommended: document the round-trip convention in `interface.ts` (per `explore-storage.yaml:summary_for_spec.priority_2_nice_to_have:294-296`) and add a test that asserts the `[]` → absent round-trip is stable across both adapters.
7. C4: SCIP REFERENCES + TYPE_OF emission. This is the commit with the one-time hash delta. Steps:
   - Append `TYPE_OF` to `packages/core-types/src/edges.ts` RELATION_TYPES tail (position 25 — after OWNED_BY, per `research-detectsecrets-scip.yaml:thread_2.proposed_edge_kinds.read_write_split_option:223`).
   - Widen `isFunctionLike` filter at `packages/scip-ingest/src/derive.ts:136` to emit non-call REFERENCES.
   - Add `emitRelations` call at `packages/ingestion/src/pipeline/phases/scip-index.ts:252` to consume `derived.relations` (`explore-debt.yaml:section_5_scip_references_and_heritage.emit_to_graph_call_site:232-236`).
   - Regenerate `incremental-determinism.test.ts` fixtures per `research-detectsecrets-scip.yaml:thread_2.graph_hash_impact.caveats`.
   - Bump SCHEMA_VERSION in store_meta + document as schema minor bump.

### Commit-level discipline inside Tracks B and D

Both are structurally small (Track B ≈ 6 files, Track D ≈ 8-10 files) and hash-neutral. Normal commit hygiene — one commit per logical unit, tests in the same commit as the feature.

### Hard rail compliance check

| Hard rail | Compliance under S3/a |
|---|---|
| Stdio-only, no HTTP | Preserved; no track touches HTTP surfaces |
| No LLM in query path | Preserved; C3 SageMaker work only touches embedder config, not query-path inference |
| graphHash byte-identical every commit | Preserved; A's commit sequence and C's commit sequence both run parity suite per-commit; only C7 (SCIP emission) and A step 12 (store flip) carry explicit hash deltas, each covered by fixture regen in the same commit |
| `mise run check` exit 0 | Preserved per commit; Track D changes `mise.toml` structure but doesn't change `check` target's dep list pre-flight |
| Deterministic code-pack | Preserved; Track D release-please addition uses existing code-pack CLI — no change to pack determinism |
| 20-scanner coverage | Reached when Track B merges |
| No time estimates | Honored — no track carries calendar language |

---

## 7. Second-order considerations

### 7.1 release-please interaction

`release-please-action@v5` with `release_type: node` (`explore-ci.yaml:section_1.release-please.yml:49-56`) opens a single auto-updated release PR per `main` branch. On each merge to `main` it re-evaluates conventional-commit footers and re-computes the version bump. Behavior under each strategy:

- **S1**: Single merge → release PR bumps major to v1.0.0 once. Clean changelog. Simplest.
- **S2**: Two merges → release PR re-renders twice; final changelog consolidates both. Clean.
- **S3**: Four merges → release PR re-renders four times. The v1.0 tag cuts once, after D merges. Main risk: if A merges with a `feat!:` footer (major bump trigger) and the repo was pre-1.0, release-please auto-opens a v1.0 release PR early — before B, C, D land. Mitigation: add `Release-As: 1.0.0` footer only to D's squash, and use `feat:` (not `feat!:`) on A's squash even though it is a breaking change (the rip-and-replace latitude per `ROADMAP.md:217-219` permits this since there is 1 user).

### 7.2 Banned-strings guardrail interaction

`scripts/check-banned-strings.sh` (referenced at `explore-ci.yaml:section_1.ci.yml:18` and `debt.md:210-215`) blocks `ladybug` and `kuzu` literals in tracked source; `@ladybugdb/core` dep in `package.json` is permitted per package-scope precedent (`ROADMAP.md:63`). ADR 0013 under Track A must be careful not to introduce the blocked literals in narrative; use `GraphDbStore` / `graphdb-adapter` phrasing as the rest of the codebase does. Same constraint applies across all three strategies — no differential impact.

### 7.3 Lefthook-polish pre-push interaction under S3

Under S3, Track D's lefthook polish merges last — which means A, C, and B all develop against the current (pre-polish) lefthook. That's fine; the current hook runs `pnpm -r exec tsc --noEmit` and `pnpm -r test` on every push (`explore-ci.yaml:section_2_lefthook_current_shape:108-109`). The larger concern is that Track D adds a `pnpm-lock.yaml` freshness gate (`explore-ci.yaml:section_2.gaps_relative_to_claude_sql_pattern:119`). If A's CochangeStore/SymbolSummaryStore implementation requires a new dep on the `@ladybugdb/core` binding surface, the lockfile updates in A and D's gate would rightly flag it. Under S1 or S2, this lands atomically; under S3 a pre-D rebase on `main` picks up the new lockfile cleanly.

### 7.4 Parity-test CI cost

`graph-hash-parity.test.ts:1-638` exercises five fixtures (small, medium, large, repo, repo-null per `explore-storage.yaml:test_fixtures.fixtures`). Large fixture has ≥500 nodes + one edge of each of the 24 relation kinds (`test_fixtures.fixtures:177`). `assertParity` computes `duckHash === graphDbHash === graphHash(fixture)` byte-identically with both adapters. Under S3 the parity suite runs on every commit of every PR's CI — more total CI minutes than S1 but identical per-commit cost per-commit. The `hasGraphDbBinding()` gate (`test_fixtures.parity_assertion.skip_strategy:184`) lets the test pass on machines without `@ladybugdb/core`; CI must have the binding installed or the parity gate silently becomes a single-adapter check. Verify CI config pins `@ladybugdb/core@0.16.1` per `ROADMAP.md:63`.

### 7.5 Incremental-determinism fixture regeneration under C4

The one-time fixture regen for C4 (TYPE_OF append + REFERENCES emission on non-function symbols) lands in `packages/ingestion/src/pipeline/incremental-determinism.test.ts` per `research-detectsecrets-scip.yaml:thread_2.graph_hash_impact.caveats:254`. Under S3, this fixture lands in Track C's squash; under S2 it lands in `core`'s squash; under S1 it lands buried in the bundled squash. Bisect story: if a user hits an incremental-determinism drift post-v1.0, S3 bisect lands on Track C's squash and the ADR for TYPE_OF is directly visible; S1 bisect lands on the bundled squash and the TYPE_OF append is one of ~20 commits.

### 7.6 Track D `self-scan.yml` exercises the finalize tree

Per `explore-ci.yaml:section_5.shape_for_self_scan_workflow`, the recommended `self-scan.yml` pipeline runs `codehub analyze` → `codehub scan` → upload SARIF at `.codehub/scan.sarif` with category `opencodehub-self`. Under S3/a (Track D merges last), `self-scan.yml` runs once post-merge against the full finalize tree — **this is the first real-world end-to-end validation** of:
1. LadybugDB default flip (A) with typed finders (A's 108-SQL migration).
2. detect-secrets wrapper (B) emitting SARIF through `codehub scan`.
3. SCIP REFERENCES + TYPE_OF edges (C4) influencing `codehub verdict` blast-radius computation.
4. Lefthook polish (D) not blocking `mise run check` on the CI runner.

Under S1 or S2, this end-to-end validation happens in-branch pre-merge, which is also fine but gives less post-merge confidence.

### 7.7 ADR 0013 scope

ADR 0013 carries the M7 flip rationale + pluggability escape-hatch guidance. The escape-hatch guidance is grounded in `research-graphdb-backends.yaml:igraphstore_union_surface:309-341` (Apache AGE, Memgraph, Neo4j, Neptune viability matrix) and `compatibility_risks.local_first_violation.conclusion:360` — "None of the four can be in-process. OCH's default store remains correct; these four are ALL opt-in selectors behind `CODEHUB_STORE=<name>` and ALL need a process-lifecycle hook in the adapter SPI". The ADR should:

1. State the flip decision — `CODEHUB_STORE=lbug` as default per T-M7-1, DuckDB retained only for temporal analytics per T-M7-2.
2. Document the typed-finder surface introduced in Track A as the stable IGraphStore contract for v1.0.
3. Reference `research-graphdb-backends.yaml:igraphstore_union_surface` as the minimum pluggability floor for community adapters.
4. Call out the four known hash-determinism compatibility risks (`compatibility_risks.hash_determinism:347-351`) so future adapter contributors inherit the U1 invariant.
5. Acknowledge that the four researched backends all require a process-lifecycle hook that OCH does not yet expose — defer the `spawn()/waitReady()/shutdown()` SPI to post-v1.0.

Same content regardless of strategy; only the PR container differs.

### 7.8 Rip-and-replace latitude — what it does and does not grant

ROADMAP §"Rip-and-replace latitude" (lines 217-219) explicitly sanctions rip-and-replace. What it does NOT do:

- It does NOT grant freedom from U1 (graphHash byte-identity) — that is hard rail #6 explicitly preserved.
- It does NOT grant freedom from constraint 5 (`mise run check` exit 0 per commit).
- It does NOT grant freedom from constraint 10 (20-scanner coverage) — which is why Track B is finalize-wave work, not post-tag.
- It does NOT change the MCP tool contract stability expectation (`ROADMAP.md:217-219`) — tools may be renamed or replaced as long as the skill layer is updated in the same change. Under Track A, when the MCP `query` tool drops dual-emit `sql|cypher` → `cypher`-only, the skill at `plugins/opencodehub/skills/opencodehub-guide/` must update in the same PR.

What it DOES grant:
- Freedom to change `IGraphStore.query` signature (typed finders + `rawQuery` rename) without a deprecation window.
- Freedom to change `packages/storage/src/paths.ts:DB_FILE_NAME` without migration scripts.
- Freedom to change `CODEHUB_STORE` default in a single commit.

All three strategies honor U1 and constraint 5; all three reach constraint 10; all three preserve the MCP-tool/skill same-commit coupling. The latitude is orthogonal to the strategy choice.

### 7.9 Prior-PR precedent — a closer reading

Prior bundles were not arbitrary:
- PR #53 bundled M1 (stabilize) + M2 (repo split / policy / wiki-split). Both are foundational milestones; M2 depended on M1's fast-path guard. The bundle reduced rebase cost on the freshly-split repo.
- PR #64 bundled M3 (LadybugDB phase-1) + M4 (language expansion). Parallel milestones per `ROADMAP.md:27`; no dependency between them; bundled because both land in the same CI matrix epoch (Node 22/24 per `704fd67`).
- PR #68 bundled M5 (deterministic code-pack) + M6 (cross-repo federation). Parallel milestones per `ROADMAP.md:27`; bundled because both land the `Repo` entity's first-class graph role.

Pattern: two milestones per PR when they were *strongly coupled* or *parallel and co-validated*. **M7 has no paired milestone** — v1.0 finalize is M7 + adjacent cleanup, structurally different from all three prior bundles. This weakens the precedent-for-bundling argument. A natural reading of the precedent is "ship each milestone-sized unit atomically" — which maps to S3's Track A atomically carrying M7.

---

## 8. What could go wrong (pre-mortem by strategy)

### 8.1 If S1 (bundled) is chosen

- Risk: late-stage discovery that `exportEmbeddingsParquet` promotion breaks `packages/pack/src/embeddings-sidecar.ts:77-113` structural-typing assumption. Under S1, fix lands in commit N+1 of the already-large PR; reviewer has to re-read 160 files. Under S3, fix is a small amendment to A's open PR.
- Risk: reviewer fatigue causes skim-review of the 108-SQL migration; a mis-translated `WITH RECURSIVE USING KEY (ancestor_id)` Cypher (per `explore-storage.yaml:duckdb_leaks.outside_storage_leaks.analysis:64`) passes review, fails at user runtime after tag.
- Risk: Track D's `lefthook.yml` rewrite breaks local dev loop during development of Track A; bisect-within-branch is harder than bisect-across-PRs.

### 8.2 If S2 (risk-split) is chosen

- Risk: `polish` PR's scope is heterogeneous (detect-secrets + CI + lefthook + READMEs + eviction + SageMaker). Reviewer is forced to context-switch across 6 unrelated file-path hot zones.
- Risk: `core` contains both C2 and C4 plus all of A — effectively S1's body minus Track B and non-hash debt. Still a large PR (~155 files).
- Risk: intermediate `main` state post-`core` has `CODEHUB_STORE=lbug` + 19 scanners, which fails constraint-10 if release-please accidentally cuts v1.0-rc before polish lands.

### 8.3 If S3 (track-split) is chosen

- Risk: 4 PR cycles inflate clock time; if a merge-train race happens (unlikely with 1 user) conflicts compound.
- Risk: inter-PR rebase on A's 41 type-pin changes is a mechanical chore but real — C3's `defaultOpenEmbedder` extraction touches `cli/src/commands/query.ts:122` which A also edits.
- Risk: release-please opens a v1.0-rc release PR after A merges (first `feat!:` footer). Mitigation documented in §7.1.
- Risk: intermediate `main` states between A, C, B, D — if a user pulls from `main` mid-sequence, they get a partial finalize tree. With 1 active user (the author), this is a self-managed risk.

### 8.4 Shared risks (all strategies)

- Risk: hash-determinism drift via unexercised SQL-migration site. The parity suite fixtures (small, medium, large, repo, repo-null) exercise a specific subset of edge kinds and node kinds; a finder migration that mishandles a rare combination (e.g., `kind='Finding'` filter in `list-findings.ts`) won't surface until user runtime. Mitigation: expand parity fixtures to cover Finding + Dependency + SCIP-derived edges.
- Risk: SageMaker #1 rebuild-on-switch refusal adds `embedder_model_id` to `store_meta` but the migration check triggers on existing indexes; first-run after upgrade hits a missing-field error. Mitigation: `readCacheEntry`-style tolerance on missing field (treat as "unknown embedder, force rebuild").
- Risk: C4 TYPE_OF emission misses an edge case in `derive.ts:184-199`'s `collectRels` (e.g., Sorbet-emitted Ruby SCIP with both `is_implementation=true` and `is_type_definition=true` on the same Relationship). Mitigation: test fixture carrying both bits simultaneously.

---

## 9. Decision table (one-row summary)

| Axis | Weight for v1.0 finalize | S1 score | S2 score | S3 score |
|---|---|---|---|---|
| Hash parity safety | High | 3/5 | 4/5 | 4/5 |
| Bisect granularity | High | 1/5 | 3/5 | 5/5 |
| Reviewer fatigue | Medium | 1/5 | 3/5 | 4/5 |
| Precedent fit | Low | 5/5 | 3/5 | 2/5 |
| Rollback surgical | High | 1/5 | 3/5 | 5/5 |
| ADR narrative quality | Medium | 2/5 | 4/5 | 5/5 |
| release-please friction | Low | 5/5 | 4/5 | 3/5 |
| **Weighted conclusion** | — | **2.3/5** | **3.4/5** | **4.2/5** |

Weights: High=3, Medium=2, Low=1. S3 dominates on the high-weight axes (hash safety, bisect, rollback) with only mild losses on precedent and release-please friction — both of which are low-weight for a terminal milestone where cleanup hygiene matters more than ceremony continuity.

---

## 10. Summary for Gate 1 approval

- **Recommended strategy**: **S3 — four PRs, order A (M7) → C (debt) → B (detect-secrets) → D (dogfood)**.
- **Recommended 108-SQL disposition**: **(a) fold into Track A**. The typed-finder migration is a blocking dependency of the store-default flip; deferring creates a v1.0 with silent tool-degradation.
- **Track A**: largest PR in the sequence (~150-160 files). Mitigated by per-subsystem commit sequencing so git bisect granularity survives squash-merge.
- **Track C**: carries the one-time graphHash delta (C4 TYPE_OF emission). Fixture regen + SCHEMA_VERSION bump in the same commit.
- **Tracks B + D**: small, hash-neutral, reviewable in a single pass each.
- **ADR 0013** lives exclusively in Track A.
- **release-please hygiene**: keep the auto-opened release PR closed through A/C/B; let it cut v1.0 after D merges. changelog conveys four clean logical units rather than one megacommit.
- **Gate 1 ask**: approve S3/A-C-B-D-(a). Enter Gate 2 with four draft EARS specs — one per track.

---

## 11. Gate-2 handoff notes (EARS spec seeds)

Four EARS specs, one per track. Each inherits its track's packet citations as source of truth. Skeleton seeds below — content stays terse so the spec writer's work is structured framing, not synthesis.

### 11.1 Track A spec seed — `feat/v1-finalize-a-m7`

- **Ubiquitous**: The system SHALL default `CODEHUB_STORE` to `lbug` when no env override is present.
- **Ubiquitous**: The system SHALL expose `IGraphStore` typed finder methods (listNodesByKind, listEdgesByType, traverseAncestors, listDependencies, listFindings, countNodesByKind) and SHALL NOT accept raw SQL through the default store interface.
- **Event-driven**: WHEN `openStore()` is called WITH `backend: 'auto'`, the system SHALL resolve to `GraphDbStore` unless `CODEHUB_STORE=duck` is set.
- **State-driven**: WHILE `CODEHUB_STORE=lbug` is the active backend, `graphHash(graph) === graphHash(rebuildFromGraphDb(store))` MUST hold for every fixture in `graph-hash-parity.test.ts`.
- **Unwanted-behavior**: IF any call site passes a raw SQL string to `IGraphStore.rawQuery` (post-rename), the TypeScript build SHALL fail at compile time via type narrowing.
- **Optional-feature**: WHERE `exportEmbeddingsParquet` is needed, the system SHALL expose a portable sidecar emitter on IGraphStore OR move sidecar emission into `packages/pack/` with a generic `listEmbeddings()` read path.

### 11.2 Track B spec seed — `feat/v1-finalize-b-detect-secrets`

- **Ubiquitous**: The system SHALL register `detect-secrets` as the 20th Priority-1 scanner in `packages/scanners/src/catalog.ts`.
- **Event-driven**: WHEN `codehub scan --scanners detect-secrets` is invoked, the system SHALL shell out to `detect-secrets scan` and convert native JSON output to SARIF 2.1.0.
- **Unwanted-behavior**: IF `detect-secrets` is not on PATH, the wrapper SHALL emit an empty SARIF with `skipped: 'not found on PATH'` matching the existing wrapper convention at `packages/scanners/src/wrappers/shared.ts:66-101`.
- **Optional-feature**: WHERE `hashed_secret` is present in a native finding, the converter SHALL surface it as `partialFingerprints` on the SARIF result WITHOUT advertising it as cryptographic.

### 11.3 Track C spec seed — `feat/v1-finalize-c-debt`

- **Ubiquitous**: The system SHALL ship READMEs for `packages/cli`, `packages/mcp`, `packages/ingestion`, `packages/scanners` following the `packages/policy/README.md` template shape.
- **Ubiquitous**: The system SHALL append `TYPE_OF` to `RELATION_TYPES` at the tail position AFTER `OWNED_BY` (position 25).
- **Ubiquitous**: The system SHALL emit `REFERENCES` edges for SCIP occurrences lacking the Definition bit on non-function-like symbols.
- **State-driven**: WHILE the parse cache exceeds a configurable size ceiling, the system SHALL evict least-recently-used entries via a new eviction pass wired into `computeCacheSize`'s return value.
- **Event-driven**: WHEN `codehub analyze` starts AND the stored `embedder_model_id` in `store_meta` differs from the current embedder's modelId, the system SHALL refuse with a clear message UNLESS `--force-backend-mismatch` is passed.
- **Ubiquitous**: The `defaultOpenEmbedder` dance SHALL exist in exactly one location (`packages/embedder/src/factory.ts` or `packages/embedder/src/index.ts` as `openEmbedderFromEnv`), consumed by MCP, CLI, and ingestion call sites.
- **Unwanted-behavior**: IF `stringArrayOrNull([])` is called in the write path, the reader SHALL produce the same absence/presence result across both DuckDB and GraphDb adapters (symmetry check).

### 11.4 Track D spec seed — `feat/v1-finalize-d-dogfood`

- **Ubiquitous**: The repository SHALL provide `.github/workflows/semgrep.yml` with `p/auto` + `p/owasp-top-ten` configs and a weekly cron.
- **Ubiquitous**: The repository SHALL provide `.github/workflows/osv.yml` as a standalone workflow (split out of `ci.yml:94-117`) with `category: osv-scanner` on SARIF upload and a weekly cron.
- **Ubiquitous**: The repository SHALL provide `.github/workflows/self-scan.yml` mirroring the `github-weekly.yml` template with SARIF output at `.codehub/scan.sarif` and category `opencodehub-self`.
- **Event-driven**: WHEN release-please publishes a release, the workflow SHALL attach the deterministic code-pack BOM as a release asset mirroring the `sbom.yml:24-28` pattern.
- **Ubiquitous**: The `lefthook.yml` SHALL declare `min_version: 2.1.6`, `assert_lefthook_installed: true`, `glob_matcher: doublestar`, an `output` block, `fail_text` on every job, priority ordering on pre-commit jobs, `skip: [merge, rebase]` on typecheck and test, pre-push `files: "git diff --name-only @{push} HEAD || git diff --name-only HEAD~"`, and a `pnpm-lock.yaml` freshness gate.
- **Ubiquitous**: `mise.toml` SHALL provide `och:self-analyze`, `och:self-scan`, `och:self-verdict`, `och:self-pack` tasks AND SHALL wire `scripts/pack-determinism-audit.sh` into a `pack:determinism` task included in `check:full` or `acceptance` dependency lists.

---

## 12. Closing note

The recommendation above rests on three observations from the packet set:

1. The 108-raw-SQL migration is not optional. Deferring it creates a v1.0 where the nominal default store flip produces silent tool degradation — a product quality floor violation that no amount of CI discipline catches, because the CI test-utils fake at `analysis/src/test-utils.ts:214-482` preserves the DuckDB dialect assumption.
2. graphHash byte-identity is a per-commit invariant, not a per-PR invariant. Splitting across 4 PRs does not change per-commit discipline; it only changes per-PR review quality and bisect granularity.
3. Prior bundled-PR precedent was *milestone-bundle* (pairs of milestones), not *debt-and-dogfood-bundle*. M7 as a terminal milestone with adjacent cleanup is structurally novel in this repo's PR history, weakening the precedent-for-bundling argument.

Reviewer sign-off on S3/A-C-B-D-(a) enters Gate 2 with four EARS spec seeds above. Gate 2 work is deterministic code production, one track at a time, A first.
