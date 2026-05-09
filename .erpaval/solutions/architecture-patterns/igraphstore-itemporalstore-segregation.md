---
title: Segregate graph-only and tabular-only stores at the interface boundary
tags: [interface-segregation, liskov, storage, multi-backend, igraphstore]
session: session-33f24f
---

## Context

`IGraphStore` originally extended `CochangeStore + SymbolSummaryStore` and
exposed `query(sql, params)`. `GraphDbStore` (LadybugDB) couldn't honestly
satisfy `lookupCochangesForFile` — it threw `NotImplementedError` on six
methods. The "obvious" fix was to *implement* cochanges on the graph
adapter. The clean fix was to *delete* those signatures from the graph
interface entirely.

After AC-A-1 (split) + AC-A-3 (residue cleanup): `IGraphStore` is graph-only
(Cypher dialect or none). `ITemporalStore` is tabular-only (SQL `exec()` +
cochanges + symbol summaries). `openStore({path, backend}) -> {graph,
temporal, close, describe}` composes both. DuckDB-only deployments share
one connection between views via structural typing — no class split. LadybugDB
deployments open `graph.lbug` + `temporal.duckdb` as siblings.

## Lesson

When one type extends multiple sub-interfaces and a concrete implementor
can't honestly satisfy all of them, segregate at the interface boundary.
NOT at the class. The concrete that DOES satisfy both stays as one class
implementing both interfaces (structural typing); the concrete that only
satisfies one drops the other entirely from its `implements` list.

Procedure:

1. Name the two cohesive interfaces — pick the responsibility, not the
   storage technology. Here: graph operations vs tabular operations.
2. Add a composition factory (`openStore`) that returns BOTH views in one
   envelope. Callers needing both take the envelope; callers needing one
   take the narrow interface.
3. Delete the cross-cutting methods from the narrow interface entirely.
   Concrete adapters that don't implement them no longer need to throw
   `NotImplementedError`.
4. Test contract for community adapters: only the narrow interface, with a
   conformance suite that any implementor imports + runs.

## Why this matters

This pattern lets community contributors fork in adapters without
re-implementing concerns that don't belong on their backend. An AGE /
Memgraph / Neo4j / Neptune author implements `IGraphStore` only —
DuckDB stays as the temporal backend on every deployment. Two files to
fork in: implement IGraphStore + call `assertIGraphStoreConformance` in
their test. The pattern beats the alternative ("one mega-interface,
each adapter throws NotImplementedError on what it can't do") on type
honesty, conformance verifiability, and Liskov compliance.

## Example

- `packages/storage/src/interface.ts` — split into IGraphStore + ITemporalStore.
- `packages/storage/src/index.ts` — openStore factory composes views.
- `packages/storage/src/graphdb-adapter.ts` — implements IGraphStore only.
- `packages/storage/src/duckdb-adapter.ts` — implements both via structural typing.
- `packages/storage/src/test-utils/conformance.ts` (AC-A-11) — pre-baked test
  suite that any IGraphStore implementor imports.
