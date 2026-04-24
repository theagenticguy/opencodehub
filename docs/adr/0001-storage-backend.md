# ADR 0001 — Storage backend selection

Status: **Accepted (superseded prior SQLite recommendation)** — 2026-04-18

## Context

OpenCodeHub needs an embedded data store with:
- Apache-2.0 / MIT / BSD / ISC / CC0 license
- Deterministic writes
- Node.js binding with prebuilt binaries for macOS (arm64/x64), Linux (arm64/x64), Windows x64
- Full-text search with BM25 scoring
- Vector similarity (HNSW) with **filter-aware** search — queries like "nearest symbols WHERE language='python'" must actually return results
- Graph-shaped data: nodes, typed relationships, multi-hop traversal
- Single-writer concurrency, crash safety
- Actively maintained in 2026 — not acquisition-risk

## Candidates

Options were filtered to OSI-approved permissive licenses (Apache-2.0, MIT,
BSD, ISC, CC0). Source-available, BUSL, AGPL, and GPL engines were
disqualified upfront to preserve Apache-2.0 distribution rights.

| Candidate | License | Verdict |
|---|---|---|
| **DuckDB + `hnsw_acorn` + `fts`** | MIT / MIT (community ext.) / MIT | **Accepted.** |
| **SQLite + `better-sqlite3` + FTS5 + `sqlite-vec`** | Public domain / MIT / public domain / Apache-2.0 | Considered. Boring and solid — but SQLite FTS5 has no filtered-HNSW story and `sqlite-vec` HNSW is still early. |
| **LanceDB** (`@lancedb/lancedb`) | Apache-2.0 | Considered. Excellent for vector + FTS. Graph traversal still requires recursive SQL via the Lance × DuckDB extension — we'd be running DuckDB anyway. Revisit as an alternate adapter if a multimodal / Git-style branching story becomes a requirement. |

## Decision

**DuckDB** via `@duckdb/node-api` (MIT, synchronous-friendly Promise API, prebuilt binaries) with three extensions:

- **`hnsw_acorn`** (community extension, first released March 2026) — HNSW index that respects `WHERE` clauses via the ACORN-1 algorithm, plus RaBitQ quantization for 21-30x memory reduction. Installs via `INSTALL hnsw_acorn FROM community;`. Stock `duckdb-vss` post-filters after the HNSW graph traversal, which silently returns 0 results on selective filters (1-3% selectivity) — unacceptable for code indexing where most queries will be "nearest matches in language X" or "nearest matches in module Y". `hnsw_acorn` pushes predicates into the graph traversal.
- **`fts`** (official DuckDB extension) — BM25 full-text search over text columns.
- **Recursive CTEs with `USING KEY`** (DuckDB 2025 feature) — memory-efficient graph traversal purpose-built for shortest-path / reachability algorithms. Keyed-dictionary state beats the naïve UNION ALL accumulator, which would blow up on large call graphs.

## Consequences

Positive:
- All-Apache-2.0 / MIT stack
- `hnsw_acorn` solves the filtered-vector-search problem that SQLite+`sqlite-vec` and stock DuckDB VSS both handle poorly
- `USING KEY` CTEs give us proper multi-hop graph traversal without a separate graph engine
- Deterministic writes given identical INSERT order — no random header UUID
- Single embedded binary via `@duckdb/node-api` (MIT, Neo rewrite, actively maintained)
- DuckDB 2026 ecosystem momentum is strong (monthly newsletter, active community extensions, MotherDuck commercial backing, Dutch Foundation independence) — low acquisition-risk
- Apache Arrow everywhere → future SCIP export, parquet dump, LanceDB interop all cheap

Negative / trade-offs:
- Column-store engine, so tiny single-row writes carry more overhead than SQLite. We batch-insert during indexing anyway (pipeline produces the whole graph before persisting), so this does not hit our hot path.
- Graph is still emulated on relational tables (nodes table + polymorphic relations table + recursive CTEs). This is the same trade-off every embedded-SQL option makes.
- `hnsw_acorn` is a community extension (not core). Pinned via `INSTALL hnsw_acorn FROM community;` at a specific version.

MCP surface:
- Expose a `sql` MCP tool (not `cypher`) — DuckDB SQL + recursive CTEs. High-level tools (`query`, `context`, `impact`, `detect_changes`, `rename`) abstract SQL entirely.

## Seam for v1.0+

The `IGraphStore` interface in `@opencodehub/storage` hides the backend. If LanceDB's Node bindings mature enough to justify a multimodal branching story it can slot in as an alternate adapter without changing consumers of the interface. DuckDB is the only supported backend for v1.0.

## References

- DuckDB `hnsw_acorn` deep-dive — https://cigrainger.com/blog/duckdb-hnsw-acorn/
- DuckDB `USING KEY` recursive CTEs — https://duckdb.org/2025/05/23/using-key.html
- DuckDB ecosystem newsletter Feb 2026 — https://motherduck.com/blog/duckdb-ecosystem-newsletter-february-2026/
- `@duckdb/node-api` — https://github.com/duckdb/duckdb-node-neo
- LanceDB (considered, deferred) — https://www.lancedb.com
