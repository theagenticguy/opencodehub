# ADR 0020 — Decision-equivalence is the pack contract; byte-identity is a witness, not the contract

- Status: **Proposed** — 2026-06-30 (awaiting Laith's review; pairs with spec 011).
- Authors: Laith Al-Saadoon + Bonk.
- Branch: `spec/011-replay-decision-equivalence`.
- Amends (does not supersede): the byte-identity invariant asserted in
  [ADR 0011 — Graph database backend](./0011-graph-db-backend.md) (the `graphHash`
  invariant) and [ADR 0019 — Single-file SQLite storage](./0019-single-file-sqlite-storage.md)
  (the "graphHash byte-identity (the go/no-go)" gate), and the ROADMAP U1/U2
  determinism constraints. Those gates **stay** — this ADR reframes what they
  are *for*. It also supersedes the byte-identity comparator in the unmerged
  `codehub replay` (`feat/v1-distribution-breadth`, `e6a81c2`).

## Context

The pack's reproducibility promise has been **byte-identity**: same inputs ⇒
byte-identical artifact, witnessed by a hash. The chain:

- **ROADMAP U1/U2** name "graphHash byte-identity per commit" and "deterministic
  code-pack (same commit + tokenizer + budget → same bytes)" as the one
  breaking-change budget OCH must preserve (`.erpaval/ROADMAP.md:201-202,219`).
- **ADR 0011** defines `graphHash` as the SHA-256 of the canonical-JSON
  `{edges, nodes}` projection and gates it in CI; **ADR 0019** makes
  byte-identical rebuild the migration go/no-go.
- The pack inherits it: `packHash = sha256(canonicalJson(manifest))`
  (`packages/pack/src/manifest.ts:52`), and `pack-determinism.test.ts` asserts
  two runs produce byte-identical BOM files.
- The user-facing promise (`packages/pack/src/readme.ts:73`): *"same
  `(commit, tokenizer_id, budget_tokens, chonkie_version, grammar_commits)`
  produces a byte-identical pack and the same `pack_hash`."*

Byte-identity is a good *witness* but the wrong *contract*, because the bytes
bind things the auditor does not care about:

1. **The `packHash` preimage includes incidental fields.** `pins.chonkieVersion`,
   `pins.grammarCommits`, and every BOM file's `fileHash` are in the hash
   (`manifest.ts:82-101`). A chonkie bump, a grammar-pin refresh, or a
   `tokenCount` recompute flips `packHash` — even when the same byte ranges of
   the same files were selected under the same budget. `readme.ts:73` literally
   lists `chonkie_version` and `grammar_commits` as pack inputs, conceding that
   a toolchain bump yields a "different" pack. The retrieval decision was
   identical.

2. **The embedder-swap precedent, stated precisely.** The #252 embedder swap
   (gte-modernbert → F2LLM-v2-80M, 320-dim) is the canonical decision-irrelevant
   change. Precision matters because the motivating prose (spec 010 §0)
   over-stated the mechanism: embeddings are **not** in the pack — the Parquet
   sidecar was dropped in ADR 0019, the BOM is **8 items**, and `graphHash` is
   embedder-neutral by construction (ADR 0014: it hashes only `{nodes, edges}`,
   never `store_meta`). So the swap breaks **neither** `packHash` **nor**
   `graphHash` today; it invalidates the `embeddings` table and the `store_meta`
   embedder fingerprint, forcing a re-index. The general lesson holds regardless:
   a legitimate change to *how* OCH builds the index — a better embedder, a newer
   grammar, a re-tokenizer — is exactly what a naive "did the bytes change?"
   check misreads as "the pack changed," when which files/ranges the agent saw is
   identical.

3. **An auditor cares about the decision, not the bytes.** They want: did the
   agent's context come from the right places? Byte-identity over-promises
   (asserts more than the contract needs) and under-delivers (breaks on changes
   the contract should tolerate).

## Decision

**The pack contract is decision-equivalence. Byte-identity is one sufficient
witness of it, not the contract itself.**

- **Contract of record (decision-equivalence):** two packs built from the same
  inputs are equivalent iff they have the same **decision set** — the same
  `(path, mergedByteRanges)` selections under the same `budgetTokens` —
  regardless of `tokenCount`, `pins`, chunk text bytes, or serialization.
- **Witness (byte-identity):** `packHash` equality ⇒ decision-equivalence
  (matching bytes trivially match the decision). The existing `graphHash` /
  `packHash` byte-identity gates **stay** as the cheap fast-path witness — they
  are valuable and almost-free. They are reframed from "the contract" to "a
  sufficient condition for satisfying the contract."
- **The decision set is a projection of existing artifacts**, not a new shape.
  It is computed from `ast-chunks.jsonl` (`{path, startByte, endByte}` per chunk,
  `ast-chunker.ts:68`) with `context-bom.json`'s merged `byteRanges`
  (`context-bom.ts:170`) as the fallback/cross-check.
- **`decisionHash`** is `sha256(canonicalJson(decisionSet))`, using the same
  RFC 8785 `canonicalJson` helper as `packHash`. It deliberately **excludes**
  `tokenCount`, `pins`, chunk text bytes, and per-file `fileHash`; it
  **includes** `path`, merged byte ranges, and `budgetTokens`.
- **`codehub replay`** is the structural assertion tool (spec 011): it compares
  two packs' decision sets (or re-packs and compares against a stored pack),
  reporting `EQUIVALENT` / `DIVERGED` / `BUDGET_MISMATCH` with a structured diff.
  It supersedes the byte-identity comparator in the unmerged `e6a81c2` `replay`,
  reusing that branch's integrity + recompute tiers as the byte-witness fast
  path and swapping only the re-pack comparator.
- **No gate is relaxed in this ADR.** The byte-identity CI gates continue to run
  unchanged. Decision-equivalence is *added* as the contract they serve. Whether
  to later let a pins-only delta pass the determinism gate (treating it as
  decision-equivalent) is an explicit follow-up, not decided here (spec 011 Q3).

## Consequences

**Positive.**

- The reproducibility claim becomes one OCH can defend against legitimate
  toolchain evolution: "upgrade the chunker, swap the embedder, bump a grammar —
  the pack's *decision* is provably unchanged," with `codehub replay` as the
  receipt. This is the data-backed "how well does OCH do" story paired with the
  Move 2 variance probe.
- The contract stops over-promising. A grammar-pin bump no longer counts as "the
  pack changed" to an auditor reading a hash.
- `replay`'s diff output is actionable in a way a hash inequality never was: it
  names *which files/ranges the agent would have seen differently*.

**Negative / costs.**

- A second hash (`decisionHash`) and a projection to maintain alongside
  `packHash`. Mitigated: the projection is pure and small, lives in
  `@opencodehub/pack` beside the builders, and reuses `canonicalJson`.
- Two notions of "same pack" (byte-identical vs decision-equivalent) is a concept
  an operator must learn. Mitigated: `packHash` stays the default identity in
  paths/UX; `decisionHash` surfaces only through `replay`.
- The `ast-chunks` offsets are UTF-16 code-unit indices today
  (`ast-chunker.ts:30`), not true UTF-8 byte offsets (coincide for ASCII).
  Decision-equivalence is well-defined as long as both packs use the same
  convention (they do); a future promotion to true byte offsets is a
  cross-cutting change tracked separately.

**Follow-ups (not decided here).**

- Whether to relax the byte-identity CI gates to accept decision-equivalent
  packs (e.g. a pins-only delta) — spec 011 Q3.
- Whether `replay` becomes an `analyze`-time or CI assertion vs. staying
  on-demand — spec 011 Q2.
- Doc-drift cleanup: the ROADMAP and `code-pack` CLI description still say
  "9-item BOM"; it has been 8 since ADR 0019.
