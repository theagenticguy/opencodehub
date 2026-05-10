---
title: Architecture overview
description: Six-phase pipeline from source tree to MCP — parse, resolve, augment, index, cluster, serve — backed by a graph-native store with deterministic outputs.
sidebar:
  order: 10
---

OpenCodeHub turns a source tree into a typed graph that agents can
query over MCP. The pipeline has six phases, and each phase has one
job. This page is the index. Each section names a phase, states its
one job, and links to the page that covers it in depth.

## Pipeline at a glance

```mermaid
flowchart LR
  tree[Source tree] --> parse[Parse]
  parse --> resolve[Resolve]
  resolve --> augment[Augment<br/>SCIP]
  augment --> index[Index<br/>BM25 + HNSW]
  index --> cluster[Cluster<br/>communities + processes]
  cluster --> serve[Serve<br/>MCP]
```

Fifteen tree-sitter grammars produce a unified `ParseCapture` stream.
Per-language resolvers turn captures into typed relations. SCIP
indexers (TypeScript, Python, Go, Rust, Java, C#, C/C++, Kotlin,
Ruby) upgrade heuristic edges to compiler-grade references where
available. The graph persists into LadybugDB by default, with DuckDB
carrying the temporal sibling. Communities and
processes are precomputed. An stdio MCP server with 29 tools answers
agent queries.

## Where the data lives

The default backend is **LadybugDB**, with **DuckDB** as the temporal
sibling. The legacy single-file DuckDB layout is still supported via
`CODEHUB_STORE=duck`. See [Storage backend](/opencodehub/architecture/storage-backend/).

```mermaid
flowchart LR
  subgraph lbug[".codehub/ (default)"]
    nodes[(graph.lbug<br/>nodes + edges)]
    embed[(embeddings)]
    temporal[(temporal.duckdb<br/>cochanges, summary cache)]
  end
  fts["BM25 over names + summaries"] --- nodes
  hnsw["filter-aware HNSW"] --- embed
  nodes -. round-trip parity .- temporal
```

Embeddings live in the same physical store as the graph (one
`embeddings` table, one HNSW index, three granularities keyed by a
`granularity` discriminator). Findings reuse the `nodes` table with
`kind='Finding'`.

## The six phases

### 1. Parse — source tree to captures

One job: lex every file with its tree-sitter grammar and emit a
`ParseCapture[]` stream in a unified schema (tag, text, start/end
line+col, nodeType). Lines are 1-indexed, columns 0-indexed.

Fifteen languages are registered via a compile-time exhaustive
`satisfies Record<LanguageId, LanguageProvider>` table: TypeScript,
TSX, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby, Kotlin,
Swift, PHP, Dart. The runtime is `web-tree-sitter` (WASM) by default
on both Node 22 and Node 24; the native N-API addon is opt-in.

See [Parsing and resolution](/opencodehub/architecture/parsing-and-resolution/).

### 2. Resolve — captures to typed relations

One job: turn captures into typed edges (`DEFINES`, `HAS_METHOD`,
`HAS_PROPERTY`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `CALLS`,
`REFERENCES`, `TYPE_OF`) by resolving names against a per-language
symbol scope.

A three-tier resolver handles the common case (same-file 0.95,
import-scoped 0.9, global 0.5). Python and the TS family opt into a
stack-graphs backend for tighter cross-module resolution. Heritage
linearization is per-language: C3, first-wins, single-inheritance, or
no-op.

See [Parsing and resolution](/opencodehub/architecture/parsing-and-resolution/).

### 3. Augment — SCIP indexers upgrade edges

One job: run each repo's SCIP indexer, parse the resulting `.scip`
protobuf, and emit `CALLS`, `REFERENCES`, `IMPLEMENTS`, and `TYPE_OF`
edges with `confidence=1.0` and `reason=scip:<indexer>@<version>`. The
`confidence-demote` phase then rescales any heuristic edge the SCIP
oracle contradicts from 0.5 to 0.2.

Pinned indexers cover TypeScript / TSX / JavaScript (scip-typescript),
Python (scip-python), Go (scip-go), Rust (rust-analyzer), Java
(scip-java), C# (scip-dotnet), C/C++ (scip-clang), Kotlin (scip-kotlin),
and Ruby (scip-ruby). Pins live in `.github/workflows/gym.yml`.

See [SCIP reconciliation](/opencodehub/architecture/scip-reconciliation/).

### 4. Index — BM25, HNSW, and scanners

One job: persist the graph into the selected backend with search
indexes wired up.

- **BM25** — over symbol names, signatures, and summaries.
- **HNSW** — filter-aware, with the granularity discriminator pushed
  into the predicate so all three tiers (symbol / file / community)
  share one index without recall collapse.
- **Multi-hop traversal** — Cypher-emitting dialect on the graph
  backend; recursive CTEs (`USING KEY`) on the legacy DuckDB layout.

Embeddings are optional, gated on `PipelineOptions.embeddings`. The
backend cascade is SageMaker → HTTP / OpenAI-compatible → local ONNX.

Scanners run separately through the `scan` MCP tool, merging SARIF
onto disk and indexing findings back into the `nodes` table.

See [Embeddings](/opencodehub/architecture/embeddings/) and
[Scanners and SARIF](/opencodehub/architecture/scanners-and-sarif/).

### 5. Cluster — communities and processes

One job: group related symbols into communities (Louvain) and walk
call chains to produce processes (handler → service → data access).
Both are precomputed so MCP tools read them directly.

Symbol-level LLM summaries are produced here when enabled. Summaries
are fused into the symbol-tier embedding text at ingestion time (not
query time) so retrieval runs against a pre-fused vector.

See [Summarization and fusion](/opencodehub/architecture/summarization-and-fusion/).

### 6. Serve — MCP over stdio

One job: expose the graph through an stdio MCP server (`codehub
mcp`). Twenty-nine tools, seven resources, zero canned prompts. Every
tool returns a structured envelope with `next_steps` and, when the
index lags HEAD, a `_meta["codehub/staleness"]` block. No daemon, no
socket, no remote state.

See [MCP overview](/opencodehub/mcp/overview/) and
[MCP tools](/opencodehub/mcp/tools/).

## Why this shape

OpenCodeHub's primary user is an AI coding agent that needs callers,
callees, processes, and blast radius in one tool call — and needs the
answer to be reproducible across runs. The six-phase shape is the
cheapest configuration that hits all three:

- **Local + offline.** The default storage stack is embedded;
  `codehub analyze --offline` opens zero sockets.
- **Deterministic.** Phases are pure: same inputs → same outputs,
  byte-identical `graphHash`. The `graphHash` invariant holds across
  both the LadybugDB and DuckDB backends. See
  [Determinism](/opencodehub/architecture/determinism/).
- **Apache-2.0, every transitive dep on the permissive allowlist.**
  No BSL, no AGPL, no source-available engines in the core. See
  [Supply chain](/opencodehub/architecture/supply-chain/).

## Reference ADRs

| ADR | Topic |
|---|---|
| 0001 | Storage backend selection — DuckDB + `hnsw_acorn` + `fts` (the v1.0 baseline). |
| 0002 | Rust core deferred — v2.0 stays pure TypeScript. |
| 0004 | Hierarchical embeddings — one table, three granularities, filter-aware HNSW. |
| 0005 | SCIP replaces LSP — compiler-grade edges without long-running language servers. |
| 0006 | SCIP indexer CI pins — current version table per language. |
| 0007–0010 | Artifact factory, document pattern, output conventions, dogfood findings. |
| 0011 | LadybugDB (phase-1) — graph-native backend behind the `IGraphStore` seam. |
| 0012 | Repo as a first-class graph node — `repo_uri`, group registry, `AMBIGUOUS_REPO` envelope. |
| 0013 (M7) | Default-flip + interface segregation — LadybugDB by default, DuckDB temporal sibling. |
| 0013 (parse) | WASM-default parse runtime on Node 22 and Node 24. |
| 0014 | SCIP REFERENCES + TYPE_OF emission, embedder modelId stamping. |

See [ADRs](/opencodehub/architecture/adrs/) for the full list.

## Related pages

- [Monorepo map](/opencodehub/architecture/monorepo-map/) — every
  workspace package and what it owns.
- [Storage backend](/opencodehub/architecture/storage-backend/) — the
  M7 default-flip + interface segregation.
- [Cross-repo federation](/opencodehub/architecture/cross-repo-federation/)
  — `repo_uri`, the group registry, and the `AMBIGUOUS_REPO` envelope.
- [Determinism](/opencodehub/architecture/determinism/) — the
  reproducibility contract.
- [Supply chain](/opencodehub/architecture/supply-chain/) — SBOM,
  cosign, SLSA L3, license allowlist.
