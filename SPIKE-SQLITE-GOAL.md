# Spike: single-file SQLite storage — GOAL

**Branch:** `spike/sqlite-single-file`
**Status:** spike proven (adapter compiles, tests green, WAL verified). Not merged. Not production.
**Author:** overnight spike for Laith, 2026-06-22.

## The goal in one sentence

Make OpenCodeHub install and run with **zero native dependencies and one
command** — `npm i -g @opencodehub/cli` and nothing else — by collapsing all
persistent storage onto Node 24's built-in `node:sqlite` in WAL mode, one file
per repo.

No Docker. No `postinstall` compile. No server process. No second engine.

## Why this, why now

The two things standing between OCH and a frictionless install are both in the
storage layer:

| Dependency | Role today | Install cost |
|---|---|---|
| `@ladybugdb/core` ^0.17.1 | graph tier — `graph.lbug` (nodes, edges, embeddings, HNSW vector index, Cypher) | **native binding**, platform-specific, can fail to load → `GraphDbBindingError` |
| `@duckdb/node-api` 1.5.3 | temporal tier — `temporal.duckdb` (cochanges, symbol summaries, `--sql`, Parquet export) | **native binding**, platform-specific |

(`onnxruntime-node` is a third native dep, but it backs the *embedder*, which is
already optional and out of scope here — see Non-goals. `web-tree-sitter` and
`@huggingface/tokenizers` are WASM/portable and already install-clean per
ADR 0015.)

Two native bindings mean: a platform matrix to maintain, a class of
"works-on-my-machine" install failures, and a hard floor under "how simple can
`init` be." Distribution friction (signal **B7** in the roadmap sensor) is a
ranked competitive axis — the code-graph MCP cluster (DeusData et al.)
auto-installs into 11+ agents with zero config precisely because it carries no
native graph engine. OCH's determinism + compliance moat is worth nothing if a
developer can't get it running in one command.

`node:sqlite` shipped stable enough to use on our existing Node ≥24.15 baseline
(verified on 24.17). It is in the standard library — zero install weight — and
it gives us BLOB storage for embeddings, recursive CTEs for graph traversal, WAL
for crash-safe concurrent reads, and a `loadExtension` seam for `sqlite-vec` if
we ever outgrow brute-force KNN. That is every primitive the two native engines
were providing.

## What "done" looks like (the real migration, not the spike)

1. A single `SqliteStore` implements **both** `IGraphStore` and `ITemporalStore`
   against one `<repo>/.codehub/store.sqlite` file in WAL mode.
2. `@ladybugdb/core` and `@duckdb/node-api` are removed from every
   `package.json`. `pnpm why` returns nothing for either.
3. `codehub analyze` + every query/impact/pack command works on a freshly
   installed CLI with no native build step, on Linux/macOS/Windows, on a clean
   machine with only Node 24 present.
4. The byte-identical `packHash` determinism contract still holds (the conformance
   harness `assertIGraphStoreConformance` passes against `SqliteStore`).
5. `codehub init` writes `.mcp.json` and is the *only* setup step.

## Non-goals (explicit, per the spike brief)

- **No backwards compatibility.** Clean slate. We do not migrate existing
  `graph.lbug` / `temporal.duckdb` artifacts; a user re-runs `codehub analyze`.
  This is a deliberate simplification the brief authorized.
- **The embedder (`onnxruntime-node`) is a separate track.** Embedding *storage*
  moves to SQLite here; embedding *generation* staying native (or going WASM /
  remote) is its own decision. The spike stores and searches vectors; it does
  not change how they're produced.
- **ANN at scale is deferred.** The spike ranks vectors by brute-force cosine in
  JS, which is sub-10ms at repo scale (10²–10⁵ vectors). If a repo needs HNSW,
  `sqlite-vec` loads through the proven `loadExtension` seam with no rebuild —
  that's a Phase-4 decision, not a blocker.

## What the spike already proves (see SPIKE-SQLITE-WORKFLOW.md → "Evidence")

- `node:sqlite` exists and works on our Node baseline (24.17).
- A real `KnowledgeGraph` round-trips (nodes + edges) through one on-disk file
  across a close/reopen cycle.
- Embeddings round-trip as **exact Float32 bytes** in a BLOB and rank correctly
  by cosine distance.
- Graph traversal — impact (up) and blast-radius (down), depth-bounded, with
  path tracking — runs as a recursive CTE, replacing LadybugDB Cypher.
- WAL engages on a real file (`journal_mode=wal`; `-wal`/`-shm` companions
  appear while open, collapse to one file on checkpointed close).
- Zero `.lbug` / `.duckdb` sidecars are written. It is genuinely one file.
