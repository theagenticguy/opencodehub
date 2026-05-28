# @opencodehub/storage

Storage abstraction for OpenCodeHub. The graph tier is always
`@ladybugdb/core` (`graph.lbug`) — symbols, edges, embeddings, HNSW ANN
search, and BM25 full-text search. The temporal tier is always DuckDB
(`temporal.duckdb`) — cochanges and the symbol-summary cache.

## Surface

```ts
import { openStore, StorageAdapter } from "@opencodehub/storage";

const store = await openStore({ repoRoot: "/path/to/repo" });
// store: StorageAdapter — read/write graph nodes and edges
```

- **`openStore`** — opens both tiers and returns `{ graph: GraphDbStore,
  temporal: DuckDbStore, graphFile, temporalFile, close }`. No `backend`
  field, no probe, no fallback; if `@ladybugdb/core` cannot load,
  `open()` throws `GraphDbBindingError` and the operation aborts.
- **`GraphDbStore` / `DuckDbStore`** — `IGraphStore` lives only on
  `GraphDbStore`; `DuckDbStore` implements `ITemporalStore` only. The
  segregated interfaces are the v1.0 contract for community-fork adapters
  (AGE / Memgraph / Neo4j / Neptune target `IGraphStore`).
- **`test-utils`** — exported as `@opencodehub/storage/test-utils` for
  in-memory stores in tests (`packages/storage/src/test-utils/index.ts`).
  The `assertIGraphStoreConformance` conformance suite stays as the
  community-adapter contract.

There is no backend selection: lbug owns the graph, DuckDB owns the
temporal store, both files are always written. See
[ADR 0016](../../docs/adr/0016-duckdb-graph-rip.md) for the rationale
behind ripping out the DuckDB graph backend.

## Design

- The DuckDB temporal store checkpoints atomically at the WAL level.
- Connection pooling is handled by the caller (the MCP server's
  `connection-pool.ts`); the store itself is single-writer, multi-reader.
- The lbug BM25 (`CREATE_FTS_INDEX`) and vector (`CREATE_VECTOR_INDEX`)
  indexes are built at the end of the bulk-load write phase; readers in
  `readOnly` mode query the index built by the most recent write.
