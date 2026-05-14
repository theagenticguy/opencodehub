---
title: Indexing a repo
description: Run codehub analyze, add embeddings, go offline, and manage .codehub state.
sidebar:
  order: 10
---

`codehub analyze` is the full indexing pipeline: parse with
tree-sitter (and SCIP for every language with a pinned indexer —
TypeScript, Python, Go, Rust, Java, C#, C/C++, Kotlin, Ruby), resolve
imports and inheritance, detect processes and clusters, build BM25
and HNSW indexes, and write everything to `.codehub/` under the repo
root.

The default backend is **LadybugDB** for the graph half +
**DuckDB** for the temporal sibling. Set `CODEHUB_STORE=duck` to
force the single-file DuckDB layout. See
[Storage backend](/opencodehub/architecture/storage-backend/).

## Basic indexing

```bash title="index the current repo"
codehub analyze
```

Re-run after significant changes. A no-op short-circuit skips work if
the index already matches `HEAD`; pass `--force` to rebuild.

## Add semantic vectors

```bash title="full index with embeddings"
codehub analyze --embeddings
```

`--embeddings` computes symbol and optional file/community vectors and
writes them to the HNSW index. After this, `codehub query` fuses BM25
and vector results via reciprocal-rank fusion (RRF).

Memory-constrained machines can use `--embeddings-int8` for quantised
vectors, `--embeddings-workers auto` to tune the worker pool, or
`--embeddings-batch-size 32` (default) to tune batch throughput.

## Zero-network indexing

```bash title="offline mode — no sockets"
codehub analyze --offline
```

`--offline` disables every code path that would open a socket. Combine
with cached embedder weights (see `codehub setup --embeddings
--model-dir <path>`) to index fully air-gapped.

## Staleness and status

```bash title="check index freshness"
codehub status
```

`status` compares the index against the working tree and reports
staleness. MCP responses also carry an envelope field
`_meta["codehub/staleness"]` whenever the index lags `HEAD`, so agents
can detect drift without polling.

## Resetting the index

```bash title="delete the .codehub/ directory"
codehub clean
```

`codehub clean --all` deletes every index registered on the machine and
wipes `~/.codehub/registry.json`.

## Granularity

```bash title="index at symbol, file, and community level"
codehub analyze --granularity symbol,file,community
```

The pipeline produces hierarchical embeddings so a single query can
surface a symbol, the file that contains it, and the community the
symbol participates in. The default granularity is `symbol`.

## What lives in `.codehub/`

The contents depend on the storage backend selected at index time.
On the default LadybugDB layout:

| Path | Purpose |
|---|---|
| `graph.lbug` | LadybugDB graph store — symbols, edges, embeddings, BM25 + HNSW indexes. |
| `temporal.duckdb` | DuckDB sibling — cochanges, symbol-summary cache. |
| `meta.json` | Index metadata (graph hash, node counts, CLI version, toolchain pins, embedder modelId). |
| `scan.sarif` | SARIF scan output when `codehub scan` has run. |
| `sbom.cyclonedx.json` / `sbom.spdx.json` | SBOMs when `codehub analyze --sbom` has run. |

On the single-file DuckDB fallback, `graph.duckdb` replaces both
`graph.lbug` and `temporal.duckdb`.

## Other useful flags

- `--sbom` — emit a CycloneDX SBOM alongside the index.
- `--coverage` — bridge coverage data into the graph.
- `--summaries` / `--no-summaries` — LLM-generated symbol summaries
  (default off — `codehub analyze` is fast, local, deterministic by
  default; opt in with `--summaries` or `CODEHUB_BEDROCK_SUMMARIES=1`).
  When enabled, the budget is capped by `--max-summaries`, default
  `auto` = 10% of callables, hard cap 500.
- `--skills` — generate Claude Code skills from the graph.
- `--native-parser` — opt into the native tree-sitter N-API addon on
  Node 22 (the default runtime is `web-tree-sitter` / WASM).
- `--strict-detectors` — fail the build if a detector (DET-O-001)
  regresses.
- `--verbose` — noisier logs.

See [CLI reference: analyze](/opencodehub/reference/cli/#analyze) for
the complete flag list.
