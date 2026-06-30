# Spec 011 — `codehub replay`: assert decision-equivalence structurally

**Status:** Draft for review (NO code yet — review the contract pivot first).
**Author:** Bonk + Laith · **Date:** 2026-06-30
**Branch:** `spec/011-replay-decision-equivalence` (off `main` @ `278702a`)
**Roadmap origin:** M-W-F run 2026-06-29, Move 6 ruling (decision-equivalence). This is the *structural* half; spec 010 / `pack --variance-probe` is the *behavioral* half (shipped, PR #269).
**Companion ADR:** 0020 — "decision-equivalence supersedes byte-identity as the pack contract" (drafted alongside this spec; 0020 is the next free ADR number, confirmed).

---

## 0. The two halves of Move 6, and why this one is the keystone

Laith ruled (2026-06-30): the pack contract pivots from **byte-identity** to **decision-equivalence** — "same inputs ⇒ provably the same *retrieval decision set* (same files + byte ranges selected under the same budget); byte-identity is one cheap witness, not the contract."

- **Move 2 (`pack --variance-probe`, shipped)** measures the contract *behaviorally*: does an agent's answer wander less with the pack? A number, but an *empirical* one — it runs a stochastic agent and observes outcomes.
- **Move 6 structural half (`codehub replay`, this spec)** asserts the contract *structurally*: given the same inputs, did OCH select the **same decision set**? No agent, no stochasticity — a deterministic structural check.

Laith's framing: this is "critical for data-backed results on how well OCH does." The variance probe says *the pack helps*; `replay` says *the pack is what we claim it is* — reproducible at the decision level, even when the bytes legitimately drift. Behavioral benefit (Move 2) on top of a structural guarantee (this) is the proof story.

## 1. Diagnosis — why byte-identity is the wrong *contract* (it's the right *witness*)

The standing invariant is **ROADMAP constraint U1: "graphHash byte-identity per commit"** (`.erpaval/ROADMAP.md:219` names it the one breaking-change budget OCH must preserve; `:201-202` lists U1/U2 as CI gates). It is asserted across six ADRs — the canonical statement is **ADR 0011** (`graphHash` = SHA-256 of the canonical-JSON `{edges, nodes}` projection, store-agnostic), and **ADR 0019** titles a section "graphHash byte-identity (the go/no-go)". The pack inherits it: `packHash` (`manifest.ts:52`) is `sha256(canonicalJson(manifest))`, and `pack-determinism.test.ts` asserts two runs produce byte-identical BOM files. The user-facing promise is `readme.ts:73`: *"same `(commit, tokenizer_id, budget_tokens, chonkie_version, grammar_commits)` produces a byte-identical pack and the same `pack_hash`."*

Byte-identity is a fine *witness* but a brittle *contract*, because bytes are a poor proxy for the decision the auditor actually cares about:

- **The `packHash` preimage binds incidental fields.** It includes `pins.chonkieVersion`, `pins.grammarCommits`, and each BOM file's `fileHash` (`manifest.ts:82-101`). A chonkie bump, a grammar-pin refresh, or a `tokenCount` recompute flips `packHash` — even when *the exact same byte ranges of the exact same files were selected under the same budget*. The promise in `readme.ts:73` literally lists `chonkie_version` and `grammar_commits` as inputs, conceding that a toolchain bump is a "different" pack. Under decision-equivalence it is the *same* pack.
- **The embedder-swap precedent — stated precisely.** The #252 swap (gte-modernbert → F2LLM-v2-80M, 320-dim) is the canonical "decision-irrelevant change." Precision matters here, because spec 010 §0 over-stated it: embeddings are **not** in the pack (the Parquet sidecar was dropped in ADR 0019; the BOM is **8 items**), and `graphHash` is embedder-neutral by construction (ADR 0014: it hashes only `{nodes, edges}`, never `store_meta`). So the swap breaks **neither** `packHash` **nor** `graphHash` today — it invalidates the `embeddings` table and the `store_meta` embedder fingerprint, forcing a re-index. The lesson is the general one: a legitimate change to *how* OCH builds the index (a better embedder, a newer grammar, a re-tokenizer) is exactly the kind of change a naive "did the bytes change?" auditor misreads as "the pack changed," when the retrieval decision — which files/ranges the agent saw — is identical.
- **An auditor doesn't care about bytes.** They care whether the agent's context came from the right places. Byte-identity over-promises (claims more than the contract needs) and under-delivers (breaks on changes the contract should tolerate).

The fix: make the **decision set** the contract of record, and keep byte-identity as a *sufficient-but-not-necessary witness* of it.

## 1.5. There is already a byte-identity `replay` — this supersedes its comparator

A `codehub replay <hash>` + `pack --prove` implementation already exists on the unmerged branch `feat/v1-distribution-breadth` (`e6a81c2`, not an ancestor of `main`). It is the **byte-identity predecessor** this spec supersedes. Its design (worth reusing):

- `runReplay(hash)` reads `<repo>/.codehub/packs/<hash>/manifest.json`, parses snake_case→camelCase.
- **Integrity tier** (always, offline): re-hash every BOM body on disk vs its attested `fileHash`; mismatch → hard drift.
- **Recompute tier:** re-derive `packHash` via `buildManifest`, assert equality.
- **Optional re-pack tier:** an injected `RepackDriver` checks out the commit, re-runs the packer, **byte-compares** `packHash`. `best_effort` (Claude tokenizer) tolerates re-pack drift; `strict`/`degraded` hard-fail on any byte difference.
- Verdict via `replayVerdict(r) → { line, exitCode }`.

**What spec 011 changes:** the re-pack tier's comparator flips from *byte-identity* to *decision-equivalence*. A re-pack that drifts in bytes but selects the same decision set → `EQUIVALENT` (today: a `strict`-class drift would hard-fail). A re-pack that changes the decision set → `DIVERGED` (fail). The integrity + recompute tiers stay as the cheap byte-witness fast path.

**Reuse + cleanup:** lift `parseManifest`, the tiered verdict, the `RepackDriver` seam, and `recomputePackHash` from `e6a81c2`. Its `parseManifest` still reads a `duckdb_version` pin and `schemaVersion: 1` — both stale post-ADR-0019 (current schema is `2`, no duckdb pin); drop them on the rebase. (Also: the `code-pack` CLI description and the ROADMAP still say "9-item BOM" — stale since ADR 0019; clean up to "8-item" in passing.)

## 2. What the decision set IS (grounded in the current pack)

The pack already encodes the decision set — this spec *projects* existing artifacts, it invents no new shape:

- **`ast-chunks.jsonl`** — each row is an `AstChunk` (`ast-chunker.ts:68`): `{ path, startByte, endByte, tokenCount, language? }`, sorted `(path ASC, startByte ASC, endByte ASC)`. The `(path, startByte, endByte)` triple is *literally* "which file, which byte range, was selected under budget."
- **`context-bom.json`** — each `file` component (`context-bom.ts`) carries path, content hash, and an optional `opencodehub:byteRanges` property: merged, sorted, non-overlapping `[start, end)` spans (`mergeSpans`, `context-bom.ts:170`) — "the union of bytes read from this file." This is already a deterministic, byte-range projection independent of chunk text.

> **The decision set** of a pack is the set of `(path, mergedByteRanges)` selections, taken under a given `budgetTokens`. Two packs are **decision-equivalent** iff their decision sets are equal — same paths, same merged byte ranges per path, same budget — regardless of `tokenCount`, `pins`, chunk text bytes, or serialization.

Note (`ast-chunker.ts:30`): `startByte`/`endByte` are currently UTF-16 code-unit offsets stored under byte names (coincide with UTF-8 for ASCII). The comparator treats them as opaque offsets — equivalence is well-defined as long as both packs use the same convention, which they do. See Q1 for the optional line-granularity mode.

## 3. The `decisionHash` — a normalized projection

`replay` introduces a **`decisionHash`**: a hash over a canonical, incidental-free projection of the decision set.

```
decisionSet(pack) =
  {
    budgetTokens,                       # the budget the selection was made under
    selections: [                       # sorted by path
      { path, ranges: mergedByteRanges(path) }   # ranges = sorted non-overlapping [start,end)
    ]
  }
decisionHash = sha256(canonicalJson(decisionSet))   # same RFC 8785 helper as packHash
```

Deliberately **excluded** (the whole point): `tokenCount` per chunk; `pins.chonkieVersion` / `pins.grammarCommits`; chunk *text bytes* and per-file `fileHash`; `commit` / `repoOriginUrl` (provenance — reported, not hashed).

Deliberately **included**: `path` + merged byte ranges (the selection); `budgetTokens` (the constraint — different budgets are *expected* to differ; reported distinctly, not as a violation).

**Source of ranges.** Prefer `ast-chunks.jsonl` `(startByte,endByte)` merged per path; fall back to `context-bom.json` `byteRanges` when ast-chunks is absent/degraded. They should agree; `replay` flags when they don't (a real internal-consistency bug signal).

**Relationship to `packHash`:** `packHash` equality ⇒ `decisionHash` equality (cheap witness — matching bytes trivially match the decision). `decisionHash` equality does NOT require `packHash` equality (the contract tolerates incidental drift). Fast path: if `packHash` matches, PASS without computing the projection; else compute and compare `decisionHash`.

## 4. The `codehub replay` command

Two modes — extend the existing `replay <hash>` self-check, add a two-pack compare:

```
codehub replay <hash> [--repo <path>] [--repack] [--json] [--budget-strict]   # self-check (extends e6a81c2)
codehub replay --compare <pack-a> <pack-b> [--json] [--budget-strict]         # two-pack compare (new)
```

- **Self-check `replay <hash>`** — reads `<repo>/.codehub/packs/<hash>/`. Integrity + recompute tiers (byte witness) stay. With `--repack`, re-pack the recorded `commit` and assert **decision-equivalence** (not byte-identity) against the stored pack. This is the structural analog of `codehub status`'s staleness record: "is this pack still the decision OCH would make today?"
- **Two-pack `--compare A B`** — read two pack dirs, project each to its decision set, compare. The minimal unit that proves the projection; no store, no re-pack.
- **Verdict** — `EQUIVALENT` (decision sets match) · `DIVERGED` (selections differ) · `BUDGET_MISMATCH` (different `budgetTokens` — reported distinctly; a violation only under `--budget-strict`).
- **On `DIVERGED`** — structured diff: paths only in A, paths only in B, and per-path range deltas (ranges added/removed). This is the actionable output — *what the agent would have seen differently*.
- **Exit code** — 0 on `EQUIVALENT`; non-zero on `DIVERGED` (and on `BUDGET_MISMATCH` only under `--budget-strict`). Usable as an on-demand structural gate.
- **`--json`** — full record (verdict + both `decisionHash`es + `packHash`es + diff) on stdout; human summary on stderr (context-bom discipline). The record is a pure function of the inputs — no clock/run-id — so it serializes reproducibly.

## 5. Where it lives + shape

- **`@opencodehub/pack`** gains the projection: a pure `buildDecisionSet(astChunks, contextBom) → DecisionSet` + `decisionHash(DecisionSet) → string`, exported beside the existing builders. It belongs in `pack` because it reuses the same determinism machinery (`canonicalJson`, the BOM shapes) and `replay` is a *reader* of pack artifacts.
- **CLI** `codehub replay` in `packages/cli/src/commands/replay.ts` (rebased from `e6a81c2`, comparator swapped), registered in `index.ts` next to `code-pack` (commander pattern; lazy `await import`).
- **Determinism of the projection itself:** `decisionSet` is a pure function of the input artifacts (no clock, no env), serialized through the same RFC 8785 `canonicalJson`. Two `replay` runs over the same packs print byte-identical records.

## 6. EARS requirements (draft — for review)

- **R1** WHEN given two packs built from the same `(commit, budget, tokenizer)`, `replay` SHALL compute each pack's `decisionHash` (a hash over the normalized `(path, mergedByteRanges, budgetTokens)` projection) and report `EQUIVALENT` iff they match.
- **R2** The `decisionHash` projection SHALL exclude `tokenCount`, `pins` (chonkie version, grammar commits), chunk text bytes, and per-file `fileHash`, so a toolchain-version bump that does not change the selection set yields the same `decisionHash`.
- **R3** WHERE `packHash` of the two packs is equal, `replay` SHALL short-circuit to `EQUIVALENT` without recomputing the projection (byte-identity is a sufficient witness).
- **R4** WHEN the decision sets differ, `replay` SHALL emit a structured diff naming paths present in only one pack and, for shared paths, the byte-range deltas — and SHALL exit non-zero.
- **R5** WHEN the two packs were built under different `budgetTokens`, `replay` SHALL report `BUDGET_MISMATCH` distinctly from `DIVERGED`, exiting zero by default and non-zero only under `--budget-strict`.
- **R6** The emitted `--json` record SHALL be a pure function of the inputs (no wall-clock/run-id), so the record serialization is reproducible.
- **R7** `replay` SHALL derive ranges from `ast-chunks.jsonl` when present and fall back to `context-bom.json` `byteRanges` otherwise, and SHALL flag when the two disagree for the same pack.
- **R8** The integrity + recompute tiers inherited from the `e6a81c2` `replay` (re-hash BOM bodies vs attested `fileHash`; recompute `packHash`) SHALL remain as the cheap byte-witness fast path; only the re-pack-equivalence comparator changes from byte-identity to decision-equivalence.

## 7. Open questions for Laith (review before I build)

1. **Byte ranges vs. line ranges.** ast-chunks records `(startByte, endByte)` as UTF-16 code-unit offsets today (`ast-chunker.ts:30`; coincide with UTF-8 for ASCII). Byte ranges are the precise contract; should I also offer a `--coarse` mode projecting to `(startLine, endLine)` for an encoding-robust, human-diffable view? I lean: byte ranges as the contract, line ranges as a reporting aid.
2. **On-demand vs. CI gate.** `replay` is deterministic and cheap (pure read + hash), unlike the variance probe. I lean: ship on-demand in v1; later add an opt-in `analyze`-time "this commit's pack is decision-equivalent to the last" assertion — but only after we've seen real diffs in practice. Don't gate CI on it until the projection is trusted.
3. **Does ADR 0020 retire the byte-identity gates, or layer over them?** I lean **layer, don't retire**: keep the `graphHash`/`packHash` byte-identity tests as the strict-witness fast path (cheap, valuable), and make decision-equivalence the *contract of record* that byte-identity is one way to satisfy. ADR 0020 reframes byte-identity from "the contract" (ROADMAP U1) to "a sufficient witness." Agree — or do you want the byte gates actually *relaxed* (e.g. let a pins-only delta pass the determinism gate)?
4. **v1 scope.** Two-pack `--compare A B` is the minimum that proves the projection and reuses no store/analyze. The `replay <hash> --repack` self-check needs a `RepackDriver` (checkout + re-pack). Ship two-pack compare + the inherited integrity/recompute tiers in v1, and `--repack` decision-equivalence in v2? (I lean yes.)
5. **Supersede or extend `e6a81c2`?** That branch's byte-identity `replay` is unmerged and 32 behind `main`. I lean: cherry-pick its scaffolding onto a fresh branch, drop the stale `duckdb_version`/`schemaVersion:1`, and land the decision-equivalence comparator as the same PR — so we don't carry two `replay`s. Agree?

## 8. What this is NOT (scope guard)

- Not the variance probe (spec 010 / Move 2 — behavioral half, shipped).
- Not a re-implementation of packing — `replay` is a pure *reader* of pack directories (plus an optional re-pack tier in v2).
- Not a CI gate in v1 — on-demand structural check (Q2).
- Not a graph-diff tool — it compares *pack decision sets*, not raw graphs (`detect_changes` already maps diffs to symbols — a different question).
