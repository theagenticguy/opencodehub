# @opencodehub/search

BM25 + dense vector hybrid search with Reciprocal Rank Fusion (RRF) for
OpenCodeHub. Powers the `query` and `group_query` MCP tools.

## Surface

`hybridSearch` takes positional arguments: the graph store, a query object,
and an optional embedder. The query object uses `text` (not `query`); there
is **no `alpha` weight** — fusion is pure RRF.

```ts
import { hybridSearch } from "@opencodehub/search";

// BM25 + vector, fused with RRF. Pass an embedder to enable the vector leg.
const fused = await hybridSearch(
  graph, // IGraphStore from @opencodehub/storage
  {
    text: "authentication middleware",
    limit: 20, // optional, defaults to DEFAULT_HYBRID_LIMIT (50)
    kinds: ["Function", "Class"], // optional NodeKind filter
    mode: "flat", // "flat" (default) | "zoom"
    granularity: "symbol", // optional tier filter on the vector leg
  },
  embedder, // optional Embedder; omit for BM25-only
);
// fused: readonly FusedHit[] — { nodeId, score, sources: ("bm25" | "vector")[] }
```

- **BM25** — full-text search via SQLite FTS5, run directly in the store
  store (`packages/storage`).
- **Dense vector** — cosine ANN search via brute-force cosine over the embeddings table.
- **RRF fusion** — the BM25 and vector rank lists are merged with
  Reciprocal Rank Fusion (`DEFAULT_RRF_K = 60`) before the final `limit` is
  applied. Each `FusedHit.sources` records which runs (`"bm25"`, `"vector"`)
  voted for that node.

## Behaviour

- **No embedder → BM25 only.** When `embedder` is omitted, the vector leg is
  skipped and BM25 rows are returned unchanged, each tagged
  `sources: ["bm25"]`. Callers stay on a single codepath whether or not an
  embedder is active. `hybridBm25Only(store, q)` returns the raw BM25
  `SymbolHit` rows for callers that want the keyword path directly.
- **`mode: "zoom"`** runs a coarse file-tier ANN query first, collects the
  shortlisted file paths, then runs a symbol-tier ANN query restricted to
  symbols under those files before fusing with BM25. `zoomFanout` (default
  `DEFAULT_ZOOM_FANOUT = 10`) caps the coarse file-tier shortlist. If the
  file tier isn't populated, zoom falls back to an unrestricted symbol-tier
  query.
- **`granularity`** hard-filters the vector leg to one or more embedding
  tiers (`"symbol"` | `"file"` | `"community"`). Flat mode defaults to
  `"symbol"`.
