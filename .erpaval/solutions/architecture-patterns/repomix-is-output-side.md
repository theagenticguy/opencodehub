---
title: Repomix --compress is output-side only, not an input-side chunker
tags: [repomix, embedder, chunker, tree-sitter, llm]
first_applied: 2026-04-26
repos: [open-code-hub]
---

## The pattern

Repomix (https://github.com/yamadashy/repomix) is tempting as a
replacement for a tree-sitter-based chunker in an embedding pipeline —
it ships `--compress` with ~70% token reduction and supports 16
languages. **Do not use it that way.** Scope it to output-side surfaces
(LLM-context packing, snapshot generation).

## Why

1. **Per-file, not per-symbol.** `--compress` stitches signatures +
   class headers + imports into a single text blob per file joined by
   `⋮----`. It discards `startLine / endLine / symbolName / nodeType`.
   A graph-extraction pipeline that turns parse captures into
   Function/Method/Class nodes + CALLS/IMPORTS/EXTENDS edges cannot be
   fed from this output.
2. **Tokenizer mismatch.** Token counts use `o200k_base` (GPT-4o). If
   your embedder is anything else (BERT, modernbert, e5, voyage-code),
   your budget math won't line up.
3. **Determinism gap.** No grammar-sha is exposed, so content-addressed
   cache keys `(sha256, grammarSha, pipelineVersion)` lose their
   grammar component.
4. **Coverage gaps.** tsx folds into typescript; kotlin is absent.

## Where repomix actually shines

- `codehub pack` CLI command — single-file snapshot for agents who want
  to drop the whole repo into their context window.
- An MCP `pack_codebase` tool that re-exports the repomix invocation so
  agents can produce their own snapshots without knowing the CLI.

## Quick sanity check before substituting repomix for anything

Before planning to delete a chunker / parser in favor of repomix, ask:

- Do downstream consumers need per-symbol boundaries?
- Do they need startLine / endLine on every chunk?
- Do they key caches off grammar shas?
- Are tsx / kotlin / any other first-class language supported?

Any **yes** means keep your existing chunker; use repomix only for the
output-side feature.
