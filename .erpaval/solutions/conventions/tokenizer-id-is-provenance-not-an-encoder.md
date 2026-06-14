---
name: tokenizer-id-is-provenance-not-an-encoder
description: The `openai:o200k_base@tiktoken-0.8.0` tokenizerId string threaded through @opencodehub/pack is a PROVENANCE LABEL, not an enforced encoder — @chonkiejs/core's default 'character' tokenizer (1 char = 1 token) does the pack's counting. A feature needing real "tokens saved / token cost" numbers must add a real encoder; change-pack ships gpt-tokenizer (pure-JS, MIT, zero-dep) via the isolated `gpt-tokenizer/encoding/o200k_base` subpath for synchronous deterministic o200k_base counts, with a len/4 char heuristic only as a throw-fallback. Prefer pure-JS gpt-tokenizer over native/WASM tiktoken to honor the no-native-binding rail (ADR 0015).
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

1. **The pin is not a counter — add a real encoder if you want real tokens.**
   `change-pack` ships `gpt-tokenizer` (v3.4.0, MIT, **pure-JS, zero-dep**) and
   counts via `import { encode } from "gpt-tokenizer/encoding/o200k_base"`. The
   encoding subpath bundles its BPE ranks inline, so `encode` is **synchronous
   and deterministic** — no async rank fetch to break byte-identity.
2. **Pick pure-JS over native/WASM `tiktoken`.** The headline package
   `tiktoken` is a WASM/native binding; OCH's no-native-binding-at-the-
   npm-distributed-boundary rail (ADR 0015) rules it out. `gpt-tokenizer` is the
   rail-compatible way to get the SAME o200k_base counts.
3. **Keep a heuristic FALLBACK, not as the primary.** `countTokens` wraps the
   encoder in try/catch and falls back to `max(1, ceil(len/4))` only on
   pathological input that throws — so cost attribution never crashes the pack,
   but the normal path is real model tokens. Record the basis:
   `estimate: false`, `tokenizerModel: "openai/o200k_base"` (fold it into the
   content hash so a tokenizer swap changes the hash).
4. **Compute the baseline auditably from the graph**, not from a borrowed
   marketing percentage — sum real tokens over every File node in the impacted
   subgraph as the "agent reads each file blind" baseline.

## Why this matters

A cost feature that silently reports character counts as "tokens" is worse than
no number — it reads as authoritative and is wrong by a model-specific factor.
The honest options are (a) a clearly-labeled heuristic or (b) a real encoder.
`change-pack` started at (a) and shipped (b) the same session — the contract
shape (`estimate`/`tokenizerModel` fields) was built wide enough that swapping
the basis touched only the counter + the field values, never the structure.
When you do add a tokenizer, prefer a **pure-JS** one if the repo bans native
bindings, and import the **isolated encoding subpath** so counting stays
synchronous and deterministic.
