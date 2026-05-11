# @opencodehub/storage

Graph store abstraction for OpenCodeHub. Backed by DuckDB with HNSW ANN
search (`hnsw_acorn`) and full-text search (`fts`), with an optional
`@ladybugdb/core` graph-database layer.

## Surface

```ts
import { openStore, StorageAdapter } from "@opencodehub/storage";

const store = await openStore({ repoRoot: "/path/to/repo" });
// store: StorageAdapter — read/write graph nodes and edges
```

- **`openStore`** — probes for `@ladybugdb/core` and uses the graph-database
  backend when available; falls back to the DuckDB-only layout with a
  one-shot advisory on TTY or `OCH_VERBOSE=1`.
- **`StorageAdapter`** — uniform interface used by ingestion, analysis,
  search, and MCP. Abstracts over the two backends.
- **`test-utils`** — exported as `@opencodehub/storage/test-utils` for
  in-memory stores in tests (`packages/storage/src/test-utils/index.ts`).

## Backend selection

| `CODEHUB_STORE` | Backend |
|---|---|
| unset (default) | graph-database if `@ladybugdb/core` available, else DuckDB |
| `duck` | DuckDB only (single `graph.duckdb` file) |
| `lbug` | `@ladybugdb/core` required; error if not installed |

When both `graph.duckdb` and `graph.lbug` exist in the same
`<repo>/.codehub/`, the newer-mtime file wins. See ADR 0013 for rationale.

## Design

- All writes go through `write-file-atomic` indirectly — the DuckDB
  checkpoint is atomic at the WAL level.
- Connection pooling is handled by the caller (the MCP server's
  `connection-pool.ts`); the store itself is single-writer, multi-reader.
- The `hnsw_acorn` extension is loaded lazily — it is a no-op if embeddings
  were not generated during ingestion.
