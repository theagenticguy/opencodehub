---
title: Storage backend
description: One store.sqlite file backs the whole index via node:sqlite, the SqliteStore class that implements both IGraphStore and ITemporalStore, how openStore composes them, and the community-adapter escape hatch.
sidebar:
  order: 25
---

OpenCodeHub's storage layer is two narrow interfaces implemented by one
class over one file. The entire index lives in a single
`<repo>/.codehub/store.sqlite` (WAL mode) via Node's built-in
`node:sqlite`. A single `SqliteStore` implements both `IGraphStore` and
`ITemporalStore`, and `openStore()` returns that one instance as both
the `graph` and `temporal` views. There is no backend selector, no
native binding to probe, and no fallback layout. ADR 0019 removed both
`@ladybugdb/core` and `@duckdb/node-api`, so there are zero native
storage bindings.

## The interfaces

`@opencodehub/storage` exports two interfaces:

- **`IGraphStore`** — graph workload. Nodes, edges, embeddings,
  multi-hop traversal.
- **`ITemporalStore`** — temporal workload. Cochanges, the
  symbol-summary cache. Statistical signals over git history that
  never enter `graphHash`.

The interfaces stay segregated so a community adapter can implement only
the half it has an engine for. A graph-only Neo4j adapter does not have
to handle cochange queries, and a temporal-only adapter does not have to
implement graph traversal. In the shipping build, one `SqliteStore`
implements both. ADR 0013 records the call-site refactor that routed
108 raw-SQL call sites across `analysis/`, `mcp/`, `pack/`, `wiki/`,
and `cli/` through the typed finders on the interfaces.

## The single store that ships

### One store.sqlite file, backed by node:sqlite

One artifact on disk, always present after `codehub analyze`:

| File | Holds |
|---|---|
| `<repo>/.codehub/store.sqlite` | Nodes, edges, embeddings, BM25 (FTS5) indexes, and the temporal tables (cochanges, symbol-summary cache). The entire index. |

`node:sqlite` (`DatabaseSync`, enabled by default on Node ≥24.15, the
engines floor) provides every primitive the store needs: BLOB storage
for `Float32Array` embeddings, recursive CTEs for graph traversal
(impact and blast-radius), WAL for crash-safe concurrent reads, and FTS5
for BM25 search. It is in the standard library, so the store adds zero
install weight.

WAL companions `store.sqlite-wal` and `store.sqlite-shm` appear while a
writer is open and collapse back to the single file on
`wal_checkpoint(TRUNCATE)` at close.

Embeddings live in the `embeddings` table inside `store.sqlite`
(BLOB-exact and directly queryable). At pack time they stream from
`store.graph.listEmbeddings()` straight into the code-pack; there is no
Parquet sidecar and no separate temporal file to round-trip through.

## Schema

- One generic **`nodes`** table: typed columns for the universal base
  (`id, kind, name, file_path, start_line, end_line`) plus a JSON
  `payload` overflow for the 37 kind-specific shapes, rehydrated on
  read. Findings reuse this table with `kind='Finding'`.
- One polymorphic **`edges`** table keyed by the `(from, to, type,
  step)` dedup tuple.
- An **FTS5** virtual table over node names, signatures, and
  descriptions for `search`.
- **Recursive CTEs** for multi-hop traversal (impact and blast-radius).

The `embeddings` table holds all three granularities (symbol / file /
community) keyed by a `granularity` discriminator, so one table serves
every tier.

## How the store is composed

`openStore({path})` opens one `store.sqlite` and returns
`{graph, temporal, storeFile, close}`, where `graph` and `temporal` are
the same `SqliteStore` instance viewed through each interface. All
existing call sites keep working unchanged: `store.graph.X()` reaches
the graph surface, `store.temporal.Y()` reaches the temporal surface.
There is no `backend` field on the result and no `backend?` option on
the input. The `CODEHUB_STORE` env var, the dynamic-import probe of
`@ladybugdb/core`, and the dual-artifact mtime arbitration are all gone.
`codehub doctor` drops the native-binding probes and gains a
`node:sqlite` builtin check: an import plus a WAL round-trip. There is
no native storage binding left to probe.

## Why one file

A single embedded file removes the native binding from the install hot
path. `npm i -g @opencodehub/cli` plus Node ≥24.15 is the whole install:
no Docker, no postinstall compile, no second process. Every platform is
supported, including Windows arm64 and Linux musl (Alpine), because there
is no per-platform prebuilt to match. The graph and temporal workloads
still map to distinct primitives inside SQLite: recursive CTEs for
multi-hop traversal across typed edge kinds, and columnar aggregations
for cochange frequency and co-edit scores over git history.

## Community adapters (escape hatch)

The two interfaces stay deliberately narrow so a community adapter can
implement either independently. Candidates for `IGraphStore` adapters
include:

- **AGE** (Apache AGE — PostgreSQL extension that speaks Cypher).
- **Memgraph** (in-memory graph database, Cypher-compatible).
- **Neo4j** (the canonical Cypher engine).
- **Neptune** (AWS managed Cypher / Gremlin).

OCH ships one `SqliteStore` that implements both interfaces; it does not
ship these adapters. The seam is a deliberate escape hatch: a team that
already operates one of these engines can supply an `IGraphStore`
adapter and pair it with a temporal implementation, or implement both on
one class. The conformance suite
(`assertIGraphStoreConformance`) and the parity harness in
`packages/storage/src/test-utils/` stay precisely because they are the
v1.0 contract these community adapters target. ADR 0013 names the four
candidates explicitly, and ADR 0019 confirms the segregated interfaces
survive the move to a single store for exactly this reason.

## Determinism

The `graphHash` invariant covers everything `IGraphStore` owns and is
asserted by a CI gate on every PR that touches `packages/storage`. The
temporal signals in `store.sqlite` (cochanges, symbol summaries) are
statistical and never enter `graphHash`. The migration's hard gate was
that a `KnowledgeGraph` rebuilt from `listNodes({})` + `listEdges({})`
must hash byte-identically to the original;
`sqlite-parity.test.ts` proves it across small and mixed-kind fixtures.

## See also

- [ADR 0011 — LadybugDB graph backend](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0011-graph-db-backend.md)
- [ADR 0013 — Storage default + interface segregation](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-m7-default-flip-and-abstraction.md)
- [ADR 0019 — Single-file SQLite storage](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0019-single-file-sqlite-storage.md)
- [Configuration](/opencodehub/reference/configuration/) — env vars
  and on-disk layout.
