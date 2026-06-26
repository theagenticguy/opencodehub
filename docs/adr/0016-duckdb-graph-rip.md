# ADR 0016 — Rip out the DuckDB graph backend; lbug-only graph, DuckDB temporal-only

- Status: **Superseded** by [ADR 0019 — Single-file SQLite storage](./0019-single-file-sqlite-storage.md)
  on 2026-06-22, **in its entirety**. ADR 0019 removed BOTH native bindings
  this ADR settled on (`@ladybugdb/core` for the graph tier and
  `@duckdb/node-api` for the temporal tier) and replaced the pair with one
  `store.sqlite` file via Node's built-in `node:sqlite`. The segregated
  `IGraphStore` / `ITemporalStore` interfaces this ADR preserved for
  community forks survive — both are now implemented by a single
  `SqliteStore` class. Read this ADR only for the historical rationale of
  the lbug-graph / DuckDB-temporal split; **do not** treat its decision as
  current.
- Was: **Accepted** — 2026-05-16.
- Authors: Laith Al-Saadoon + Claude.
- Branch: `feat/duckdb-graph-rip`.
- Supersedes: [ADR 0013 — M7 default flip and storage abstraction](./0013-m7-default-flip-and-abstraction.md)
  in its entirety; partially supersedes [ADR 0011 — graph-db backend](./0011-graph-db-backend.md)
  (the "DuckDB-as-graph default" passages).

## Context

ADR 0011 introduced `@ladybugdb/core` (lbug) as a second `IGraphStore`
backend behind a `CODEHUB_STORE` env-var selector. ADR 0013 flipped the
default to graph-default with auto-probe-and-fallback semantics: when
`CODEHUB_STORE` was unset, the resolver imported `@ladybugdb/core` and
preferred lbug on success, otherwise fell back to DuckDB-as-graph. A
dual-artifact detector picked the newer-mtime file when both
`graph.duckdb` and `graph.lbug` existed in `<repo>/.codehub/`. The
DuckDB graph adapter therefore lived as a permanent fallback path,
maintained alongside the lbug adapter.

Two things changed at the start of the 2026-05 dogfood cycle:

1. **lbug bulk-load became feature-complete.** A separate session landed
   the `COPY <Table> FROM (UNWIND $rows ...)` pattern that DuckDB
   already had — type-safe ingestion of nodes and edges through lbug's
   bulk path. After that, every `IGraphStore` surface — bulk-load, all
   15 typed finders, BM25 search, HNSW vector search, traversals,
   embeddings — runs on lbug; the v1.0 conformance suite passes against
   lbug; the cross-adapter parity tests existed only to keep DuckDB
   honest.
2. **The dual-write code carried real cost.** ~1900 LOC of graph-tier
   code in `duckdb-adapter.ts`, the ~3500-LOC parity test suite, the
   resolver/probe/dual-artifact apparatus, the env-var, the docs that
   tried to keep `codehub-graph` as a backend axis. Every `analyze`
   path took two branches and every architectural claim ("storage is
   pluggable") had to defend a backend that nobody set explicitly.

The user's framing was "rip out the DuckDB fallback for graph store …
keep the generic / abstractions but I don't want all this code for
duckdb unless it's the temporal/genuine tabular type stuff. and in fact
maybe even that should be sqlite wasm or something."

## Decision

**`IGraphStore` lives only on `GraphDbStore`; `DuckDbStore` implements
`ITemporalStore` only.** The interface segregation introduced in
session-33f24f (see
[`solutions/architecture-patterns/igraphstore-itemporalstore-segregation.md`](../../.erpaval/solutions/architecture-patterns/igraphstore-itemporalstore-segregation.md))
was anticipating exactly this split — community AGE / Memgraph / Neo4j /
Neptune adapters target `IGraphStore` only and pair with the
DuckDB-backed `ITemporalStore`. After this rip-out, that's also the
in-tree shape: lbug owns `IGraphStore`, DuckDB owns `ITemporalStore`,
and the in-tree adapters stop demonstrating the structural-typing-via-
`implements both` case.

Concrete shape after the rip:

- `openStore({path})` always returns `{graph: GraphDbStore, temporal:
  DuckDbStore, graphFile, temporalFile, close}`. No `backend` field on
  the result envelope; no `backend?` option on the input.
- The graph artifact is `<dir>/graph.lbug`. The temporal artifact is
  `<dir>/temporal.duckdb`. `paths.describeArtifacts()` takes no arguments
  and returns `{graphFile: "graph.lbug", temporalFile: "temporal.duckdb"}`.
- `resolveDbPath` is renamed `resolveGraphPath` and returns the lbug
  filename.
- `CODEHUB_STORE` is gone. The env var is no longer consulted anywhere
  in storage. The resolver, the dynamic-import probe of `@ladybugdb/core`,
  the dual-artifact mtime arbitration, the `_lbugFallbackWarned` /
  `_dualArtifactWarned` advisory state, and the
  `_resetStoreResolverCache` test escape hatch are all deleted.
- The MCP `sql` tool's `cypher` field becomes unconditionally available;
  it routes to `store.graph.execCypher(...)`.
- Embeddings live in `graph.lbug`. The pack embeddings sidecar streams
  rows from `store.graph.listEmbeddings()` into a per-call DuckDB
  `CREATE TEMP TABLE embeddings_export` on `temporal.duckdb`, then runs
  the existing deterministic
  `COPY (... ORDER BY ...) TO '<path>' (FORMAT PARQUET, COMPRESSION ZSTD)`,
  then drops the temp table. The byte-identity contract for
  `embeddings.parquet` is preserved.
- The conformance suite at `packages/storage/src/test-utils/conformance.ts`
  (`assertIGraphStoreConformance(name, factory)`) and the parity-harness
  rebuilder at `packages/storage/src/test-utils/parity-harness.ts` stay.
  They are the v1.0 contract for community adapters; deleting them
  would contradict the segregation ADR's promise.

## Backwards compatibility

None. Existing `<repo>/.codehub/graph.duckdb` files are no longer read.
Users re-run `codehub analyze` to write `graph.lbug` from scratch.
There is no stale-artifact warning, no legacy alias, no kill-switch.
This is a single-user dogfood repo today; the cost of a hard cutover is
"re-run analyze once."

## Operational impact

- **Platform reach narrows to lbug's 5 prebuilt targets**:
  `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64`.
  Alpine/musl and 32-bit Linux ARM users need a source build via
  `cmake-js`. `codehub doctor` now hard-fails on missing binding (was
  warn-and-continue in the auto-probe era).
- **lbug's 8 TiB virtual mmap per Database can exhaust the 47-bit user
  virtual address space on 64-bit Linux** when many test pools open
  concurrently — surfaces as `Buffer manager exception: Mmap for size
  8796093022208 failed`. Wave 1 chased this in detail and confirmed
  with a probe: lbug's `maxDBSize` defaults to `1 << 43` and the
  request is reserved at `Database` construction (not lazy).
  `bufferManagerSize` defaults to `min(systemMem, maxDBSize) * 0.8`.
  The pool now passes both as explicit constructor args
  (16 GiB `maxDbBytes`, 2 GiB `bufferManagerBytes`) so concurrent
  Databases do not exhaust VA. See
  [`solutions/conventions/lbug-copy-from-subquery-bulk-load.md`](../../.erpaval/solutions/conventions/lbug-copy-from-subquery-bulk-load.md)
  for the citations (kuzudb/kuzu#1826, the upstream Database constructor,
  `BufferPoolConstants::DEFAULT_VM_REGION_MAX_SIZE`).
- **Sentinel STRING[] columns must be non-empty in lbug bulk-load.**
  An empty-array sentinel (`[]`) makes lbug's struct-field type
  inference resolve to `LIST(ANY)`, and any later data row with a
  string then throws "Trying to create a vector with ANY type". The
  fix is `["__sentinel__"]`; the seed value is filtered before COPY by
  the existing `WITH r WHERE r.id <> SENTINEL`.
- **lbug rejects writes against a Database opened with `readOnly=true`,
  including `CALL CREATE_FTS_INDEX(...)` and `CALL CREATE_VECTOR_INDEX(...)`.**
  These are now built at the end of `bulkLoad` (write phase). The
  `ensureFtsIndex` / `ensureVectorIndex` lazy helpers no-op in
  readOnly mode; readers query the existing index built by the most
  recent write.

## Future work

The user's "maybe sqlite-wasm for temporal" comment is captured here as
forward-work: replacing `DuckDbStore` with a JS-only `ITemporalStore`
implementor (e.g. `sql.js`, `wa-sqlite`) would drop the last native
binding from the temporal tier and let OCH ship as pure-JS at the
distributed-boundary. The interface contract — `exec(sql, params)`,
`bulkLoadCochanges`, `lookupCochangesForFile`, `bulkLoadSymbolSummaries`,
`exportEmbeddingsToParquet` — is small enough to port; only the
deterministic Parquet writer would need investigation (sql.js does not
ship a `COPY ... TO PARQUET` analog out of the box). Not in scope for
this ADR.

## Numbers

Net diff for this rip: ~5,800 deletions, ~150 insertions. Workspace
test count after: 1931 passing, 0 failing, 2 skipped (one platform-
gated lbug vector probe + one platform-gated embedder probe). Storage
package: 148/0/1 over three consecutive runs — no flake.
