---
title: Storage backend
description: LadybugDB graph store + DuckDB temporal sibling, the IGraphStore / ITemporalStore segregation, the resolver, and the community-adapter escape hatch.
sidebar:
  order: 25
---

OpenCodeHub's M7 storage layer is two narrow interfaces, two adapters,
and a probe. The default is LadybugDB for the graph half and DuckDB
for the temporal half. The legacy single-file DuckDB layout is still
available as a fallback.

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
to handle cochange queries; a DuckDB-only deployment does not have to
implement Cypher. ADR 0013 (M7) describes the call-site refactor that
made this work — 108 raw-SQL call sites across `analysis/`, `mcp/`,
`pack/`, `wiki/`, and `cli/` now route through the typed finders on
the interfaces.

## The two adapters that ship

### LadybugDB graph store + DuckDB temporal store (default)

Two artifacts on disk:

| File | Holds |
|---|---|
| `<repo>/.codehub/graph.lbug` | Nodes, edges, embeddings, BM25 + HNSW indexes — everything `IGraphStore` owns. |
| `<repo>/.codehub/temporal.duckdb` | Cochanges, symbol-summary cache — everything `ITemporalStore` owns. |

The graph half speaks Cypher natively and stores each edge kind in
its own physical layout, which is the part of the M7 motivation that
DuckDB's polymorphic `relations` table could not match.

### Single DuckDB file (legacy / fallback)

| File | Holds |
|---|---|
| `<repo>/.codehub/graph.duckdb` | Nodes, edges, embeddings, BM25 + HNSW, cochanges, summary cache — one file backs both interfaces. |

Selected when:

- `CODEHUB_STORE=duck` is set explicitly, or
- The default-resolver probe cannot import `@ladybugdb/core` (e.g. the
  binding is not on the platform's npm distribution path), and there
  is no override.

The fallback emits a one-shot stderr advisory under TTY environments
or when `OCH_VERBOSE=1` is set; CI runs (no TTY, no opt-in) stay
quiet.

## The resolver

`resolveStoreBackendAsync(setting, env, probe)` picks the backend.

```
setting       env CODEHUB_STORE      probe(@ladybugdb/core)   →  backend
"auto"        unset                  importable               lbug
"auto"        unset                  not importable           duck   (with stderr advisory)
"auto"        "lbug"                 (any)                    lbug
"auto"        "duck"                 (any)                    duck
"lbug"        (any)                  importable               lbug
"lbug"        (any)                  not importable           THROWS — explicit request, no fallback
"duck"        (any)                  (any)                    duck
```

When both `graph.lbug` and `graph.duckdb` exist as siblings in the
same `.codehub/` directory, the **newer-mtime file wins**. This is
the dual-artifact precedence rule covered in ADR 0013.

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

OCH does not ship these adapters; the seam exists so that a team that
already operates one of these engines is not locked into the `@ladybugdb/core` package.
ADR 0013 names the four explicitly.

## Determinism across backends

The `graphHash` invariant holds across both adapters. A repo indexed
into LadybugDB and the same repo indexed into DuckDB at the same
commit produce the same hash. The CI parity gate that landed with M7
asserts this on every PR that touches `packages/storage`.

The implication: a developer can switch backends on a working repo
without re-indexing, as long as both artifact files exist.

## See also

- [ADR 0011 — LadybugDB graph backend](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0011-graph-db-backend.md)
- [ADR 0013 — Storage default + interface segregation](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-m7-default-flip-and-abstraction.md)
- [Configuration](/opencodehub/reference/configuration/) — env vars
  and on-disk layout.
