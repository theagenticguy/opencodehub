# Spike: single-file SQLite storage — WORKFLOW

**Branch:** `spike/sqlite-single-file`. Companion to `SPIKE-SQLITE-GOAL.md`.

This is the phased path from today's two-native-binding architecture to the
zero-dep, one-file end state. Each phase is independently reviewable and leaves
the tree green. The spike (this branch) has executed **Phase 0** and the
load-bearing slice of **Phase 1**.

---

## Evidence already on this branch (what's real)

Files added (storage package only — nothing else touched):

- `packages/storage/src/sqlite-adapter.ts` — `SqliteStore`, the representative
  slice of `IGraphStore` + `ITemporalStore` over one `node:sqlite` file.
- `packages/storage/src/sqlite-adapter.test.ts` — two `node:test` cases, both
  green.

Verification run (reproduce):

```bash
npx tsc -b packages/storage/tsconfig.json            # 0 errors
node --test --experimental-sqlite \
  ./packages/storage/dist/sqlite-adapter.test.js      # 2 pass, 0 fail
```

Proven: graph round-trip from one on-disk file, exact-f32 embedding round-trip +
cosine ranking, recursive-CTE traversal (impact up / blast-radius down,
depth-bounded, path-tracked), WAL engaged on a real file, no `.lbug`/`.duckdb`
sidecars.

Note: tests run with `--experimental-sqlite`. On Node 24.17 `node:sqlite` is
behind that flag; Phase 1 must confirm the flag-free version on our shipping
Node (or set the flag in the CLI shebang / bin wrapper). **This is the one
runtime assumption to nail down before committing to the migration.**

---

## The central design proposal: generic node table, not 37 tables

`GraphNode` is a 37-member discriminated union. The lbug adapter uses a wide
polymorphic column set (`NODE_COLUMNS`). The spike instead uses **one `nodes`
table**: typed columns for the universal base (`id, kind, name, file_path,
start_line, end_line`) plus a `payload` JSON-overflow column carrying the
kind-specific fields, rehydrated on read.

- **Pro:** trivial schema, no per-kind migration, new node kinds need no DDL.
- **Con to validate:** kind-filtered finders (`listNodesByKind`,
  `listDependencies`, `listRoutes`, `listFindings`) must filter on `kind` +
  occasionally reach into JSON (`payload->>'$.ecosystem'`). SQLite has good JSON
  operators, but the conformance/`graphHash` parity suite is the real judge —
  Phase 2 runs it.

Edges are one polymorphic `edges` table keyed by the `(from,to,type,step)` dedup
tuple, mirroring `KnowledgeGraph`'s `edgeDedupKey`.

---

## Phases

### Phase 0 — De-risk the thesis ✅ DONE (this branch)
Prove `node:sqlite` can do graph + vectors + temporal in one WAL file behind the
existing interface seam. Output: the adapter + tests above.

### Phase 1 — Complete the `IGraphStore` + `ITemporalStore` surface
Fill in every method the spike stubbed (`NotImplementedError` today):

- Graph finders: `listNodesByKind`, `listEdges`, `listEdgesByType`,
  `listFindings`, `listDependencies`, `listRoutes`, `getRepoNode`,
  `listNodesByName`, `listNodesByEntryPoint`, `countNodesByKind`,
  `countEdgesByType`, `listConsumerProducerEdges`, `search` (BM25 — use SQLite
  FTS5, built in), `traverseAncestors`/`traverseDescendants`, `setMeta`,
  `listEmbeddingHashes`.
- Temporal: `exec` (the `--sql` escape hatch — port `sql-guard.ts`/`cypher-guard`
  read-only enforcement), `bulkLoadCochanges` + lookups, `bulkLoadSymbolSummaries`
  + lookups, `countSymbolSummaries`.
- Honor the **sentinel coercions** (step-0 drop, empty `languageStats`→NULL, Repo
  nullable `null` not `undefined`, deadness underscore↔hyphen) — required for
  `graphHash` parity (see `column-encode.ts`, `interface.ts:24-62`).
- Pin down the `--experimental-sqlite` flag question (above).

**Exit:** `SqliteStore` implements both interfaces with no stubs; unit tests per
method.

### Phase 2 — Pass the conformance gate
Run `assertIGraphStoreConformance` (`@opencodehub/storage/test-utils`) against
`SqliteStore`. This is the byte-identical `graphHash` round-trip the lbug adapter
passes. If the generic-node-table design loses any field or ordering, it fails
here. Fix until green. This phase is the real go/no-go on the design.

### Phase 3 — Rewire `openStore` + the `--sql` / Cypher surface
- `openStore` (`packages/storage/src/index.ts`): return one `SqliteStore`
  instance as **both** `graph` and `temporal` views over one
  `<repo>/.codehub/store.sqlite`. Delete the two-file `composeArtifactPaths`
  graph.lbug/temporal.duckdb split and the ordered-close dance.
- The MCP `sql` tool exposes a Cypher arg today (routed to lbug). Decide:
  drop Cypher (SQL-only `--sql`), or keep a thin Cypher-ish shim. Recommend
  **drop** — `dialect` becomes `"sql"` (widen `GraphDialect` in `interface.ts:85`),
  and CLAUDE.md / ADR 0016 get superseded by a new ADR.
- Update `open-store.ts`, `doctor.ts`, `analyze.ts` call sites.

### Phase 4 — Parquet sidecar decision ✅ DONE (option a)
`exportEmbeddingsToParquet` is DuckDB's one genuinely hard-to-replace feature
(it backs the byte-identical Parquet embeddings sidecar in
`pack/embeddings-sidecar.ts`). **Decided: option (a).** `SqliteStore`
`.exportEmbeddingsToParquet()` now **lazily `await import("./duckdb-adapter.js")`
inside the method** and delegates to a throwaway in-memory `DuckDbStore` for the
deterministic `COPY … (FORMAT PARQUET, COMPRESSION ZSTD)`. DuckDB is therefore
**off the install hot path** — only an embeddings-pack invocation loads it;
`analyze`/`query`/`impact` and an embedding-free `pack` never do. The
`pack/embeddings-sidecar.test.ts` byte-identity test passes unchanged, and a
direct probe emits a valid `PAR1` Parquet file (2 rows, version pinned).
- **(b) Write Parquet in JS** (`parquet-wasm` / hand-rolled) remains the
  fast-follow that kills the last native dep entirely. Deferred — it carries its
  own byte-identical-determinism contract and must not block the install win.

### Phase 5 — Rip the native bindings out  ⛔ NEEDS LAITH (not done autonomously)
Remove `@ladybugdb/core` and `@duckdb/node-api` from all `package.json` (modulo
Phase-4 option (a)'s lazy DuckDB). Delete `graphdb-adapter.ts`,
`graphdb-pool.ts`, `graphdb-schema.ts`, `duckdb-adapter.ts` and their tests.
Net deletion should dwarf the addition. Update CHANGELOGs; write the superseding
ADR (0017?: "single-file SQLite storage; supersedes 0016").

### Phase 6 — Prove the one-command install
On a clean machine / container with only Node 24: `npm i -g @opencodehub/cli`,
then `codehub analyze` a sample repo, then `codehub query`/`impact`/`pack`.
Confirm no native build, no Docker, no second process. Update README's install
section to the one-liner. **This is the deliverable the whole spike exists for.**

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `--experimental-sqlite` flag required on shipping Node | Med | Set flag in bin wrapper; or wait for unflagged (track Node release notes). **Resolve in Phase 1.** |
| Generic node table fails `graphHash` parity | Med | Phase 2 is the gate; payload JSON is canonical-sorted already via the existing `canonicalJson`. Fall back to wider typed columns if a field needs SQL-level filtering. |
| Brute-force KNN too slow on a giant monorepo | Low | `sqlite-vec` via `loadExtension` (seam proven). Repo-scale is fine without it. |
| Losing the Parquet sidecar breaks pack determinism | Med | Phase 4 option (a) keeps DuckDB lazily for export only. |
| Concurrent writers (parallel `analyze`) | Low | WAL gives one-writer/many-reader; OCH indexes single-writer per repo anyway. |

## Progress log (autonomous run, 2026-06-22)

| Phase | State | Evidence |
|---|---|---|
| P0 de-risk | ✅ | spike adapter + 2 tests (commit 3663cd4) |
| "flag" | ✅ | node:sqlite is default-on at Node ≥24.15 — no flag needed to *run*; added a dependency-free guard that silences the one-shot ExperimentalWarning on stderr (matters for the MCP stdio channel). commit 8ee504b |
| P1 surface | ✅ | full IGraphStore+ITemporalStore, only exportEmbeddingsToParquet was stubbed (commit 1f8fbcd) |
| P2 graphHash gate | ✅ GREEN | sqlite-parity.test.ts: small+medium fixtures, all 4 sentinels, every edge kind, 2-store determinism. Verified SQLite is byte-correct *against the lbug reference* (commit 1f8fbcd) |
| P3 openStore rewire | ✅ | one SqliteStore as both views; 52 call sites unchanged; live `analyze`→`query`→`impact` on one store.sqlite; storage 178/0, mcp 209/0, monorepo tsc clean (commit 806e8e3) |
| P4 Parquet | ✅ option (a) | lazy DuckDB import at pack time only; sidecar test green; PAR1 file emitted |
| P5 rip bindings | ⛔ **needs Laith** | large irreversible deletion (~3k lines, ADR 0016 supersede) — left as a decision, not done autonomously |
| P6 clean-machine install | ⛔ pending P5 | — |

### Two bugs the LIVE run caught that tests structurally could not
1. **bulkLoad ignored `opts.mode`** — always full-replaced. `ingest-sarif` (run
   inside `analyze`) calls `bulkLoad(graph,{mode:"upsert"})` with an empty SARIF
   graph; the second call's `DELETE FROM nodes` wiped the 15 real nodes. Unit +
   parity tests only exercised single-instance replace-mode, so they were green
   while the product was broken. Fixed: honor `mode`; stamp `store_meta` from
   actual post-write counts. **Lesson: a passing parity test ≠ a working CLI;
   the analyze→query→impact loop is the real gate.**
2. **tsup `removeNodeProtocol:true`** stripped `node:sqlite`→bare `sqlite`,
   unresolvable at runtime. `tsc` was clean; only a live `codehub analyze`
   surfaced it. Fixed with `removeNodeProtocol:false`.

### Decision still owed by Laith
- **Greenlight P5?** Ripping lbug + the graphdb adapters is the irreversible step
  and the moment ADR 0016 gets superseded. The thesis is fully proven; this is a
  "do you want to commit the architecture" call, not a technical unknown.
- **Latent finding (separate from the spike):** the existing
  `graphdb-roundtrip.test.ts` all-kinds test passes only because its TEST-LOCAL
  rebuild helper re-attaches `step:0`; through the PUBLIC `rebuildFromStore`
  harness, `GraphDbStore` breaks on a `step:0` edge identically to SQLite, since
  `graphHash` emits `"step":0` but `listEdges` drops it on every adapter.
  Ingestion only ever emits `step≥1`, so it's latent — but it's a real gap in the
  conformance contract worth closing (either reject `step:0` at ingest, or make
  `graphHash` drop it). Your call whether that's in-scope.
