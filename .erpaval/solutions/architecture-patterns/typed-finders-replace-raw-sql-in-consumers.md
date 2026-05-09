---
title: Replace raw-SQL escape hatches with typed finders on the storage interface
tags: [service-layer, dialect-leak, typed-finders, dry, igraphstore]
session: session-33f24f
---

## Context

108 raw-SQL call sites lived outside `packages/storage/`: 46 in mcp/, 27
in analysis/, 17 in cli/, 12 in wiki/, 4 in pack/, 2 in search/. Each
called `store.query("SELECT ... FROM nodes WHERE ...")`. After
`IGraphStore` split graph-only (no SQL), every one of those was a
silent breakage waiting to fire when the default backend flipped.

The clean fix wasn't `s/IGraphStore/DuckDbStore/` everywhere — that
preserves the abstraction leak. It was **a 13-finder service layer**
on the interface: `listNodesByKind`, `listEdges`, `listEdgesByType`,
`listFindings`, `listDependencies`, `listRoutes`, `getRepoNode`,
`countNodesByKind`, `countEdgesByType`, `traverseAncestors`,
`traverseDescendants`, `listEmbeddings`, `listConsumerProducerEdges`,
plus 2 specialized (`listNodesByEntryPoint`, `listNodesByName`).

Each adapter (DuckDB, GraphDb, future AGE/Memgraph/Neo4j/Neptune)
internalizes the dialect. Consumers call `store.listFindings({severity:
"error"})`. The 108 sites collapse into 15 named finders. SQL strings
never leave the adapter.

## Lesson

When raw-SQL escape hatches sprawl across a codebase, the migration
target is not the "right" type pin — it's the right service-layer API.
Pattern:

1. Audit raw call sites. Group by query shape. The grouping IS the
   finder set.
2. Add finders to the interface. Each finder is the SMALLEST coherent
   abstraction that covers a recurring query shape.
3. Implement on every adapter. Internalize the dialect. Determinism
   (ORDER BY id ASC for nodes; (from_id, to_id, type) for edges).
4. Migrate consumers one package at a time. Per-package agent + write
   protocol per AC.
5. Test contract: round-trip parity via a Liskov rebuilder that uses
   ONLY public methods (no raw SQL/Cypher). Any new adapter slots in.

## Why this matters

Raw SQL in consumers is a leaky abstraction that fires the day the
default backend changes. Replacing it with typed finders:

- Makes the architecture honest at compile time, not runtime.
- Lets community adapters slot in without rewriting consumers.
- The 15-finder set is a SOLID-I balance — small enough to be coherent,
  large enough to cover every read pattern.
- The Liskov-clean parity harness (`rebuildFromStore` using only public
  methods) means a third-party adapter proves conformance by passing
  the suite. No coupling to either flagship adapter.

## Example

- `packages/storage/src/interface.ts:144-215` — 15 finder signatures.
- `packages/storage/src/duckdb-adapter.ts`, `graphdb-adapter.ts` — 13 finder
  impls each, dialect internalized.
- `packages/storage/src/test-utils/parity-harness.ts` — `rebuildFromStore`
  uses listNodes + listEdges only.
- `packages/storage/src/test-utils/conformance.ts` —
  `assertIGraphStoreConformance(name, factory)` for community adapters.
- 108 migration sites across analysis/mcp/pack/wiki/search/cli — see
  commits `efa673c` through `e4131b3` on `feat/v1-finalize-track-a`.
