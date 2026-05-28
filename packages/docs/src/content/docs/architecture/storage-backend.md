---
title: Storage backend
description: LadybugDB graph store + DuckDB temporal sibling, the IGraphStore / ITemporalStore segregation, how openStore composes them, and the community-adapter escape hatch.
sidebar:
  order: 25
---

OpenCodeHub's storage layer is two narrow interfaces composed into one
store. The graph half is always LadybugDB; the temporal half is always
DuckDB. There is no backend selector, no probe, and no fallback layout
— `openStore()` composes a `GraphDbStore` (graph) with a `DuckDbStore`
(temporal) and returns both. If the LadybugDB binding fails to load,
`open()` throws `GraphDbBindingError` and the operation aborts.

## The interfaces

`@opencodehub/storage` exports two interfaces:

- **`IGraphStore`** — graph workload. Nodes, edges, embeddings,
  multi-hop traversal. Shape: properties + Cypher / Cypher-equivalent
  query surface.
- **`ITemporalStore`** — temporal workload. Cochanges, the
  symbol-summary cache. Statistical signals over git history that
  never enter `graphHash`.

Splitting the interfaces lets community adapters implement only the
half they have an engine for. A graph-only Neo4j adapter does not have
to handle cochange queries; the in-tree DuckDB temporal store does not
have to implement Cypher. `IGraphStore` lives only on `GraphDbStore`;
`DuckDbStore` implements `ITemporalStore` only — neither adapter
implements both. ADR 0013 records the call-site refactor that routed
108 raw-SQL call sites across `analysis/`, `mcp/`, `pack/`, `wiki/`,
and `cli/` through the typed finders on the interfaces; ADR 0016 then
ripped the DuckDB graph adapter out entirely.

## The single pair that ships

### LadybugDB graph store + DuckDB temporal store

Two artifacts on disk, both always present after `codehub analyze`:

| File | Holds |
|---|---|
| `<repo>/.codehub/graph.lbug` | Nodes, edges, embeddings, BM25 + HNSW indexes — everything `IGraphStore` owns. |
| `<repo>/.codehub/temporal.duckdb` | Cochanges, symbol-summary cache — everything `ITemporalStore` owns. |

The graph half speaks Cypher natively and stores each edge kind in
its own physical layout — the part of the motivation that DuckDB's
polymorphic `relations` table could not match. The temporal half runs
columnar SQL aggregations over git history, where DuckDB is the right
engine.

Embeddings live in `graph.lbug`. At pack time they stream from
`store.graph.listEmbeddings()` into a per-call DuckDB temp table on
`temporal.duckdb`, so the byte-identical `embeddings.parquet` sidecar
still works without a graph-tier round trip.

## How the store is composed

`openStore({path})` always returns
`{graph: GraphDbStore, temporal: DuckDbStore, graphFile, temporalFile, close}`.
There is no `backend` field on the result and no `backend?` option on
the input. The graph artifact is always `graph.lbug`; the temporal
artifact is always `temporal.duckdb`. The `CODEHUB_STORE` env var, the
dynamic-import probe of `@ladybugdb/core`, and the dual-artifact mtime
arbitration are all gone — removed in ADR 0016. If the LadybugDB
binding cannot load, `open()` throws `GraphDbBindingError`; there is no
DuckDB-as-graph fallback. `codehub doctor` hard-fails on a missing
binding (it warned and continued in the prior auto-probe era).

## Why the segregation, in one example

The clean motivation: cochange detection (the temporal-store workload)
runs over git history and produces frequency / co-edit scores. The
queries are columnar SQL aggregations that DuckDB is the right
engine for. The graph workload is a different shape — multi-hop
traversal across typed edge kinds — that benefits from a graph-native
engine. Segregating the two interfaces lets each backend specialize.

## Community adapters (escape hatch)

The two interfaces are deliberately narrow so a community adapter can
implement either independently. Candidates for `IGraphStore` adapters
include:

- **AGE** (Apache AGE — PostgreSQL extension that speaks Cypher).
- **Memgraph** (in-memory graph database, Cypher-compatible).
- **Neo4j** (the canonical Cypher engine).
- **Neptune** (AWS managed Cypher / Gremlin).

OCH ships only the LadybugDB + DuckDB pair; it does not ship these
adapters. The seam is a deliberate escape hatch — a team that already
operates one of these engines can supply an `IGraphStore` adapter and
pair it with the in-tree DuckDB `ITemporalStore`. The conformance
suite (`assertIGraphStoreConformance`) and the parity harness in
`packages/storage/src/test-utils/` stay precisely because they are the
v1.0 contract these community adapters target. ADR 0013 names the four
candidates explicitly; ADR 0016 confirms the segregated interfaces
survive the DuckDB-graph rip-out for exactly this reason.

## Determinism

The `graphHash` invariant covers everything `IGraphStore` owns and is
asserted by a CI gate on every PR that touches `packages/storage`. The
temporal signals in `temporal.duckdb` (cochanges, symbol summaries)
are statistical and never enter `graphHash`.

## See also

- [ADR 0011 — LadybugDB graph backend](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0011-graph-db-backend.md)
- [ADR 0013 — Storage default + interface segregation](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-m7-default-flip-and-abstraction.md)
- [ADR 0016 — Rip out the DuckDB graph backend](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0016-duckdb-graph-rip.md)
- [Configuration](/opencodehub/reference/configuration/) — env vars
  and on-disk layout.
