# Tasks 007 — change-pack (derived from spec.md ACs)

Branch `feat/change-pack`. Core lives in `@opencodehub/analysis`. Waves are dependency-ordered; tasks marked [P] run in parallel within a wave.

## Wave 1 — analysis core (foundational)
- **T-AC-1** `@opencodehub/analysis`: add `runChangePack(graph, query): Promise<ChangePack>` + types (`ChangePackQuery{repoPath,base?,head?,depth?,minConfidence?,budget?,includeTestsInSubgraph?}`, `ChangePack{impactedSubgraph,verdict,affectedTests,costAttribution,changePackHash}`). Reuse `runDetectChanges` (scope compare, two-dot base..head) for changed symbols; fan out each symbol via `runImpact(direction:"upstream",maxDepth:depth,minConfidence)`; UNION byDepth nodes + traversedEdges, dedupe (nodes by id, edges by (from,type,to,step)), retain full subgraph. Wire `computeVerdict` for the verdict section. Export from `analysis/src/index.ts`. **No new deps. No graph mutation. No LLM.** (spec AC-1, E3, E6, U3)

## Wave 2 — core dimensions (parallel, all depend on T-AC-1)
- **T-AC-2** [P] Affected-test selection: in `runChangePack`, run the upstream fan-out a second time (or reuse with includeTests) with `includeTests:true`, filter hits to `isTestPath(filePath)` true, dedupe by id, map each to `{id,name,filePath,reachedFromSymbol,depth}`, sort `(filePath,id)`. Decide predicate: start with exported `isTestPath` (impact.ts:66); note `test-pair.ts` multi-language variant as a follow-up if coverage gaps. (AC-2, E4, S2)
- **T-AC-3** [P] Cost attribution: `charHeuristicTokens(text)=max(1,ceil(len/4))`; `change_pack_tokens` over serialized pack body; `blind_baseline_tokens` = sum of charHeuristicTokens over full text of every File node in impacted subgraph (read file bytes via repoPath join); emit `{estimate:true,tokenizer_model:"char-heuristic-v1",change_pack_tokens,blind_baseline_tokens,tokens_saved,tokens_saved_pct,affected_test_count,total_test_count,ci_tests_skipped}`. (AC-3, E5, U6)

## Wave 3 — determinism (depends on T-AC-1,2,3)
- **T-AC-4** Deterministic serialization: serialize `ChangePack` via `canonicalJson` (core-types/src/hash.ts), all collections pre-sorted (U5); `changePackHash = sha256Hex(canonicalJson({...pack, changePackHash:""}))`. Add depth/minConfidence/budget/tokenizer_model into the hashed envelope (U1). Truncation guard: cap subgraph at 5000 nodes, deterministic by (depth,id), record `truncated`. (AC-4, U1, U5, UW1, UW2)

## Wave 4 — surfaces (parallel, both depend on T-AC-4)
- **T-AC-5** [P] MCP `change_pack` tool `packages/mcp/src/tools/change-pack.ts`: copy detect-changes skeleton — `ChangePackInput={base?,head?,depth?,minConfidence?,budget?,includeTestsInSubgraph?,...repoArgShape}`, `runChangePack(ctx,args)` via `withStore`→`analysisRunChangePack(store.graph,query)`→`withNextSteps(text, snake_case payload, nextSteps, stalenessFromMeta(meta))`, `try/catch→toolErrorFromUnknown`. `registerChangePackTool(server,ctx)` annotations readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:false. Wire import + registration in `server.ts`; add to instructions prose. NO outputSchema. (AC-5, E2, E7, S1)
- **T-AC-6** [P] CLI `codehub change-pack` `packages/cli/src/commands/change-pack.ts`: `runChangePackCmd(opts)` → `openStoreForCommand`→`analysisRunChangePack(store.graph,query)`→`--json`?JSON.stringify:human summary, try/finally store.close. Register in `cli/src/index.ts` near the CLI-siblings section, flags matching MCP field names + `--json`. Set process.exitCode non-zero on error. (AC-6, E1, E7, S1)

## Wave 5 — verification (depends on surfaces + core)
- **T-AC-7** [P] CLI↔MCP parity test (repo's FIRST): run `runChangePackCmd({json:true,...})` capturing stdout JSON + `runChangePack(ctx,sameArgs)` reading structuredContent; assert CLI JSON deep-equals MCP structuredContent minus `{next_steps,_meta}`. Hermetic via test seams + fake store/registry. (AC-7, U2)
- **T-AC-8** [P] Determinism test `analysis`: run `runChangePack` twice on same fixture+query, assert `changePackHash` equal + serialized bytes identical. Mirror pack-determinism.test.ts. (AC-8, U1)
- **T-AC-9** [P] Unit tests: subgraph union/dedup, affected-test selection (upstream reachability + isTestPath filter), cost math (char heuristic + baseline), empty-diff short-circuit, truncation guard. (AC-9, E6, UW2)

## Validate (Gate 2)
- `mise run check` exit 0 (lint+typecheck+test+banned-strings); full `pnpm -r test` green; parity + determinism tests green. Every failure is a blocker.

## Compound
- Commit per wave (conventional, scope `analysis`/`mcp`/`cli`), push `feat/change-pack`, open PR. Extract lessons (CL-LESSONS): candidate lessons — "tokenizerId is provenance not encoder (cost features need explicit heuristic labeling)", "generalize verdict's scalar fan-out by retaining the subgraph", "CLI↔MCP parity = one shared analysis core + first parity test pattern". Update INDEX, record lessons.yaml.
```
```
