# 0004 — Hierarchical embeddings with filter-aware HNSW

## Status

Accepted. Shipped as P03 in v1.1.

## Context

The v1.0 `embeddings` table stored one vector per callable symbol and routed
every hybrid query through a single flat HNSW index. Architectural queries
("which subsystem owns X?") landed in the same space as function-level lookups
and lost to exact-name hits. Research
(`.erpaval/sessions/2026-04-24-v1-backlog-and-framework-detection/research/hierarchical-embeddings.md`)
ranked four options by payoff-per-day and surfaced two clear winners:

1. Summary-fused symbol embeddings (embed `signature + LLM summary + body`).
2. File- and community-tier coarse embeddings for `--zoom` coarse-to-fine
   retrieval, with RAPTOR-style collapsed-tree recall beating tree traversal.

ColBERT / token-level was ruled out (10–30× storage, bespoke index).
RAPTOR tree-traversal was ruled out (collapsed-tree + filter-aware HNSW
matches recall at lower latency).

## Decision

Single `embeddings` table with a new `granularity` discriminator column
(`symbol | file | community`) and one HNSW index. Filter-aware traversal via
the `hnsw_acorn` community extension keeps one index serving every tier —
ACORN-1 pushes the granularity predicate into the graph walk, preserving
recall@10 at ~1 % selectivity per the extension's published benchmarks.

- Storage: add `granularity TEXT NOT NULL DEFAULT 'symbol'` + a b-tree index
  on the discriminator. Legacy v1.0 rows are backfilled by DEFAULT — no
  re-index required.
- Ingestion: `embeddings` phase accepts `embeddingsGranularity` and emits
  at the requested tiers. Symbol-tier text fuses the P04 summary when
  present; file-tier reads the scanned file (truncated at ~8k tokens);
  community-tier composes `inferredLabel + keywords + top symbols`.
- Search: `HybridQuery.mode = "zoom"` runs a coarse file-tier ANN, collects
  the file paths, then restricts the symbol-tier ANN to those files before
  RRF-fusing with BM25. Flat mode keeps its v1.0 semantics by pinning the
  default tier to `symbol`.
- CLI: `codehub analyze --granularity symbol,file,community` +
  `codehub query --zoom --fanout 10 --granularity community` surface the
  new capability without changing default behaviour.

## Consequences

- **Backward compatible**: v1.0 callers that never set `--granularity`
  emit the same symbol-tier rows, and v1.0 DuckDB files open under the
  v1.1 reader with all rows migrating to `'symbol'`.
- **One HNSW index, three tiers** keeps schema complexity bounded. Adding
  a fourth tier (e.g. folder-level) is a one-line enum widening.
- **Storage overhead ≈ 1.3×** per research — well under the 1.4× budget
  set in the packet specs.
- **Zoom latency**: ~2× the flat path on small indexes because it issues
  two vector-search round-trips. Above ~20k symbols the coarse filter
  amortises this; future work could collapse the pair into one SQL call.

## References

- Research:
  `.erpaval/sessions/2026-04-24-v1-backlog-and-framework-detection/research/hierarchical-embeddings.md`
- Packet:
  `.erpaval/sessions/2026-04-24-v1-backlog-and-framework-detection/packets/p03-hierarchical-embeddings/SPECS.md`
- `hnsw_acorn` DuckDB community extension
  (`INSTALL hnsw_acorn FROM community`).
- RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval
  (Sarthi et al., 2024).
