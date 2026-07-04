# @opencodehub/storage

Storage abstraction for OpenCodeHub. The whole index lives in one
`<repo>/.codehub/store.sqlite` file (WAL) via Node's built-in `node:sqlite`
— graph nodes, edges, embeddings, BM25 full-text search, and the temporal
tables (cochanges, symbol-summary cache). One `SqliteStore` class
implements both the graph tier (`IGraphStore`) and the temporal tier
(`ITemporalStore`); there are zero native storage bindings.

## Surface

```ts
import { openStore, type Store } from "@opencodehub/storage";

const store = await openStore({ path: "/path/to/repo/.codehub" });
await store.graph.open();
// store.graph.X() / store.temporal.Y() — both hit the one SqliteStore
```

- **`openStore`** — constructs one `SqliteStore` and returns it as both
  views: `{ graph, temporal, graphFile, temporalFile, close }`. `graph`
  and `temporal` are the same instance; `graphFile` and `temporalFile`
  are the same `store.sqlite` path (retained so callers keep compiling).
  No `backend` field, no probe, no fallback, nothing to compile at install.
- **`SqliteStore`** — the single concrete adapter, implementing
  `IGraphStore` + `ITemporalStore`. The two interfaces stay segregated as
  the contract for a community SQL-shaped fork that wants to swap the
  temporal tier.
- **`test-utils`** — exported as `@opencodehub/storage/test-utils`
  (`packages/storage/src/test-utils/index.ts`). Ships `assertGraphParity`
  + `rebuildFromStore`, the graphHash byte-identity parity primitives the
  in-tree `sqlite-parity.test.ts` runs across every node/edge kind.

See [ADR 0019](../../docs/adr/0019-single-file-sqlite-storage.md) for the
single-file SQLite migration (supersedes ADR 0016's DuckDB-graph rip).

## Design

- The DuckDB temporal store checkpoints atomically at the WAL level.
- Connection pooling is handled by the caller (the MCP server's
  `connection-pool.ts`); the store itself is single-writer, multi-reader.
- The lbug BM25 (`CREATE_FTS_INDEX`) and vector (`CREATE_VECTOR_INDEX`)
  indexes are built at the end of the bulk-load write phase; readers in
  `readOnly` mode query the index built by the most recent write.
