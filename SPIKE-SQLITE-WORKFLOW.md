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

### Phase 4 — Parquet sidecar decision
`exportEmbeddingsToParquet` is DuckDB's one genuinely hard-to-replace feature
(it backs the byte-identical Parquet embeddings sidecar in
`pack/embeddings-sidecar.ts`). Two options, pick one:
- **(a) Keep DuckDB as an optional, lazy dep** used *only* at `pack` time for
  Parquet export. Preserves the sidecar; keeps one native dep but off the
  install hot path (optionalDependency, imported dynamically).
- **(b) Write Parquet in JS** (e.g. `parquet-wasm` / hand-rolled) so the sidecar
  stays but the native dep dies entirely. More work; fully honors the zero-dep
  goal.

Recommend **(a) for the migration, (b) as a fast-follow** — don't let Parquet
block the install win. Either way, embeddings now *live* in SQLite; this is only
about the export format.

### Phase 5 — Rip the native bindings out
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

## Recommendation to Laith (morning read)

The thesis holds — `node:sqlite` covers every storage primitive the two native
engines provided, and the spike proves the hard parts (vectors, traversal, WAL,
one file) in working code. The one thing to decide before greenlighting the full
migration is the **`--experimental-sqlite` flag** on our shipping Node: if we're
comfortable setting it in the CLI bin wrapper (or our Node bumps past the flag),
this is a clean, high-leverage win on the distribution axis. The generic-node-
table design is the one part I'd want the Phase-2 conformance gate to validate
before trusting it. Everything else is mechanical surface-completion.
