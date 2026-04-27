---
title: Architecture overview
description: The top-down pipeline — parse, resolve, augment, index, cluster, serve.
sidebar:
  order: 10
---

OpenCodeHub turns a source tree into a typed graph that agents can
query over MCP. The pipeline has six phases, and each phase has one
job.

## The pipeline

### 1. Input — source tree to parse captures

The CLI walks the repo, dispatches each file to its language's
tree-sitter grammar via `@opencodehub/ingestion`, and emits a unified
`ParseCapture` stream. Fifteen languages are registered today:
TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby,
Kotlin, Swift, PHP, Dart. The registry is compile-time exhaustive via
a `satisfies Record<LanguageId, LanguageProvider>` clause — omitting a
language becomes a build-time error.

### 2. Resolve — captures to typed relations

Each language provider emits definitions, calls, imports, heritage,
and optional property-access records. A per-language resolver — C3
linearization for Python, first-wins for TypeScript/JavaScript/Rust,
single-inheritance for Java/C#/Kotlin, no-op for Go — turns call
captures into typed `CALLS`, `EXTENDS`, `IMPLEMENTS`, `FETCHES`, and
`ACCESSES` relations.

Import semantics drive how the resolver chases cross-module names:
`named` (most languages), `namespace` (Python), or `package-wildcard`
(Go). See
[Adding a language provider](/opencodehub/contributing/adding-a-language-provider/)
for the full taxonomy.

### 3. Augment — SCIP indexers upgrade heuristic edges

Five languages (TypeScript, Python, Go, Rust, Java) have a SCIP
indexer pinned in `.github/workflows/gym.yml`. For those, the
`scip-index` phase runs the indexer once per repo, reads the resulting
`.scip` protobuf via `@opencodehub/scip-ingest`, and reconciles
heuristic edges against compiler-grade references. The
`confidence-demote` phase re-ranks any heuristic edge that SCIP
contradicts so downstream phases see a single, coherent graph.

Provenance is explicit: oracle-derived edges carry a
`scip:<indexer>@<version>` prefix and are visible to consumers.

### 4. Index — BM25 + HNSW in DuckDB

`@opencodehub/storage` persists the graph into an embedded DuckDB
database with three extensions:

- **`fts`** — BM25 scoring over symbol names, docstrings, and file
  paths.
- **`hnsw_acorn`** — HNSW index with predicate-aware traversal, so
  `WHERE language='python'` and `WHERE granularity='community'`
  actually return results rather than collapsing to zero on selective
  filters. Includes RaBitQ quantization for 21-30× memory reduction.
- **Recursive CTEs with `USING KEY`** — memory-efficient multi-hop
  graph traversal, used by `impact`, `context`, and `detect_changes`.

Embeddings are optional. When enabled, one `embeddings` table stores
vectors at three granularities — symbol, file, community — keyed by a
`granularity` discriminator so one HNSW index serves every tier.

### 5. Cluster — communities and processes

Community detection groups related symbols into architectural units;
execution-flow detection walks call chains to produce "processes" that
represent end-to-end scenarios (request handler → service → data
access). Both are precomputed at index time so MCP tools can return
them without per-call compute.

### 6. Serve — MCP server over stdio

`@opencodehub/mcp` exposes the graph through an stdio MCP server
(`codehub mcp`). Every tool returns a structured envelope with
`next_steps: string[]` and, when the index lags HEAD, a
`_meta["codehub/staleness"]` block so agents can decide whether to
re-analyze before acting.

The server is a local subprocess. There is no daemon, no socket, no
remote state.

## Why this shape

OpenCodeHub's primary user is an AI coding agent that needs callers,
callees, processes, and blast radius in one tool call — and needs the
answer to be reproducible across runs. The six-phase shape is the
cheapest configuration that hits all three:

- **Local + offline.** DuckDB is embedded. Indexing reads the
  filesystem, nothing else. `codehub analyze --offline` opens zero
  sockets.
- **Deterministic.** Phases are pure: same inputs → same outputs,
  byte-identical `graphHash`. See [Determinism](/opencodehub/architecture/determinism/).
- **Apache-2.0, every transitive dep on the permissive allowlist.**
  DuckDB is MIT, `hnsw_acorn` is MIT, tree-sitter is MIT. No BSL, no
  AGPL, no source-available engines in the core. See
  [Supply chain](/opencodehub/architecture/supply-chain/).

## Reference ADRs

| ADR | Topic                                                                       |
|-----|-----------------------------------------------------------------------------|
| 0001 | Storage backend selection — why DuckDB + `hnsw_acorn` + `fts`              |
| 0002 | Rust core deferred to v2.1+ — why v2.0 stays pure TypeScript               |
| 0004 | Hierarchical embeddings — one table, three granularities, filter-aware HNSW |
| 0005 | SCIP replaces LSP — compiler-grade edges without long-running language servers |
| 0006 | SCIP indexer CI pins — current version table per language                  |

See [ADRs](/opencodehub/architecture/adrs/) for the full list and
decisions.

## Related pages

- [Monorepo map](/opencodehub/architecture/monorepo-map/) — every
  workspace package and what it owns.
- [Determinism](/opencodehub/architecture/determinism/) — the
  reproducibility contract and how it is tested.
- [Supply chain](/opencodehub/architecture/supply-chain/) — SBOM,
  license allowlist, vulnerability posture.
