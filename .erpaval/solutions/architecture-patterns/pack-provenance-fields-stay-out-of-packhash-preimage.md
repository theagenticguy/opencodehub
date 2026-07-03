---
name: Pack provenance/channel fields ride outside the packHash preimage unless they change the decision set
description: New pack metadata (tokenizer lane, cache channel, provenance citations) must be classified as either hash-bound (changes what was selected) or hash-free (only annotates), or it silently breaks determinism fixtures or the decision-equivalence contract
type: architecture-patterns
---

When adding a new field to the pack, decide up front whether it belongs in
the `packHash` preimage. The preimage (`packages/pack/src/manifest.ts`
`toSnakeCaseManifest` → `canonicalJson` → `sha256Hex`) binds the fields
that define WHAT was selected: `commit`, `tokenizerId`, `budgetTokens`,
`determinismClass`, `pins`, per-file `fileHash`, and `contextBomHash`. Under
ADR-0020 the real contract is decision-equivalence (same inputs ⇒ same
retrieval decision set); byte-identity is a cheap witness. So the test is:
does the field change the decision set?

Three fields added across Moves 1/2/4 sorted cleanly into the two classes:

- **Sonnet-5 tokenizer lane (Move 1)** — HASH-BOUND. `tokenizerId` is already
  in the preimage; a new lane value (`anthropic:claude-sonnet-5@2026-06-30`)
  legitimately flips `packHash` because it changes chunk sizing and the
  `resolveDeterminism` verdict (`index.ts:287` downgrades any `anthropic:`
  prefix to `best_effort`). No fixture broke because the determinism tests
  assert cross-run EQUALITY (`m1 === m2`), not golden literals.
- **CycloneDX 1.7 + per-file provenance citation (Move 2)** — HASH-BOUND, by
  design. `context-bom.json` is a BOM item AND its `contextBomHash` is a named
  preimage field, so bumping `specVersion`/`$schema` and adding a per-file
  `externalReferences[{type:"vcs",url}]` + `opencodehub:commit` property flips
  the hash. That is correct: the receipt's content genuinely changed. Only the
  one hard `specVersion === "1.6"` assertion needed editing; equality-based
  determinism suites passed untouched.
- **`--cache-channel` (Move 4)** — HASH-FREE. The channel only shapes the
  agent-facing assembled context string (`assemblePackContext` in
  `variance-probe.ts`), not the BOM. It is recorded on `PackOpts.cacheChannel`
  but deliberately kept OUT of `toSnakeCaseManifest`, so the default (`auto`,
  marker-free) path is byte-identical to pre-Move-4 packs and every
  determinism/golden fixture stays green. If it had leaked into the preimage,
  every existing pinned pack would have broken for a field that changes nothing
  about what was selected.

Mechanism: classify the field FIRST. Hash-bound iff it changes the decision
set (selection, sizing, or the recorded content of a BOM item). Hash-free iff
it only annotates delivery/consumption. A cache/delivery/rendering knob is
hash-free; a tokenizer/budget/selection/content knob is hash-bound. Getting
this wrong is silent: a mis-bound knob breaks every pinned fixture; a
mis-unbound content field breaks the re-derivability contract.

Related: [[collapse-parallel-switches-into-record-registry]] (the channel enum
+ `cacheChannelNeedsMarkers` switch is exhaustive over the union so a new
channel forces a compile-time decision).
