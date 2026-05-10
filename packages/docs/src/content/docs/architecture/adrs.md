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

DuckDB via `@duckdb/node-api` plus the `hnsw_acorn` community
extension for filter-aware vector search and the official `fts`
extension for BM25. SQLite + `sqlite-vec` was rejected because FTS5
has no filtered-HNSW story. Superseded as the default by ADR 0011 +
ADR 0013 (M7), but DuckDB is still the temporal-store backend and the
legacy single-file fallback.

[Read ADR 0001](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0001-storage-backend.md)

### ADR 0002 — Rust core spike deferred

v2.0 ships pure TypeScript. A Rust NAPI-RS native core is deferred
until measured numbers force the move; the latency / memory / cold
analyze budgets all sit comfortably below their reopen triggers.

[Read ADR 0002](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0002-rust-core-deferred.md)

### ADR 0004 — Hierarchical embeddings with filter-aware HNSW

One `embeddings` table with a `granularity` discriminator column
(`symbol | file | community`) and a single HNSW index. Filter-aware
traversal pushes the granularity predicate into the graph walk.
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

### ADR 0011 — graph-database backend (phase-1)

Add `@ladybugdb/core` as the opt-in graph-database backend behind the
existing `IGraphStore` seam. Default stays on DuckDB through M3 – M6.
Motivation: recursive-CTE traversals on the polymorphic `relations`
table do not get faster, and the predicate cannot be pushed into the
graph walk.

[Read ADR 0011](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0011-graph-db-backend.md)

### ADR 0012 — Repo as a first-class graph node

Promote `repo_uri`, `default_branch`, and `group` to typed graph
attributes on a `Repo` node. Backs the M6 federation surface
(`group_query`, `group_status`, `group_contracts`, `group_list`,
`group_cross_repo_links`) and the structured `AMBIGUOUS_REPO`
envelope returned by per-repo tools.

[Read ADR 0012](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0012-repo-as-first-class-node.md)

### ADR 0013 — M7 default-flip + storage abstraction

Flip the default to the graph-database backend and segregate `IGraphStore` from
`ITemporalStore`. The temporal half (cochanges, summary cache) stays
on DuckDB. Adds the community-adapter escape hatch (AGE / Memgraph /
Neo4j / Neptune) so OCH does not lock users into the graph-database backend.

[Read ADR 0013 (M7)](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-m7-default-flip-and-abstraction.md)

### ADR 0013 — Parse runtime: WASM default, native opt-in

Sibling ADR sharing the number 0013 (authored on a parallel branch).
WASM (`web-tree-sitter`) is the default parse runtime on Node 22 and
Node 24. Native (`tree-sitter` N-API addon) is opt-in via
`OCH_NATIVE_PARSER=1` on Node 22.

[Read ADR 0013 (parse runtime)](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-parse-runtime-wasm-default.md)

### ADR 0014 — SCIP REFERENCES + TYPE_OF emission, embedder fingerprint

Two unrelated holes shipped together because they share a one-time
fixture-regeneration cost. Wire up SCIP `REFERENCES` and `TYPE_OF`
edge emission alongside the existing `CALLS` and `IMPLEMENTS`.
Persist the embedder `modelId` in store metadata; refuse a query when
the configured embedder differs from the one that produced the stored
vectors (override available via documented force flag).

[Read ADR 0014](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0014-scip-references-and-embedder-fingerprint.md)

## Superseded

### ADR 0003 — CI toolchain pins

Superseded by ADR 0006. The gopls pin matrix is historical — OCH no
longer runs long-running language servers; oracle edges come from
SCIP.

[Read ADR 0003](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0003-ci-toolchain-pins.md)

## Adding an ADR

New architectural decisions go under `docs/adr/NNNN-slug.md` using the
next numeric prefix. Keep the headings: Status, Date, Context,
Decision, Consequences, plus any ADR-specific sections.

If a new decision supersedes an older one, update the superseded
ADR's status line with a forward link and add a reverse link from the
new ADR's context section.
