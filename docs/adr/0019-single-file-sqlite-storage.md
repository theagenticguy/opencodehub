# ADR 0019 — Single-file SQLite storage; one `store.sqlite` replaces the lbug + DuckDB pair

- Status: **Accepted** — 2026-06-22.
- Authors: Laith Al-Saadoon + Bonk.
- Branch: `spike/sqlite-single-file`.
- Supersedes: [ADR 0016 — Rip out the DuckDB graph backend; lbug-only graph, DuckDB temporal-only](./0016-duckdb-graph-rip.md)
  in its entirety. The segregated `IGraphStore` / `ITemporalStore` interfaces ADR 0016 preserved for community forks **stay** — they are now both implemented by one class.

## Context

ADR 0016 settled storage as two native bindings: the graph tier on
`@ladybugdb/core` (`graph.lbug`) and the temporal tier on
`@duckdb/node-api` (`temporal.duckdb`), each under `<repo>/.codehub/`.
That shape carried two native, platform-specific bindings on the install
hot path. The lbug binding in particular is mandatory and always-on:
ADR 0016 made a failed load a hard abort (`GraphDbBindingError`). On a
platform without a prebuilt (win32-arm64, musl/Alpine) or after an
`--ignore-scripts` install, the graph tier — and therefore every
`analyze`/`query`/`impact` — simply does not run.

Two native bindings means a platform matrix to maintain, a class of
install failures, and a hard floor under "how simple can `codehub init`
be." Distribution friction is a ranked competitive axis for OCH: rival
code-graph MCP servers auto-install into a dozen agents with zero native
build precisely because they carry no native engine.

Node 24's built-in `node:sqlite` (`DatabaseSync`, enabled by default on
Node ≥24.15 — our existing engines floor) provides every primitive the
two engines did: BLOB storage for `Float32Array` embeddings, recursive
CTEs for graph traversal (impact / blast-radius), WAL for crash-safe
concurrent reads, FTS5 for BM25 search, and a `loadExtension` seam for
`sqlite-vec` if brute-force KNN is ever outgrown. It is in the standard
library — zero install weight.

## Decision

**One `<repo>/.codehub/store.sqlite` file (WAL) backs the entire index** —
graph nodes, edges, embeddings, and the temporal tables (cochanges,
symbol summaries). A single `SqliteStore` class implements **both**
`IGraphStore` and `ITemporalStore`; `openStore()` returns that one
instance as both the `graph` and `temporal` views, so all existing call
sites (`store.graph.X()` / `store.temporal.Y()`) keep working unchanged.

- **`@ladybugdb/core` is removed entirely** from every `package.json`;
  `graphdb-adapter.ts`, `graphdb-pool.ts`, `graphdb-schema.ts` and their
  tests are deleted. The lbug graph tier is gone.
- **`@duckdb/node-api` is removed too.** It briefly survived as a lazy,
  pack-time-only import for the byte-identical Parquet embeddings sidecar
  (BOM item #7). But nothing in OCH ever *read* that Parquet file back —
  it was a write-only export with no consumer — so the sidecar was
  **dropped entirely** along with DuckDB. Embeddings live in the
  `embeddings` table inside `store.sqlite` (BLOB-exact, queryable); the
  Parquet export is gone, and the code-pack is now an **8-item BOM**
  (manifest + skeleton + file-tree + deps + ast-chunks + xrefs + findings +
  licenses + readme). The result: **zero native storage dependencies.**
  (`onnxruntime-node`, the optional embedder, is the only native dep left
  and is lazy-loaded solely under `--embeddings` — out of scope here.)
- **No backwards compatibility.** Clean slate: an existing
  `graph.lbug` / `temporal.duckdb` pair is not migrated. Users re-run
  `codehub analyze`, which writes the single `store.sqlite`.
- **Node schema design.** One generic `nodes` table (typed columns for
  the universal base — `id, kind, name, file_path, start_line, end_line`
  — plus a JSON `payload` overflow for the 37 kind-specific shapes),
  rehydrated on read. One polymorphic `edges` table keyed by the
  `(from, to, type, step)` dedup tuple. An FTS5 virtual table over node
  names/signatures/descriptions for `search`.
- **`dialect` stays `"cypher"`** as a literal for now; `node:sqlite`
  speaks SQL via the `exec` temporal surface, and the optional
  `execCypher` graph hatch is not implemented. Widening `GraphDialect`
  to `"sql"` is a one-line change deferred until a consumer needs it.
- **`codehub doctor`** drops the lbug binding probe and the DuckDB probe
  entirely; it gains a `node:sqlite` builtin check (import + WAL
  round-trip). There is no native storage binding left to probe.

### graphHash byte-identity (the go/no-go)

The migration's hard gate was that a `KnowledgeGraph` rebuilt from
`listNodes({})` + `listEdges({})` must hash byte-identically to the
original. `sqlite-parity.test.ts` proves it across small + mixed-kind
fixtures exercising every sentinel (`step:0`, empty `languageStats:{}`,
`responseKeys:[]`-vs-absent, Repo nullable `null`, deadness
underscore/hyphen, empty `propertiesBag:{}`), every edge kind, and two
independent stores.

A latent contract gap surfaced and was fixed at the source: an edge built
with an explicit `step: 0` hashed as `"step":0` but every adapter's
`listEdges` drops it via `stepZeroSentinel`, so a rebuild diverged.
`KnowledgeGraph.addEdge` now normalizes `step: 0` → absent at the graph
boundary (it was already identity-equal via `step ?? 0` in
`edgeDedupKey`/`makeEdgeId`), so the in-memory canonical edge matches what
round-trips through any `IGraphStore`. (The old `graphdb-roundtrip` test
masked this by re-attaching `step:0` in a test-local rebuild helper rather
than going through the public `rebuildFromStore` harness.)

## Consequences

- **Zero native dependencies on the install hot path.** `npm i -g
  @opencodehub/cli` plus Node ≥24.15 is the whole install — no Docker, no
  postinstall compile, no second process. Verified end-to-end: a live
  `analyze`→`query`→`impact` cycle runs with `@ladybugdb/core`
  unresolvable, writing one `store.sqlite` and no `.lbug`/`.duckdb`
  sidecar.
- **The community-adapter escape hatch survives.** The segregated
  `IGraphStore` / `ITemporalStore` interfaces ADR 0016 kept for AGE /
  Memgraph / Neo4j / Neptune forks remain — a fork now implements both on
  one class, or keeps them split. Nothing about the interface contract
  changed.
- **One native binding remains, quarantined.** DuckDB loads only for the
  optional Parquet embeddings sidecar at pack time. A pure-JS Parquet
  writer would remove it entirely; tracked as a fast-follow.
- **WAL companions.** `store.sqlite-wal` / `-shm` appear while a writer is
  open and collapse to the single file on `wal_checkpoint(TRUNCATE)` at
  close.
