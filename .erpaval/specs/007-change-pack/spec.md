# EARS Spec 007 — Diff-scoped change-pack (impact + affected-tests + cost attribution)

**Session**: session-6afa8d · **Branch**: `feat/change-pack` (cut from `origin/main` @ `94b9165`) · **Parent roadmap**: `.erpaval/ROADMAP.md` (M5 deterministic code-packs is the sibling pattern)

**Decision:** `change-pack` is a deterministic, diff-scoped capability that generalizes what `computeVerdict` already does internally (diff → per-symbol upstream fan-out) but **retains the impacted subgraph** instead of collapsing it to a scalar `blastRadius`, **surfaces the affected tests** that `impact.ts:490` currently classifies-then-drops, and adds a **cost-attribution** block. It ships with full CLI↔MCP parity backed by one shared core function, and the first CLI↔MCP parity test in the repo.

## Context (Explore + Research consolidated)

Full detail in `.erpaval/sessions/session-6afa8d/{explore-detect-changes,explore-verdict-impact,explore-pack,explore-parity,research-tokenizer-tests}.md`.

### What exists to build on
- **`runDetectChanges(graph, {scope,compareRef,repoPath})`** (`packages/analysis/src/detect-changes.ts:182-237`) → `DetectChangesResult{changedFiles, affectedSymbols[{id,name,filePath,kind,changedLines}], affectedProcesses, summary{fileCount,symbolCount,processCount,risk}}`. This is the diff→symbols extractor. Reuse verbatim.
- **`runImpact(graph, {target,direction,maxDepth,minConfidence,relationTypes,includeTests})`** (`packages/analysis/src/impact.ts:393-553`). Upstream traversal = callers/dependents. Already plumbs `includeTests` (default false → tests dropped at `impact.ts:486-493` via exported `isTestPath`). `ImpactResult{byDepth,traversedEdges,affectedProcesses,affectedModules,totalAffected,risk}`.
- **`computeVerdict(graph, {repoPath,base,head,config})`** (`packages/analysis/src/verdict.ts:115-312`) → 5-tier `VerdictResponse`. Internally calls `runDetectChanges` (scope compare, two-dot `base..head`) then loops first 20 symbols through `runImpact(direction:"upstream",maxDepth:3)` keeping `max(totalAffected)`. **It does NOT set includeTests, so its blast radius is production-only.**
- **`@opencodehub/pack`** determinism contract: `buildManifest`→`packHash = sha256(canonicalJson(snake_case manifest, pack_hash:""))` (`manifest.ts:51-66`); `canonicalJson` (RFC-8785 sorted keys) in `core-types/src/hash.ts`; per-body `sha256`; bodies written, manifest LAST. Determinism test pattern at `pack-determinism.test.ts` (run twice, assert packHash + readdir + `Buffer.compare===0`).
- **Edge model**: `CodeRelation{from,to,type,confidence,step?}`, 25 string `RelationType`s (`core-types/src/edges.ts:3-28`). Direction: `from`=actor, `to`=acted-upon. **CALLS = caller→callee; to find tests of a changed symbol, walk `direction:"up"` (incoming).** SCIP edges carry `confidence=1.0`, heuristic `0.5`; default floor `0.7`.
- **Test classification is PATH-BASED, no `Test` NodeKind.** Three predicates exist: `isTestPath` (`impact.ts:66-77`, narrow), a private copy (`processes.ts:575`), and the multi-language `isTestFile`/`pairedTestCandidates` (`ingestion/.../temporal-helpers/test-pair.ts:13-37`).
- **Parity pattern**: both CLI command + MCP tool call ONE shared `@opencodehub/analysis` (or pack) function (cleanest exemplar: `detect_changes`). CLI = commander v15 + per-command `--json`. MCP = `withStore`+`withNextSteps`+`stalenessFromMeta`+`toolErrorFromUnknown`, registered in `server.ts`, NO `outputSchema`. **No CLI↔MCP parity test exists — change-pack adds the first.**

### Load-bearing research decisions (settle the spec's hard choices)
- **TOKENIZER IS METADATA-ONLY.** The `openai:o200k_base@tiktoken-0.8.0` pin is a provenance label; no encoder runs. Pack counts chonkie's `'character'` tokenizer (1 char = 1 token) or a `len/4` degraded heuristic. There is no tiktoken/anthropic dep in the repo. **DECISION: v1 cost-attribution reuses the `len/4` heuristic for BOTH the scoped-pack tokens and the blind baseline (zero new deps, byte-deterministic, single token model), and the output block MUST self-label `estimate: true` with `tokenizer_model: "char-heuristic-v1"`. No model-token claims; no borrowed marketing percentages in the artifact.**
- **AFFECTED TESTS = upstream reachability, read from the graph.** `runImpact(direction:"upstream", includeTests:true)`, keep only hits where `isTestPath` is true. **MUST read the already-ingested graph via `runImpact`; MUST NOT re-derive edges** (prior lessons `scip-callee-definition-site` over-reports 27× and `scip-0-indexed-vs-graph-1-indexed` drops ~85% if re-derived wrong). Inherit correct SCIP resolution for free.
- **Determinism**: storage returns `(depth, nodeId)` order; change-pack MUST re-sort affected tests + subgraph nodes by `id` asc and edges by `(from,type,to,step)` for byte-identity, matching the pack's canonical-JSON discipline.

### Convention guardrails
- **`commitlint.config.mjs` scope-enum already includes `pack`** (verified this session: scope list includes `analysis, cli, mcp, pack, core-types, storage, …`). No new scope needed if change-pack core lands in `@opencodehub/analysis` or `@opencodehub/pack`. **First commit MUST verify scope-enum covers chosen package(s).**
- **`scripts/check-banned-strings.sh`**: `change`, `pack`, `test`, `cost`, `token` are all safe — no collision.
- **`mise run check`** = lint (biome) → typecheck (`pnpm -r exec tsc --noEmit`) → test → banned-strings. Every commit exits 0.
- **graphHash byte-identity** (ROADMAP constraint 6): change-pack is read-only over the graph; it emits NO new nodes/edges, so the invariant holds trivially. MUST NOT backfill or mutate the graph.
- **No LLM in query path** (ROADMAP rail 4): change-pack does zero LLM calls. Summarizer untouched.

## Ubiquitous requirements

- **U1**: `change_pack_hash` byte-identity — same `(commit, base, head, tokenizer_model, budget, depth, minConfidence)` → byte-identical change-pack output and same hash. Verified by a determinism suite (mirror `pack-determinism.test.ts`).
- **U2**: CLI (`codehub change-pack`) and MCP (`change_pack`) MUST produce structurally identical payloads for identical inputs — both call the single shared core `runChangePack`. Verified by a CLI↔MCP parity test (the repo's first).
- **U3**: change-pack MUST read the ingested graph only (via `runImpact`/`runDetectChanges`); it MUST NOT re-derive edges, MUST NOT mutate the graph, MUST NOT call any LLM.
- **U4**: `bash scripts/check-banned-strings.sh` exits 0; `mise run check` exits 0 after every commit.
- **U5**: All output collections MUST be deterministically ordered — nodes/tests by `id` asc, edges by `(from,type,to,step)`, files by path. No locale-dependent or insertion-order leakage into hashed bytes.
- **U6**: The cost-attribution block MUST count real BPE tokens via OpenAI's `o200k_base` encoding (`gpt-tokenizer`, pure-JS/MIT, no native binding — respects ADR 0015) and record the basis in `tokenizer_model:"openai/o200k_base"` with `estimate:false`. The encoder MAY fall back to a `len/4` character heuristic ONLY on pathological input that throws (rare, still deterministic); it MUST NOT otherwise present heuristic counts as model tokens. (Superseded the v1 char-heuristic decision per operator request — "ship tiktoken instead"; chose pure-JS `gpt-tokenizer` over native/WASM `tiktoken` to honor the no-native-binding rail.)

## Event-driven requirements

- **E1**: When a user runs `codehub change-pack --base <ref> --head <ref>` (defaults base=`main`, head=`HEAD`), the CLI MUST emit a `ChangePack` object containing all four sections: `impacted_subgraph`, `verdict`, `affected_tests`, `cost_attribution`. With `--json` it prints `JSON.stringify(changePack,null,2)`; without, a human summary.
- **E2**: When the `change_pack` MCP tool is called with `{base?,head?,...repoArgShape}`, it MUST return the same `ChangePack` payload as `structuredContent` (snake_case), wrapped via `withNextSteps` with staleness + next-step hints, sharing the identical `runChangePack` core with the CLI.
- **E3**: When change-pack assembles the impacted subgraph, it MUST fan out from each changed symbol via `runImpact(direction:"upstream", maxDepth:<depth>, minConfidence:<floor>)`, UNION the per-symbol `byDepth` nodes + `traversedEdges` into one deduplicated subgraph (dedup nodes by `id`, edges by `(from,type,to,step)`), and retain it — NOT collapse to a scalar.
- **E4**: When change-pack selects affected tests, it MUST run the upstream fan-out with `includeTests:true`, filter hits to those whose `filePath` satisfies the test predicate, dedupe by node id, and return `affected_tests[]` each with `{id,name,filePath,reachedFromSymbol,depth}`, sorted by `(filePath,id)`.
- **E5**: When change-pack computes cost attribution, it MUST emit `{estimate:true, tokenizer_model, change_pack_tokens, blind_baseline_tokens, tokens_saved, tokens_saved_pct, affected_test_count, total_test_count, ci_tests_skipped}` where `change_pack_tokens` = `len/4` over the serialized pack body, and `blind_baseline_tokens` = the same heuristic over the full text of every File node in the impacted subgraph (the conservative "agent reads each impacted file" baseline). `ci_tests_skipped = total_test_count − affected_test_count`.
- **E6**: When the diff is empty or touches only files with no graph symbols, change-pack MUST short-circuit to an empty-but-valid `ChangePack` (verdict `auto_merge`, empty subgraph, empty affected_tests, cost_attribution with zero savings), mirroring `finaliseEmpty` in verdict.ts — never throw.
- **E7**: When the repo is not indexed / ambiguous / git fails, the MCP tool MUST return the conventional structured error envelope (via `withStore` + `toolErrorFromUnknown`); the CLI MUST exit non-zero with a readable message. (Git failures fail-open to empty per `runGit` convention.)

## State-driven requirements

- **S1**: While the index is stale relative to the working tree, change-pack MUST still produce a result AND surface the staleness envelope (`stalenessFromMeta`) so the caller knows the graph may lag the diff. (Parity: CLI prints a staleness note in non-JSON mode.)
- **S2**: While `--include-tests-in-subgraph` is false (default), the impacted_subgraph counts/risk MUST reflect production code only (tests excluded from the subgraph), EXACTLY as verdict does today — the affected_tests section is the dedicated place tests surface. When true, tests are also retained in the subgraph.

## Optional-feature requirements

- **O1**: Where `--budget <N>` is supplied (default 100_000), change-pack MAY trim the impacted_subgraph context body to fit the budget by dropping lowest-PageRank/highest-depth nodes first, recording `budget_applied:true` and the drop count in the manifest. Trimming MUST be deterministic (stable sort before drop). v1 MAY ship budget as a recorded-but-not-enforced field if trimming risks determinism; the spec permits deferring enforcement to a follow-up as long as the field is present and documented.
- **O2**: Where `--depth <N>` is supplied (default 4 — one deeper than verdict's 3, since tests sit deep in call chains per research), it sets the upstream `maxDepth`. Where `--min-confidence <f>` is supplied (default 0.7), it sets the traversal floor; `--min-confidence 1.0` yields SCIP-precise-only edges.

## Unwanted-behavior requirements

- **UW1**: If change-pack would emit non-deterministic bytes (unsorted collection, timestamp, absolute path, run id), that is a defect — the determinism test MUST catch it. No wall-clock, no `Math.random`, no absolute paths in hashed bytes.
- **UW2**: If a traversal hits the depth cap with more nodes than a hard ceiling (e.g. 5000), change-pack MUST truncate deterministically (by `id` after depth ordering) and record `truncated:true` + the cap — never emit an unbounded subgraph or hang.
- **UW3**: change-pack MUST NOT introduce ERPAVal spec-coordinate leakage (`AC-*`, `E*`, `U*`, `S*`) into source comments, tool descriptions, CLI help, or test names (prior lesson `no-spec-coordinate-leakage-into-source`). Coordinates live in commits/PR body only.

## Acceptance criteria → task seeds

| AC | Requirement | Package | Parallel-safe |
|----|-------------|---------|---------------|
| AC-1 | `runChangePack(graph, query): Promise<ChangePack>` core — reuse runDetectChanges + runImpact upstream fan-out, union/dedupe subgraph, retain it | `@opencodehub/analysis` | [P] foundational |
| AC-2 | Affected-test selection: includeTests upstream fan-out + isTestPath filter + stable sort + reachedFromSymbol/depth | `@opencodehub/analysis` | Dependencies: AC-1 |
| AC-3 | Cost-attribution: char-heuristic counter, blind-baseline from impacted File nodes, estimate-labeled block | `@opencodehub/analysis` | Dependencies: AC-1 |
| AC-4 | Deterministic serialization + `change_pack_hash` (canonicalJson, sorted collections) | `@opencodehub/analysis` (+ reuse core-types hash) | Dependencies: AC-1, AC-2, AC-3 |
| AC-5 | MCP `change_pack` tool — withStore/withNextSteps/staleness/error envelope, registered in server.ts | `@opencodehub/mcp` | Dependencies: AC-4 |
| AC-6 | CLI `codehub change-pack` command — commander registration + --json + flags matching MCP fields | `@opencodehub/cli` | Dependencies: AC-4 |
| AC-7 | CLI↔MCP parity test (first in repo) — same args → deep-equal payload minus envelope keys | `@opencodehub/cli` or `mcp` test | Dependencies: AC-5, AC-6 |
| AC-8 | Determinism test — run twice, assert hash + byte-identity | `@opencodehub/analysis` test | Dependencies: AC-4 |
| AC-9 | Unit tests per core fn (subgraph union/dedup, test selection, cost math, empty-diff short-circuit) | `@opencodehub/analysis` test | Dependencies: AC-1..AC-3 |

**Decision — where the core lives:** `@opencodehub/analysis` (NOT pack). Rationale: it consumes `runImpact`+`runDetectChanges` which already live there; the verdict precedent is there; pack depends on analysis, so analysis is the lower layer and avoids a cycle. The output is a structured JSON object (not a 9-item BOM on disk), so it does not need pack's file-writing machinery — though it borrows `canonicalJson`/`sha256Hex` from `core-types` exactly as pack does.
