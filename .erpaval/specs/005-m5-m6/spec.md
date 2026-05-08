# EARS Spec 005 — M5 Deterministic code-packs + M6 Cross-repo federation

**Session**: session-e1d819 · **Branch**: `feat/v1-m5-m6` (to be cut from `main` after PR #64 lands) · **Parent roadmap**: `.erpaval/ROADMAP.md` §M5 + §M6

**Decision:** run M5 and M6 as parallel tracks per the roadmap dependency graph `M5 ∥ M6`. M5 is greenfield (`@opencodehub/pack` doesn't exist); M6 is ~70% shipped (5 group MCP tools, `codehub-contract-map` skill, single-repo `AMBIGUOUS_REPO` sentinel all exist on main).

## Context (Explore + Research consolidated)

Full detail in `.erpaval/sessions/session-e1d819/explore.yaml` and `research-m5m6.yaml`.

### M5 — deterministic code-packs

- `@opencodehub/pack` is **greenfield** — `packages/pack/` doesn't exist. ROADMAP §`Target package layout` already lists it.
- `packages/mcp/src/tools/pack-codebase.ts` is a thin repomix wrapper (`pack_codebase` MCP tool at L40-105) — **NOT** the 9-item BOM. Prior lesson `repomix-is-output-side` explicitly bans substituting repomix for a tree-sitter chunker.
- **PageRank lift is safe** — `pagerank(adj, damping=0.85, iterations=50): Float64Array` at `packages/scip-ingest/src/materialize.ts:115-149` computes into `BlastMetrics.pagerank` (L17) which has **zero downstream consumers** (grep-verified). `Adjacency` (L48-54) + `buildAdjacency` (L56-93) must move or be re-exported. Fixed-iteration (not tolerance-based) is the determinism-safe shape — do NOT adopt `graphology-metrics`.
- **AST chunker**: `@chonkiejs/core v0.0.9 (MIT)` is the only OSS chunker that emits byte offsets. LangChain's `fromLanguage` splitter rejected — no byte offsets, heuristic separators that drift across LangChain releases. The 15 OCH tree-sitter grammars stay owned; chonkie is the budget-aware layer only.
- **Parquet sidecar**: DuckDB's `COPY (SELECT id, vec FROM ... ORDER BY id) TO 'x.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)` — OCH already depends on DuckDB; zero new dep surface. DuckDB v1.3.0+ rewrote the writer with no implicit timestamps. `@dsnp/parquetjs` kept as fallback; `parquet-wasm` kept as escape hatch.
- **Tokenizer ID convention**: `vendor:name@pin` — `openai:o200k_base@tiktoken-0.8.0`, `anthropic:claude-opus-4-7@2026-04`, `hf:Xenova/claude-tokenizer@sha-<12>`. Anthropic ships no local tokenizer (only `messages.count_tokens` API). A silent Anthropic tokenizer rotation drifted counts ~47% in Apr-2026, so the Claude lane is explicitly `determinism_class: best_effort`; the OpenAI lane is `strict`.
- **Hashing**: canonical-JSON (RFC 8785-shaped) + SHA-256 hex. OCH's existing `graphHash` helper (`packages/core-types/src/graph-hash.ts`) is already the right pattern — extend `writeCanonicalJson` usage to the BOM manifest. File bytes hashed raw (no canonicalization); pack_hash wraps file hashes in canonical JSON envelope. Per-file hashes from file bytes; normalize CRLF → LF at ingest (not at hash time).

### M6 — cross-repo federation

- **Already shipped** on main (M3+M4 PR #64): `group_list`, `group_contracts`, `group_query`, `group_status`, `group_sync` MCP tools; `packages/cli/src/groups.ts` CLI; `plugins/opencodehub/skills/codehub-contract-map/SKILL.md` (group-only, pre-checks `group_status`, already emits Mermaid flowchart + N×N matrix per spec 001 AC-3-4, AC-5-5).
- **Not shipped** on main: first-class `Repo` NodeKind; engine-side `crossRepoLinks` emission in `.docmeta.json`; group-context `AMBIGUOUS_REPO` extension.
- **Current repo identity** is runtime-only: `packages/mcp/src/repo-resolver.ts:24-31` `RegistryEntry{name, path, indexedAt, nodeCount, edgeCount, lastCommit?}` backed by `~/.codehub/registry.json`. `ProjectProfile` node (`core-types/src/nodes.ts:487-506`) is the closest graph-side proxy (singleton-per-repo with `languages`, `frameworksDetected`, `srcDirs`).
- **`AMBIGUOUS_REPO` already exists** at `repo-resolver.ts:41,96-100` (thrown when `>1` repos registered and `repo` arg omitted; documented at `server.ts:64` and `AGENTS.md:26-29`; round-tripped in `error-envelope.test.ts:39-47`). M6 extends it with **structured `choices[]` + `total_matches` cap=10** (research decision) and **group context**.
- **`codehub-document --group` already has cross-repo skeletons** seeded in Phase 0 (SKILL.md:94-98) and the See-also footer requirement at SKILL.md:125. **Engine-side emission** of machine-readable `crossRepoLinks` in `.docmeta.json` is unshipped — grep for `cross_repo_links`/`crossRepoLinks` returns zero hits.
- **Repo entity attributes** (9): `origin_url`, `repo_uri`, `default_branch`, `commit_sha`, `index_time`, `group`, `visibility`, `indexer`, `language_stats`. Synthesizes Sourcegraph URI scheme + SCIP `Metadata.toolInfo`.
- **Mermaid**: `flowchart LR` + per-repo `subgraph`, edge-labelled `|VERB /path|`, Mermaid v11 (GH-rendered), cap ~80 nodes per diagram. `C4Component` rejected (experimental, diverges from PlantUML). This is already the shape in `codehub-contract-map`; M6 stays on it.

### Convention & guardrail constraints

- **`commitlint.config.mjs`** scope-enum lacks `pack`. **Must add `pack` to `scope-enum` in the first M5 commit** (prior-session lesson: "new packages need scope-enum update in their first commit"). No M6 scope additions needed (`analysis`, `mcp`, `cli`, `core-types`, `storage` cover everything M6 touches).
- **`scripts/check-banned-strings.sh`**: literals `STEP_IN_PROCESS, heuristicLabel, codeprobe, STEP_IN_FLOW, kuzu, ladybug, duckpgq`; excludes `scripts/check-banned-strings.sh`, `vendor/`, `pnpm-lock.yaml`, `.erpaval/`, `docs/adr/`. **No new banned-string collisions** for M5 or M6 (`pack`, `repo`, `group`, `contract` all safe).
- **Worktree + biome collision** (MEMORY.md): sibling worktrees with their own `biome.json` roots cause root-config collisions on root-level `mise run check`. Act subagents on parallel worktrees **must remove sibling worktrees before `mise run check`** OR scope check to specific packages via `--filter`.
- **Worktree native-binding failures** (MEMORY.md): 14 ingestion tests fail in agent worktrees but pass on main. Treat pnpm-install-in-worktree test failures as expected; **verify regressions on main, not in worktrees**.
- **`mise run check`** = `lint` (biome) → `typecheck` (`pnpm -r exec tsc --noEmit`) → `test` (depends on build, then `pnpm -r test`) → `banned-strings`. `check:full` adds `licenses` + `osv`.
- **`graphHash` byte-identity** (ROADMAP constraint 6) holds across M5+M6 iff: (a) no Repo node emitted unless explicitly constructed; (b) `RepoNode` appended at END of `NodeKind` union per nodes.ts:41-43 warning; (c) existing graphs are NOT backfilled with Repo nodes.
- **`@opencodehub/summarizer` is the only LLM-calling package** (ROADMAP constraint 2). No new LLM calls in M5 or M6.

## Ubiquitous requirements

- **U1**: `graphHash` byte-identity invariant MUST hold before and after every M5+M6 commit — existing `DuckDbStore` / `GraphDbStore` parity suite stays green.
- **U2**: `pack_hash` byte-identity invariant — same `(commit, tokenizer, budget, chonkie_version, duckdb_version, grammar_commits)` → same `pack_hash`. Verified by a determinism suite.
- **U3**: No tracked source file MUST introduce banned literals. `bash scripts/check-banned-strings.sh` MUST exit 0 post-commit.
- **U4**: `mise run check` MUST exit 0 after every commit.
- **U5**: Every new package MUST carry `@opencodehub/<name>` naming, Apache-2.0 license, `type: module`, `tsc --noEmit` clean.
- **U6**: No LLM calls outside `@opencodehub/summarizer`.
- **U7**: Every MCP tool and CLI output MUST remain deterministic (alpha-sort, lex-stable tiebreak) — preserves the existing group-query convention at `group-query.ts`.

## M5 — Event-driven requirements

- **E-M5-1**: When a user runs `codehub code-pack <repo> --budget <N>`, the CLI MUST produce a directory containing all 9 BOM items plus `manifest.json` at `<repo>/.codehub/packs/<pack_hash>/`.
- **E-M5-2**: When `pack_codebase` MCP tool is called with a pack-id arg, it MUST route through `@opencodehub/pack`, not `repomix`. The legacy repomix path stays available under an `--engine repomix` opt-in flag for one milestone, then removes in M7.
- **E-M5-3**: When `codehub code-pack` is called twice on the same `(commit, tokenizer, budget)`, every file under the output directory MUST be byte-identical on second run (cmp -s).
- **E-M5-4**: When the BOM is written, `manifest.json` MUST include `{commit, repo_origin_url, tokenizer_id, determinism_class, budget_tokens, grammar_commits, chonkie_version, duckdb_version, files[], pack_hash}` with `pack_hash = sha256(canonicalJson(all-other-fields))`.
- **E-M5-5**: When PageRank is computed, it MUST be at request time from the loaded `KnowledgeGraph` (per ROADMAP §Target package layout — "`@opencodehub/analysis` — request-time queries (PageRank, blast, impact)"), NOT at index time in `materialize.ts`. The dead-code `pagerank()` call at `materialize.ts:231` MUST be removed in the same commit that lifts the function.

## M5 — State-driven requirements

- **S-M5-1**: While `@chonkiejs/core` fails to install or load (native-binding unavailable on CI platform), `@opencodehub/pack` MUST degrade to a line-split fallback and stamp `determinism_class: degraded` in the manifest — NOT silently emit byte-different output claiming strict determinism.
- **S-M5-2**: While `tokenizer_id` names a Claude model, the manifest MUST set `determinism_class: best_effort` and the BOM verifier MUST warn when asked to check byte-identity against such a pack.
- **S-M5-3**: While the target repo has no embeddings computed, BOM item #7 (Parquet sidecar) MUST be absent entirely (not an empty file) and `manifest.files[]` MUST NOT list a path to it.

## M5 — Unwanted-behavior requirements

- **W-M5-1**: `@opencodehub/pack` MUST NOT call any LLM (enforced by the existing `scripts/check-banned-strings.sh`-style audit + a new `no-bedrock-outside-summarizer` test).
- **W-M5-2**: `codehub code-pack` MUST NOT emit writer metadata (DuckDB `created_by`, chonkie writer tags) as top-level fields in `manifest.json` — all tool-version pins live in a single `pins: {}` nested object so the BOM schema is stable across tool upgrades.
- **W-M5-3**: `codehub code-pack` MUST NOT use tolerance-based PageRank convergence — fixed iterations only.
- **W-M5-4**: CRLF files on Windows checkouts MUST NOT produce a different `pack_hash` than LF on Linux — ingest normalizes to LF before hashing content.

## M5 — Acceptance criteria

### AC-M5-0: commitlint scope-enum extension

- [ ] `commitlint.config.mjs` — add `pack` to `scope-enum`
- [ ] Verify by attempting `git commit -m "feat(pack): scaffold package"` (dry-run via husky commit-msg)
- **Dependencies**: none — **MUST land before any other M5 commit**
- [P]

### AC-M5-1: scaffold `@opencodehub/pack` workspace package

- [ ] `packages/pack/package.json` — `@opencodehub/pack`, Apache-2.0, `type: module`, deps: `@opencodehub/core-types`, `@opencodehub/analysis`, `@opencodehub/ingestion`, `@opencodehub/storage`, `@chonkiejs/core@^0.0.9`
- [ ] `packages/pack/tsconfig.json` — extends `tsconfig.base.json`, `include: ["src/**/*"]`
- [ ] `packages/pack/src/index.ts` — exports `generatePack(opts): Promise<PackManifest>` as the public entry point
- [ ] `packages/pack/src/types.ts` — `PackManifest`, `BomItem`, `PackOpts` interfaces
- [ ] Root `tsconfig.json` — add `{ path: "./packages/pack" }` to references
- [ ] Root `pnpm-workspace.yaml` — workspace already globs `packages/*`, no change needed
- [ ] `pnpm install` succeeds; `pnpm -r exec tsc --noEmit` stays clean
- **Dependencies**: AC-M5-0
- [P]

### AC-M5-2: lift PageRank from scip-ingest to @opencodehub/analysis

- [ ] `packages/analysis/src/page-rank.ts` — move `pagerank(adj, damping, iterations): Float64Array`, `Adjacency` interface, `buildAdjacency(edges): Adjacency` from `scip-ingest/src/materialize.ts`
- [ ] `packages/analysis/src/page-rank.test.ts` — determinism snapshot test: hash Float64Array hex output for a 10-node fixture; any platform drift fails
- [ ] `packages/scip-ingest/src/materialize.ts` — remove `pagerank()`, `Adjacency`, `buildAdjacency()`, `BlastMetrics.pagerank` (dead field); update the sole call site at L231 to a no-op or remove it if blast-score math at L255-264 can re-derive
- [ ] `packages/analysis/src/index.ts` — export `pageRank`, `buildAdjacency`, `Adjacency`
- [ ] `packages/scip-ingest/src/index.ts:29` — re-export `BlastMetrics` stays intact (type-only), pagerank field removed
- **Dependencies**: AC-M5-0
- [P]

### AC-M5-3: BOM manifest + hash helper

- [ ] `packages/pack/src/manifest.ts` — `buildManifest(bom, opts): PackManifest`; computes `pack_hash = sha256(canonicalJson({...manifest, pack_hash: undefined}))`
- [ ] Reuses `packages/core-types/src/hash.ts#canonicalJson`, `hashCanonicalJson`, `sha256Hex`, `writeCanonicalJson`
- [ ] `packages/pack/src/manifest.test.ts` — two runs on same inputs produce byte-identical manifest
- [ ] Audit `writeCanonicalJson` at `packages/core-types/src/hash.ts` for RFC 8785 number formatting compliance (no trailing zeros, no `+` exponent sign, lowercase `e`); fix + add test if non-compliant
- **Dependencies**: AC-M5-1
- [P]

### AC-M5-4: BOM items 2-4 — skeleton + file tree + deps

- [ ] `packages/pack/src/skeleton.ts` — PageRank-ranked symbol skeleton consuming `pageRank` from analysis + `Function`/`Class`/`Method` nodes from `IGraphStore.listNodes()`
- [ ] `packages/pack/src/file-tree.ts` — framework-labelled file tree consuming `ProjectProfile.frameworksDetected` (`core-types/src/nodes.ts:501`) + `FolderNode`/`FileNode`
- [ ] `packages/pack/src/deps.ts` — dependency graph / lockfile slice; reuse `dependencies` MCP tool logic (`packages/mcp/src/tools/dependencies.ts`) and `Dependency` NodeKind
- [ ] Byte-identity determinism for all three items (alpha-sort, lex-stable tiebreak)
- [ ] Unit tests for each with deterministic fixtures
- **Dependencies**: AC-M5-2, AC-M5-3
- [P]

### AC-M5-5: AST chunker + xrefs + findings + licenses

- [ ] `packages/pack/src/ast-chunker.ts` — wraps `@chonkiejs/core` CodeChunker; returns `{path, start_byte, end_byte, token_count}[]`; pins `chonkie_version` into manifest
- [ ] `packages/pack/src/xrefs.ts` — SCIP-grounded cross-refs; Community clusters (from `CommunityNode`) + call-graph slice from `CodeRelation{CALLS}`
- [ ] `packages/pack/src/findings.ts` — salient SARIF findings grouped by `{severity, rule_id}`; reuses `packages/sarif`
- [ ] `packages/pack/src/licenses.ts` — reuses `license_audit` MCP tool logic; LICENSES / NOTICES aggregation
- [ ] `packages/pack/src/readme.ts` — writes the BOM README.md with the full determinism contract
- [ ] Unit tests per module; all byte-deterministic
- **Dependencies**: AC-M5-4
- [P]

### AC-M5-6: Parquet embeddings sidecar via DuckDB COPY

- [ ] `packages/pack/src/embeddings-sidecar.ts` — queries `embeddings` table via DuckDB adapter, writes `COPY (SELECT node_id, granularity, chunk_index, vector FROM embeddings ORDER BY node_id, granularity, chunk_index) TO '<out>.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`
- [ ] Pins `duckdb_version` into manifest
- [ ] Sidecar absent when no embeddings exist (S-M5-3)
- [ ] Byte-identity test: two consecutive runs produce `cmp -s`-equal `.parquet` files (fixture: 100 rows × 384-dim float32 vectors)
- [ ] Test: sidecar absent when embeddings table empty
- **Dependencies**: AC-M5-5
- [P]

### AC-M5-7: `codehub code-pack` CLI + MCP tool

- [ ] `packages/cli/src/commands/code-pack.ts` — subcommand parsing (`--budget`, `--tokenizer`, `--out-dir`, `--engine repomix|pack`, default `pack`)
- [ ] `packages/cli/src/registry.ts` — register the new subcommand
- [ ] `packages/mcp/src/tools/pack-codebase.ts` — route through `@opencodehub/pack`'s `generatePack` when `--engine pack` (default); keep repomix path available under `--engine repomix` opt-in
- [ ] `packages/mcp/src/tools/pack-codebase.test.ts` — both engines tested; default-to-pack asserted
- [ ] Skill doc update if `pack_codebase` input schema changes
- **Dependencies**: AC-M5-6
- **Not [P]** — touches MCP tool in same file as CLI command wire-up

### AC-M5-8: Byte-identity determinism test suite

- [ ] `packages/pack/src/pack-determinism.test.ts` — full end-to-end: run `generatePack` twice, `cmp -s` every output file
- [ ] CI gate: suite runs as part of `mise run check`'s `test` step
- [ ] `scripts/pack-determinism-audit.sh` — shell-level audit script usable locally and in acceptance
- [ ] Add step to `scripts/acceptance.sh`
- **Dependencies**: AC-M5-7
- [P]

### AC-M5-9: `codehub-code-pack` skill

- [ ] `plugins/opencodehub/skills/codehub-code-pack/SKILL.md` — single-repo + group mode; argument-hint includes `[--budget <N>] [--tokenizer <id>]`; allowed-tools includes `pack_codebase`, `list_repos`, `project_profile`
- [ ] Cross-link from `plugins/opencodehub/skills/opencodehub-guide/SKILL.md` skills table
- [ ] Document the 9-item BOM contract + determinism class + pack_hash verification recipe
- [ ] `plugins/opencodehub/skills/codehub-code-pack/references/determinism-contract.md` — spec excerpt for future auditors
- **Dependencies**: AC-M5-7
- [P]

## M6 — Event-driven requirements

- **E-M6-1**: When a user runs `codehub analyze <repo>`, the ingest pipeline MUST emit one `RepoNode` into the graph with the 9 attributes (origin_url, repo_uri, default_branch, commit_sha, index_time, group, visibility, indexer, language_stats).
- **E-M6-2**: When an MCP tool taking a `repo` or `repo_uri` arg is called against a registry containing ≥ 2 repos without an explicit `repo_uri`, the tool MUST return a structured error with `_meta.error_code: "AMBIGUOUS_REPO"`, `_meta.choices: [...]` (cap 10, `total_matches: N`), `_meta.hint: "Retry with repo_uri=<one of above>"`, and `isError: true`.
- **E-M6-3**: When `codehub-document --group <name>` runs, the engine MUST emit `.docmeta.json` v2 with a `crossRepoLinks: [{source_repo_uri, target_repo_uri, source_doc_path, target_doc_path, relation}]` field consumed by the See-also footer renderer.
- **E-M6-4**: When `group_contracts` / `group_query` / `group_status` / `group_list` are called, every `repo` string in the response MUST be the new `repo_uri` format (backward-compat alias: accept legacy `name` on input, always emit `repo_uri` on output).

## M6 — State-driven requirements

- **S-M6-1**: While a repo's `origin_url` is unavailable (no git remote), the `RepoNode.origin_url` MUST be `null` and `repo_uri` synthesized as `local:<absolute-path-hash>`; downstream group tools MUST handle the `local:` prefix without erroring.
- **S-M6-2**: While `.docmeta.json` is at schema v1 (pre-M6), the engine MUST lazily upgrade it to v2 on first write by a v2 writer; reads remain compatible until M7.
- **S-M6-3**: While a group reference includes a repo not in the graph, `group_status` MUST mark that member as `present: false` and `indexed: false` without aborting the group response.

## M6 — Unwanted-behavior requirements

- **W-M6-1**: Adding `Repo` to `NodeKind` union MUST NOT change `graphHash` for any existing graph — `Repo` is appended at END of the union (see nodes.ts:41-43 warning) and not backfilled into already-indexed graphs. graphHash parity test gate holds.
- **W-M6-2**: `AMBIGUOUS_REPO` group-extension MUST NOT break the existing single-repo contract — `error-envelope.test.ts:39-47` stays green.
- **W-M6-3**: `repo_uri` format MUST NOT contain characters that break filesystem paths (`:`, `\`, `"`, `?`) other than the protocol colon. The `local:` variant uses a hash, not a path.

## M6 — Acceptance criteria

### AC-M6-1: First-class `RepoNode` in graph

- [ ] `packages/core-types/src/nodes.ts` — append `Repo` to `NodeKind` (end of union, per L41-43 warning)
- [ ] `packages/core-types/src/nodes.ts` — add `RepoNode` interface with 9 attributes; append to `GraphNode` union at end
- [ ] `packages/storage/src/duckdb-schema.ts` — no schema change; `RepoNode` serializes via existing JSON column
- [ ] `packages/storage/src/graphdb-schema.ts` — add `Repo` node table to DDL
- [ ] `packages/ingestion/src/pipeline/phases/repo-node.ts` — new phase emits one `RepoNode` per repo from registry entry + git origin probe
- [ ] `packages/ingestion/src/pipeline/index.ts` — wire the phase after `project-profile`, before `scip-ingest`
- [ ] Test: graphHash on a corpus without explicit repo node remains byte-identical
- [ ] Test: graphHash on a corpus with an explicit repo node is reproducible
- **Dependencies**: none (M5 and M6 run in parallel)
- [P]

### AC-M6-2: `AMBIGUOUS_REPO` structured `choices[]` extension

- [ ] `packages/mcp/src/error-envelope.ts` — extend `AMBIGUOUS_REPO` error payload with `{_meta: {error_code, choices[], total_matches, hint}}`; cap choices at 10
- [ ] `packages/mcp/src/repo-resolver.ts:96-100` — construct choices list from registry entries (include `repo_uri`, `default_branch`, `group`)
- [ ] `packages/mcp/src/repo-resolver.ts` — support `repo_uri` arg alias for `repo`
- [ ] `packages/mcp/src/error-envelope.test.ts` — extend round-trip suite
- [ ] `packages/mcp/src/tools/*.test.ts` — touch tests that assert the single-repo path still works
- **Dependencies**: AC-M6-1 (needs `RepoNode.repo_uri`)
- [P]

### AC-M6-3: `codehub-document --group` engine-side `crossRepoLinks` emission

- [ ] Locate `.docmeta.json` schema in the codebase (likely in `plugins/opencodehub/skills/codehub-document/` or an engine package — Explore did not pin the owner; Plan subagent resolves this)
- [ ] Schema v2: add `crossRepoLinks: [{source_repo_uri, target_repo_uri, source_doc_path, target_doc_path, relation: "see_also"|"depends_on"|"consumer_of"}]` field
- [ ] `doc-cross-repo` phase writer emits `crossRepoLinks` from `group_contracts` + `group_query` + `route_map` data
- [ ] Phase E assembler renders the See-also footer from `crossRepoLinks` (replaces current heuristic)
- [ ] S-M6-2 lazy v1→v2 upgrade tested
- [ ] Snapshot test: running `codehub-document --group` twice on the same group produces byte-identical `.docmeta.json`
- **Dependencies**: AC-M6-1 (needs `repo_uri`)

### AC-M6-4: `group_*` MCP tools emit `repo_uri` consistently

- [ ] `packages/mcp/src/tools/group-list.ts` — response includes `repo_uri` for each member
- [ ] `packages/mcp/src/tools/group-query.ts` — response row includes `_repo_uri` in addition to legacy `_repo` name (rename deferred to M7)
- [ ] `packages/mcp/src/tools/group-contracts.ts` — ContractRow `consumerRepo` / `producerRepo` become `consumerRepoUri` / `producerRepoUri` (additive; keep legacy fields through M7)
- [ ] `packages/mcp/src/tools/group-status.ts` — per-member freshness keyed by `repo_uri`
- [ ] Tests updated
- [ ] Skill doc cross-check: `codehub-contract-map` continues to work (consumes `repo_uri` via backward-compat fallback)
- **Dependencies**: AC-M6-1, AC-M6-2
- [P]

### AC-M6-5: Regression + docs

- [ ] `codehub-contract-map` skill quickcheck on a two-repo fixture (verify Mermaid still renders, matrix still populates)
- [ ] Update `docs/adr/0012-repo-as-first-class-node.md` — rationale, graphHash-safety argument, migration
- [ ] `README.md` — no change unless the `AMBIGUOUS_REPO` example was cited there (grep)
- [ ] `AGENTS.md:26-29` — extend the `AMBIGUOUS_REPO` contract description with the new `choices[]` shape
- **Dependencies**: AC-M6-1, AC-M6-2, AC-M6-3, AC-M6-4

## Wave structure (Act phase)

### M5 waves

- **Wave 1** (parallel) — blockers: AC-M5-0 · scaffolding: AC-M5-1, AC-M5-2 · foundation: AC-M5-3
  - AC-M5-0 must merge FIRST (standalone commit)
  - AC-M5-1 and AC-M5-2 parallel after AC-M5-0
  - AC-M5-3 parallel after AC-M5-1 (needs scaffolded package)
- **Wave 2** (parallel) — AC-M5-4, AC-M5-5 (both depend on AC-M5-3)
- **Wave 3** (mostly sequential) — AC-M5-6 → AC-M5-7 → AC-M5-8, AC-M5-9 (parallel tail)

### M6 waves

- **Wave 1** (parallel) — AC-M6-1, AC-M6-2 (no interdependency; AC-M6-2 is additive on top of AC-M6-1's type)
- **Wave 2** — AC-M6-3, AC-M6-4 (parallel; both depend on AC-M6-1)
- **Wave 3** — AC-M6-5 (serial regression + docs)

### Cross-track sequencing

- **M5 and M6 Wave 1 run concurrently** — no shared files.
- **M5 Wave 2+ and M6 Wave 1** likely share commits touching `packages/mcp/src/tools/pack-codebase.ts` (M5-7) and no M6 tool. Use worktree isolation per-AC subagent (MEMORY.md: cherry-pick over merge for worktree reconciliation).
- **Merge strategy**: single PR at the end (per M3+M4 convention: PR #64 bundled both). Branch name: `feat/v1-m5-m6`.

## Open questions carried into Gate 1

All have working assumptions baked into the spec above. Flag only if you want to override.

1. **Q1 — Tokenizer determinism class flag**: SPEC ASSUMES YES (`determinism_class: strict | best_effort | degraded` field in manifest). Override → flat manifest.
2. **Q2 — BOM pin granularity**: SPEC ASSUMES BOTH (`chonkie_version` + `grammar_commits[lang]`). Override → chonkie only.
3. **Q3 — Parquet byte-identity CI gate**: SPEC ASSUMES YES (Wave 3 AC-M5-6 + AC-M5-8). Override → sample-based cross-platform check.
4. **Q4 — `AMBIGUOUS_REPO.choices[]` cap**: SPEC ASSUMES 10 + `total_matches` field. Override → uncapped with client-side truncation warning.
5. **Q5 — Hierarchical Mermaid for N > 500 repos**: SPEC DEFERS (one active user, not v1 concern). Override → include in M6 W3.
6. **Q6 — Drop `repomix` engine in M5 or defer to M7?** SPEC DEFERS (`--engine repomix` opt-in stays through M6). Override → drop at M5 merge.

## Validation constraints (cross-check against ROADMAP 10-constraint list)

| # | Constraint | M5 posture | M6 posture |
|---|-----------|-----------|-----------|
| 1 | Stdio MCP + CLI only | `pack_codebase` stays MCP tool; `codehub code-pack` stays CLI | `group_*` tools stay MCP; no HTTP added |
| 2 | No LLM in query path | W-M5-1 test gates it | M6 adds no LLM call |
| 3 | Narrative features ship as skills | `codehub-code-pack` skill AC-M5-9 | Existing `codehub-contract-map` already compliant |
| 4 | Fixtures/evals in testbed | Determinism fixtures under `packages/pack/src/__fixtures__/` (small only, in core) | No new fixtures outside core |
| 5 | `mise run check` exit 0 | Every AC carries this | Every AC carries this |
| 6 | `graphHash` byte-identical | U1 ubiquitous + W-M6-1 test | Same |
| 7 | Deterministic code-pack | U2 + E-M5-3 + AC-M5-8 CI gate | N/A |
| 8 | No time estimates | Waves only, no calendar | Same |
| 9 | SARIF 2.1.0 conformance | AC-M5-5 findings reuse `@opencodehub/sarif` | N/A |
| 10 | 20-scanner pipeline | N/A | N/A |

## References

- `.erpaval/ROADMAP.md` §M5, §M6, §Target package layout
- `.erpaval/brainstorms/013-synthesis-v2-two-surface-product.md` (spec 001 `codehub-contract-map` promotion)
- `.erpaval/specs/001-claude-code-artifact-surface/spec.md` (AC-3-4, AC-5-5 for existing contract-map behavior)
- `.erpaval/specs/004-m3-m4/spec.md` (wave structure precedent)
- `.erpaval/solutions/architecture-patterns/repomix-is-output-side.md`
- `.erpaval/solutions/architecture-patterns/scip-monorepo-dist-src-alias.md`
- `.erpaval/solutions/conventions/scip-0-indexed-vs-graph-1-indexed.md`
- `.erpaval/solutions/conventions/bm25-over-node-id-favors-stubs.md`
- `.erpaval/sessions/session-e1d819/explore.yaml`
- `.erpaval/sessions/session-e1d819/research-m5m6.yaml`
- `docs/adr/0011-graph-db-backend.md` (M3 rationale; M6 adds ADR 0012)

## Status

- **Drafted**: 2026-05-05 (session-e1d819, Plan phase).
- **Gate 1 approval**: pending.
- **Accepted**: on merge of `feat/v1-m5-m6` → `main`.
