---
title: Architecture decision records
description: Index of OpenCodeHub ADRs at HEAD — every accepted and superseded decision.
sidebar:
  order: 30
---

Every load-bearing architectural choice in OpenCodeHub is recorded as
an ADR under `docs/adr/` in the repo. This page is the index. Click
through to the source ADR for the full context, candidates
considered, and consequences.

## Accepted

### ADR 0001 — Storage backend selection

Records the original v1.0 embedded storage baseline and the filtered
vector-search plus BM25 requirements it had to meet. Superseded by the
later storage line: the graph backend moved behind the `IGraphStore`
seam in ADR 0011 + ADR 0013, and ADR 0019 collapsed everything into one
`store.sqlite` file via Node's built-in `node:sqlite`.

[Read ADR 0001](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0001-storage-backend.md)

### ADR 0002 — Rust core spike deferred

v2.0 ships pure TypeScript. A Rust NAPI-RS native core is deferred
until measured numbers force the move; the latency / memory / cold
analyze budgets all sit comfortably below their reopen triggers.

[Read ADR 0002](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0002-rust-core-deferred.md)

### ADR 0004 — Hierarchical embeddings with filter-aware vector search

One `embeddings` table with a `granularity` discriminator column
(`symbol | file | community`) and a single vector index. Filter-aware
traversal pushes the granularity predicate into the search.
ColBERT-style and RAPTOR were rejected.

[Read ADR 0004](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0004-hierarchical-embeddings.md)

### ADR 0005 — SCIP replaces LSP

Per-LSP phases and `@opencodehub/lsp-oracle` are deleted in favour of
a single `scip-index` phase backed by `@opencodehub/scip-ingest`.
Oracle-edge provenance switches to `scip:<indexer>@<version>`.

[Read ADR 0005](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0005-scip-replaces-lsp.md)

### ADR 0006 — SCIP indexer CI pins

The pin table for every per-language SCIP indexer plus install
channel. New indexers (scip-clang, scip-dotnet, scip-kotlin,
scip-ruby) are appended to the same table as they land.

[Read ADR 0006](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0006-scip-indexer-pins.md)

### ADR 0007 — Artifact factory

The artifact-generation skill family inside `plugins/opencodehub/`
that turns the graph into committed Markdown. Four P0 skills,
subagents, Phase 0 precompute, `.docmeta.json`, deterministic Phase E
assembler.

[Read ADR 0007](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0007-artifact-factory.md)

### ADR 0008 — Document pattern port

The four-phase document pattern (Phase 0 precompute → Phase AB
parallel content → Phase CD parallel diagrams + specialty → Phase E
deterministic assembler), adapted for OpenCodeHub.

[Read ADR 0008](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0008-document-pattern-port.md)

### ADR 0009 — Artifact output conventions

Single authoritative output contract. `.codehub/docs/` gitignored
default; `--committed` opts in to `docs/codehub/`. Backtick citation
grammar. `.docmeta.json` schema v1. Mermaid-only diagrams. 20-node
diagram cap with a Legend table for overflow.

[Read ADR 0009](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0009-artifact-output-conventions.md)

### ADR 0010 — Three dogfood findings from 2026-04-27

Three small fixes after dogfooding `codehub init` and the artifact
factory: parallel embedding workers default, `codehub list` health
column, Phase 0 schema preflight.

[Read ADR 0010](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0010-dogfood-findings-2026-04-27.md)

### ADR 0011 — Graph-native backend (phase-1)

Introduces a graph-native backend behind the `IGraphStore` seam.
Motivation: recursive-CTE traversals on the polymorphic `relations`
table do not get faster, and the predicate cannot be pushed into the
graph walk. The concrete engine chosen here was later replaced by the
single `store.sqlite` file in ADR 0019; the `IGraphStore` seam it
established survives.

[Read ADR 0011](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0011-graph-db-backend.md)

### ADR 0012 — Repo as a first-class graph node

Promote `repo_uri`, `default_branch`, and `group` to typed graph
attributes on a `Repo` node. Backs the cross-repo federation surface
(`group_query`, `group_status`, `group_contracts`, `group_list`,
`group_cross_repo_links`) and the structured `AMBIGUOUS_REPO`
envelope returned by per-repo tools.

[Read ADR 0012](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0012-repo-as-first-class-node.md)

### ADR 0013 — Storage default + interface segregation

Segregates `IGraphStore` from `ITemporalStore` so each half can be
implemented independently, and establishes the community-adapter escape
hatch (AGE / Memgraph / Neo4j / Neptune). The default backend it named
was superseded by ADR 0019, which implements both interfaces on one
`SqliteStore`; the interface segregation and the escape hatch it defined
both survive.

[Read ADR 0013](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-m7-default-flip-and-abstraction.md)

### ADR 0014 — SCIP REFERENCES + TYPE_OF emission, embedder fingerprint

Two unrelated holes shipped together because they share a one-time
fixture-regeneration cost. Wire up SCIP `REFERENCES` and `TYPE_OF`
edge emission alongside the existing `CALLS` and `IMPLEMENTS`.
Persist the embedder `modelId` in store metadata; refuse a query when
the configured embedder differs from the one that produced the stored
vectors (override available via documented force flag).

[Read ADR 0014](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0014-scip-references-and-embedder-fingerprint.md)

### ADR 0015 — WASM-only parser at the npm-distributed boundary

Drop native `tree-sitter` from the install graph entirely. WASM
(`web-tree-sitter`) is now the only parse runtime on Node ≥24.15. All
15 grammar `.wasm` blobs are vendored at
`packages/ingestion/vendor/wasms/`. `npm install -g @opencodehub/cli@latest`
does zero native builds and zero GitHub fetches. Supersedes ADR 0013
(parse runtime).

[Read ADR 0015](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0015-wasm-only-parser-at-the-npm-distributed-boundary.md)

### ADR 0016 — Graph-backend rip-out

Removes the `CODEHUB_STORE` env var, the backend probe, and the
selector, settling storage on a two-file native pair with the segregated
`IGraphStore` / `ITemporalStore` interfaces preserved for community
forks. **Superseded by ADR 0019**, which collapses that pair into one
`store.sqlite` file and removes both native storage bindings. The
segregated interfaces it kept survive unchanged.

[Read ADR 0016](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0016-duckdb-graph-rip.md)

### ADR 0018 — Cleanroom tool-name provenance

Records the cleanroom provenance of the route / tool / contract tool
names, documenting the independent-derivation trail for each name.

[Read ADR 0018](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0018-cleanroom-tool-name-provenance.md)

### ADR 0019 — Single-file SQLite storage

Collapses the entire index into one `<repo>/.codehub/store.sqlite` file
(WAL mode) via Node's built-in `node:sqlite` (`DatabaseSync`, enabled by
default on Node ≥24.15). One `SqliteStore` implements both `IGraphStore`
and `ITemporalStore`; `openStore()` returns that single instance as both
the `graph` and `temporal` views, so call sites use `store.graph.X()` /
`store.temporal.Y()` unchanged. Both native storage bindings are removed
and the write-only Parquet embeddings sidecar is dropped, so the
code-pack becomes an 8-item BOM and the install carries zero native
storage dependencies. Every platform is supported, including Windows
arm64 and Linux musl (Alpine). Supersedes ADR 0016 in its entirety; the
segregated interfaces stay as the community-fork escape hatch.

[Read ADR 0019](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0019-single-file-sqlite-storage.md)

### ADR 0020 — Decision-equivalence supersedes byte-identity

Makes decision-equivalence the pack contract and treats byte-identity as
a witness rather than the contract itself. Pairs with the pack
determinism spec.

[Read ADR 0020](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0020-decision-equivalence-supersedes-byte-identity.md)

### ADR 0017 — Drop detect-secrets, tune betterleaks

Remove `detect-secrets` from the scanner fleet in favour of
`betterleaks`, bringing the catalog to 19 scanners. Records the
tuning rationale and the secret-detection coverage tradeoff.

[Read ADR 0017](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0017-drop-detect-secrets-tune-betterleaks.md)

## Superseded

### ADR 0003 — CI toolchain pins

Superseded by ADR 0006. The gopls pin matrix is historical — OCH no
longer runs long-running language servers; oracle edges come from
SCIP.

[Read ADR 0003](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0003-ci-toolchain-pins.md)

### ADR 0013 — Parse runtime: WASM default, native opt-in

Superseded by ADR 0015 (2026-05-15). The WASM-default + native-opt-in
posture has been replaced by WASM-only at the npm-distributed boundary.
The native opt-in (env var + CLI flag) was removed in 0.4.0; see ADR
0015 and the per-package CHANGELOGs for migration notes.

[Read ADR 0013 (parse runtime)](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-parse-runtime-wasm-default.md)

## Adding an ADR

New architectural decisions go under `docs/adr/NNNN-slug.md` using the
next numeric prefix. Keep the headings: Status, Date, Context,
Decision, Consequences, plus any ADR-specific sections.

If a new decision supersedes an older one, update the superseded
ADR's status line with a forward link and add a reverse link from the
new ADR's context section.
