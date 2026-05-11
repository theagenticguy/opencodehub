# @opencodehub/search

BM25 + dense vector hybrid search with Reciprocal Rank Fusion (RRF) for
OpenCodeHub. Powers the `query` and `group_query` MCP tools.

## Surface

```ts
import { hybridSearch } from "@opencodehub/search";

const results = await hybridSearch({
  store,         // StorageAdapter from @opencodehub/storage
  query: "authentication middleware",
  limit: 20,
  alpha: 0.5,    // 0 = BM25 only, 1 = vector only
});
```

- **BM25** — full-text search via DuckDB FTS, run directly in the graph
  store (`packages/storage`).
- **Dense vector** — cosine ANN search via DuckDB's `hnsw_acorn` extension.
- **RRF fusion** — rank lists from both paths are merged with
  Reciprocal Rank Fusion (k=60) before the final `limit` is applied.

## Design

- `alpha` defaults to 0.5 (equal weight). Set to 0 for pure BM25 (no
  embeddings required), useful in offline mode.
- When the embedding column is absent (embeddings not enabled during
  ingestion), the vector path is silently skipped and BM25 results are
  returned unchanged.
- Results are grouped by process/community cluster so an agent sees
  semantically related symbols together, not just the top-k by score.
