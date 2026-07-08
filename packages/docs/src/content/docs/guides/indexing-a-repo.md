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
and vector indexes, and write everything to `.codehub/` under the repo
root.

The whole index lives in one **`store.sqlite`** file (WAL mode) under
`.codehub/`, via Node's built-in `node:sqlite`. It holds graph nodes,
edges, embeddings, and the temporal tables, and it is written on every
analyze. There is no backend knob and no native storage binding (ADR
0019). See
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
writes them to the `embeddings` table. After this, `codehub query` fuses BM25
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

Every index writes the same single-file layout: one `store.sqlite` via
Node's built-in `node:sqlite`:

| Path | Purpose |
|---|---|
| `store.sqlite` | The whole index (WAL mode) — symbols, edges, embeddings, the FTS5 search index, and the temporal tables (cochanges). |
| `store.sqlite-wal` / `store.sqlite-shm` | WAL companions present while a writer is open; collapse into `store.sqlite` at close. |
| `meta.json` | Index metadata (graph hash, node counts, CLI version, toolchain pins, embedder modelId). |
| `scan.sarif` | SARIF scan output when `codehub scan` has run. |
| `sbom.cyclonedx.json` / `sbom.spdx.json` | SBOMs when `codehub analyze --sbom` has run. |

## What runs by default

A bare `codehub analyze` produces a production-grade `.codehub/` folder
in one command:

- Graph pipeline (tree-sitter parse + SCIP resolution + communities +
  processes + cochanges + ownership + dependencies + detectors).
- SBOM emission (CycloneDX + SPDX) — **default on**; suppress with
  `--no-sbom`.
- Priority-1 scanners → `.codehub/scan.sarif` + findings ingested into
  the graph — **default on**; suppress with `--no-scan`.
  Network-backed scanners (osv-scanner, grype, npm/pip audit) self-skip
  under `--offline`, so the on-default stays honest.
- Coverage overlay — **default auto**: runs only when a report is
  present at `coverage/lcov.info`, `lcov.info`, `coverage.xml`,
  `build/reports/jacoco/test/jacocoTestReport.xml`, or `coverage.json`.
  Silent no-op otherwise. Force with `--coverage`; force off with
  `--no-coverage`.

Everything else — embeddings, skills — is opt-in.

## Opt-in flags

- `--embeddings` — compute semantic vectors for queries by meaning.
  Requires `codehub setup --embeddings` first.
- `--skills` — generate Claude Code skills from the graph.
- `--strict-detectors` — fail the build if a detector (DET-O-001)
  regresses.
- `--verbose` — noisier logs.

See [CLI reference: analyze](/opencodehub/reference/cli/#analyze) for
the complete flag list.
