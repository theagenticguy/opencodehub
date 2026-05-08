---
title: Add typed kind-filtered enumeration to IGraphStore once 3+ packages need it
tags: [storage, graph-store, api-design, typed-rehydration]
session: session-e1d819
---

## Context

Spec 005 originally called for `IGraphStore.listNodes()`. Implementation
diverged into raw SQL (`SELECT id, kind, ... FROM nodes WHERE kind = ?`)
scattered across `packages/mcp/src/tools/{scan,project-profile,
dependencies,verdict}.ts`. M5 BOM bodies (skeleton, file-tree, deps,
xrefs) were about to add four more raw-SQL call sites in
`packages/pack/`. T-W2-2 lifted the abstraction back into
`packages/storage/src/interface.ts` (commit 018c253).

## Lesson

When ≥ 3 packages need typed kind-filtered node enumeration from a
polymorphic graph store, add the method to the storage interface
instead of duplicating SQL. The shape that worked here:

```ts
// packages/storage/src/interface.ts
listNodes(opts?: {
  readonly kinds?: readonly string[];   // undefined → all; [] → []
  readonly limit?: number;
  readonly offset?: number;
}): Promise<readonly GraphNode[]>;       // typed discriminated union
```

Implementation requirements:

- Both adapters must rehydrate to the **typed** `GraphNode` discriminated
  union — not `Record<string, unknown>`. This forces every column-to-field
  mapping to be reversed once, in the adapter, instead of duplicated in
  each consumer (`packages/storage/src/duckdb-adapter.ts:rowToGraphNode`,
  `packages/storage/src/graphdb-adapter.ts:recordToGraphNode`).
- `ORDER BY id ASC` at the SQL layer + JS-side lex-stable tiebreak — this
  is what gives cross-adapter byte-identical output (parity test in
  `graphdb-adapter.test.ts`).
- Empty `kinds: []` short-circuits **before** opening any native binding
  pool; this preserves the pure-JS contract for never-opened stores.
- Additive interface change: every existing `implements IGraphStore`
  fake (4 found in this repo: `analysis/test-utils.ts`, `wiki/index.test.ts`,
  `search/bm25.test.ts`, `search/hybrid.test.ts`) needs a no-op or
  in-memory `listNodes` to typecheck.

## Why

Scattered SQL ages badly: every new column on the polymorphic `nodes`
table forces N consumers to update; per-kind rehydration drifts; tests
silently miss new fields. A typed `listNodes` collapses N rehydration
implementations to one and turns "did the consumer remember to read
`languageStats`?" into a compile error. The 25-test cross-adapter parity
suite added here is the canary for future schema additions.
