---
name: tokenizer-id-is-provenance-not-an-encoder
description: The `openai:o200k_base@tiktoken-0.8.0` tokenizerId string threaded through @opencodehub/pack is a PROVENANCE LABEL, not an enforced encoder. No tiktoken/anthropic tokenizer is installed anywhere in the repo; @chonkiejs/core's default 'character' tokenizer (1 char = 1 token) does the counting, with a len/4 degraded fallback. So any feature that needs "tokens saved / token cost" numbers cannot get model-accurate counts for free — it must either add a real tokenizer dep or compute an explicitly-labeled char heuristic and never present it as model tokens.
metadata:
  type: convention
  category: conventions
tags: [tokenizer, pack, chonkie, cost-attribution, change-pack, determinism, estimate]
discovered: 2026-06-14
session: session-6afa8d
related:
  - tsup-collapse-monorepo-to-single-cli
---

# tokenizerId is provenance, not an encoder

## The trap

`@opencodehub/pack` threads a `tokenizerId` like `openai:o200k_base@tiktoken-0.8.0`
through the manifest and into `buildAstChunks`. It LOOKS like the pack counts
tokens with the o200k_base encoder. It does not.

- `ast-chunker.ts` explicitly "does not interpret" the tokenizer id (only uses it
  to pick `determinismClass`: `anthropic:` → `best_effort`, else `strict`).
- Grep the whole `pnpm-lock.yaml` for `tiktoken|gpt-tokenizer|o200k` → zero hits.
  `@chonkiejs/token` (the HF-tokenizer add-on) is not installed.
- chonkie's `CodeChunker` defaults to the `'character'` tokenizer (1 char = 1
  token); the pack passes only `{language, chunkSize}`, never a tokenizer. The
  degraded path uses `Math.max(1, Math.ceil(len / 4))`.
- `budgetTokens` maps straight to chonkie's `chunkSize` (per-chunk cap) — there
  is no binary-search-to-fit and no total-pack budget enforcement.

So the tokenizerId is a reproducibility *label* (it correctly busts `packHash`
when it changes, which is its real job) — not a guarantee that any o200k_base or
Anthropic encoder ran.

## How to apply

When a feature needs token counts (cost attribution, budget trimming, "tokens
saved"):

1. **Do not assume model-accurate counts exist.** Reuse the existing `len/4`
   char heuristic — it is zero-dep, byte-deterministic, and the same model the
   pack already uses.
2. **Label the output an estimate.** `change-pack`'s `CostAttribution` carries
   `estimate: true` + `tokenizerModel: "char-heuristic-v1"` so no caller mistakes
   it for tiktoken counts.
3. **Compute the baseline auditably from the graph**, not from a borrowed
   marketing percentage — e.g. sum char-heuristic tokens over every File node in
   the impacted subgraph as the "agent reads each file blind" baseline.
4. If you genuinely need model-accurate counts, that's a real new dependency
   (tiktoken / gpt-tokenizer) and an ADR — not a one-liner.

## Why this matters

A cost feature that silently reports character counts as "tokens" is worse than
no number — it reads as authoritative and is wrong by a model-specific factor.
Naming the heuristic in the output keeps the feature honest and lets a future
tokenizer upgrade swap the basis without changing the contract shape.
