# Track A — Revised Architecture (DRY/SOLID/KISS, full 108-SQL scope)

**Session:** session-33f24f · **Status:** design input to Plan phase · **Source spec:** `.erpaval/specs/006-v1-finalize/spec.md` §"Track A"

This document refines Track A under the user's anchor constraint:

> "DuckDB is for temporal/tabular data only. Graph operations live exclusively
> on the graph backend (LadybugDB by default; AGE / Memgraph / Neo4j /
> Neptune as plausible community backends)."

That single sentence is the single-responsibility line that organizes the
entire stack. Everything below derives from it.

---

## 1. Executive summary

### 1.1 The layer split

Track A as currently specified hardens `IGraphStore` and migrates 4 of 108 raw-SQL sites. The user's anchor reframes the work: **`IGraphStore` is not "the storage interface" — it is "the graph interface", and a sibling `ITemporalStore` exists for cochanges, symbol summaries, time-travel, and the `codehub query --sql` escape hatch.** Once that split is named, the abstraction becomes load-bearing in a way the current spec only hints at.

The revised stack is four layers, each with a clean responsibility:

| Layer | Lives in | Responsibility | Backend-aware? |
|---|---|---|---|
| L1 — Core / shared | `@opencodehub/core-types` + `@opencodehub/storage/{column-encode,test-utils}` | Node/edge models, canonicalJson, graphHash, column encoders, parity harness, sentinel coercions | NO — pure |
| L2 — Store interfaces | `@opencodehub/storage/src/interface.ts` | `IGraphStore` (Cypher-only), `ITemporalStore` (SQL-only), `openStore({path,backend}) → {graph, temporal}` | abstract |
| L3 — Adapters | `@opencodehub/storage/src/{graphdb,duckdb}-adapter.ts` + community forks | Per-backend wire driver, dialect, codecs | YES |
| L4 — Consumers | `analysis/`, `mcp/`, `cli/`, `pack/`, `wiki/` | Call only L2 finders; never raw dialect | NO |

### 1.2 The IGraphStore segregation

Today's `IGraphStore` (`packages/storage/src/interface.ts:11-87`) is a kitchen-sink:
graph reads, graph writes, full-text search, vector search, raw SQL,
cochanges, and symbol summaries — all on one type. Under the anchor
constraint, this is a Liskov violation waiting to happen: `GraphDbStore`
cannot truly satisfy `lookupCochangesForFile` because `lookupCochangesForFile`
is a temporal/tabular query. Today's `GraphDbStore` throws
`NotImplementedError` on six methods (`graphdb-adapter.ts:881-916`) and
the M3+M6 reframe (AC-A-3) plans to fill them — but doing so spreads
temporal logic across both backends. The revised design instead treats
cochanges + symbol summaries as **always temporal**, regardless of which
graph backend is in use.

Result: the graph adapter (LadybugDB / AGE / Memgraph / Neo4j / Neptune)
never implements cochanges or summaries. They live in DuckDB (or
SQLite / Parquet sidecar) on every deployment. A LadybugDB-default repo
opens **two** stores: `graph.lbug` for the graph and `temporal.duckdb`
for the temporal tables. A DuckDB-only deployment opens one DuckDB file
that satisfies both interfaces (via two thin classes that both wrap one
connection — no code lost, only relabeled).

### 1.3 What gets simpler

1. **`IGraphStore.rawQuery` collapses to `execCypher`.** No dialect marker
   needed because the type forbids SQL. SQL goes through `ITemporalStore.exec`.
   This removes the entire `Store.dialect: "sql" | "cypher"` proposal
   in favor of structural typing — a stronger guard with less code.
2. **The 108 raw-SQL sites split cleanly.** ~14 are temporal (cochanges,
   summaries, store_meta lookups) and stay on `ITemporalStore`. The
   remaining ~94 become typed graph finders on `IGraphStore`. No site
   sits on the boundary.
3. **CochangeStore / SymbolSummaryStore on `GraphDbStore` becomes empty.**
   AC-A-3 morphs from "implement six methods on `GraphDbStore`" to
   "remove the six method signatures from the graph interface and route
   them to `ITemporalStore`". The `NotImplementedError` block at
   `graphdb-adapter.ts:881-916` deletes outright — no replacement code.
4. **The parity test sharpens.** `assertParity` now compares
   `graphHash(rebuildFromStore(graphStore))` across N graph backends —
   one line per backend, no per-backend rebuilder. The temporal
   parity (cochanges round-trip) is tested separately on
   `ITemporalStore` adapters and never participates in `graphHash`.
5. **`exportEmbeddingsParquet` clarifies.** Embeddings are graph-tier
   data (they live next to graph nodes in the index) but the Parquet
   sidecar is a temporal artifact. AC-A-4 moves the sidecar emitter
   from `IGraphStore.exportEmbeddingsToSidecar` to the **pack/** layer,
   which reads embeddings via `IGraphStore.listEmbeddings()` (a
   portable graph-side method) and writes Parquet via DuckDB's
   `COPY TO PARQUET` (a temporal-side operation). Both adapters
   participate; no silent absence on LadybugDB.

### 1.4 What stays hard

The user's anchor does not eliminate complexity — it redistributes it.

- **Two stores per repo means two lifecycles.** `openStore({path, backend})`
  returns `{graph, temporal}` and the caller closes both. This is
  composition, not coupling, but it changes every call site that today
  does `store.close()`.
- **Embeddings have a foot in both worlds.** Vector search is a graph
  operation (LadybugDB does it natively). Embedding sidecar export is
  a temporal operation (Parquet via DuckDB COPY). The split assigns
  `vectorSearch` + `upsertEmbeddings` + `listEmbeddings` to `IGraphStore`
  and the Parquet writer to `pack/` (with optional DuckDB fallback if
  a temporal store is present).
- **The 108-SQL migration is still the bulk of the work.** The split
  reframes it as SOLID-aware (each finder lives on the right interface)
  but does not shrink it. ~94 graph sites + ~14 temporal sites.

The remainder of this document specifies each layer, lists the finder
methods, maps every one of the 108 sites, and rewrites AC-A-1 through
AC-A-10 to reflect the new shape.

---

## 2. Layer-by-layer specification

### 2.1 Layer 1 — Core / shared (no backend awareness)

**Lives in:** `@opencodehub/core-types` and `@opencodehub/storage/src/{column-encode,test-utils}/`.

Layer 1 contains everything that is provably backend-agnostic. The L1
contract is "if you can read these types, you can write a graph backend".

#### 2.1.1 Node and edge models

`packages/core-types/src/{nodes.ts,edges.ts,graph.ts}` are already
canonical and stable. The `KnowledgeGraph` class
(`packages/core-types/src/graph.ts:19-79`) stays a value object: it
de-duplicates by `(from,type,to,step)`, sorts via `orderedNodes()` /
`orderedEdges()`, and feeds `graphHash` (`graph-hash.ts:20-45`).

**Recommendation:** keep `KnowledgeGraph` as-is. It is correct, minimal,
and the storage layer's `bulkLoad(graph: KnowledgeGraph, opts)` already
takes it as input. Adding methods would invite leaks; the value-object
shape forces every consumer to think in terms of node/edge sets, not
mutable graph state.

#### 2.1.2 Column encoders — hoist to `@opencodehub/storage/src/column-encode.ts`

Today's duplication (audited in `explore-storage.yaml:shared_helpers:140-143`):

| Helper | DuckDB site | GraphDb site |
|---|---|---|
| `NODE_COLUMNS` | `duckdb-adapter.ts:72-97` | `graphdb-adapter.ts:103-178` |
| `nodeToRow` / `nodeToParams` | `duckdb-adapter.ts:1367-1475` | `graphdb-adapter.ts:1029-1111` |
| `dedupeLastById` | local in `duckdb-adapter.ts` | `graphdb-adapter.ts:1017-1021` |
| `*OrNull` family | `duckdb-adapter.ts:1499-1564` | `graphdb-adapter.ts:1130-1135` (et al) |
| `coveredLinesOrNull`, `languageStatsJsonOrNull`, `normalizeDeadness` | both adapters | both adapters |

**Decision: hoist into `@opencodehub/storage/src/column-encode.ts`,
not core-types.** Justification:

- These helpers depend on the `NODE_COLUMNS` order, which is a storage
  layer convention (it pins prepared-statement parameter alignment).
  Putting them in `core-types` would push storage concerns into the
  type package that ingestion / mcp / cli all depend on.
- `core-types` is the LCA of all storage consumers. Hoisting column
  encoders there would inflate every package's dep graph.
- `@opencodehub/storage` is the LCA of all storage adapters (the only
  packages that need column encoders). The `column-encode.ts` module
  becomes the seam where a third backend imports the canonical encoders
  and a third backend's adapter pinning is one import line away.
- This matches the durable lesson at
  `.erpaval/solutions/architecture-patterns/lift-pure-functions-to-shared-dep-to-break-cycles.md`
  — lift to the deepest shared dep, not deeper.

This is exactly AC-A-2's current proposal. Keep it.

#### 2.1.3 Hash invariants — already in `@opencodehub/core-types`

`canonicalJson`, `writeCanonicalJson`, `hashCanonicalJson`, `graphHash`
are all in `core-types/src/{hash,graph-hash}.ts`. Untouched.

**One promotion candidate: the parity-test sentinel coercions.** Today
the parity test (`graph-hash-parity.test.ts:25-32, 354-361, 460-462`)
encodes three round-trip rules that are not documented in the
interface:

1. `step: 0` is dropped on readback (the DuckDB INTEGER NOT NULL DEFAULT 0
   vs graph-db nullable INT32 reconciliation).
2. `languageStats: {}` is coerced to `undefined` on write and re-added
   as `{}` on readback.
3. Repo nullable fields (`originUrl`, `defaultBranch`, `repoGroup`)
   round-trip null as explicit-null, re-attached by `applyRepoNullables`.
4. `deadness: "unreachable-export"` is normalized to
   `"unreachable_export"`.

These invariants live only in test-file helpers today. They should be
hoisted into `@opencodehub/storage/src/column-encode.ts` as named
helpers (`stepZeroSentinel`, `coerceLanguageStats`, `normalizeDeadness`,
`applyRepoNullables`) that BOTH the production adapters and the parity
harness call. That makes them invariants, not test conveniences.

This subsumes AC-A-2 and tightens it.

#### 2.1.4 Parity harness — `@opencodehub/storage/src/test-utils/parity-harness.ts`

**The Liskov question:** today's parity-test rebuilders
(`rebuildFromDuckDb` at `graph-hash-parity.test.ts:377-416`,
`rebuildFromGraphDb` at `:418-475`) use raw dialect — DuckDB's
`SELECT ... FROM nodes/relations ORDER BY id` and Cypher
`MATCH/RETURN`. The current AC-A-7 hoists them as-is.

**Recommendation: rewrite both as a single `rebuildFromStore(store: IGraphStore)`
that uses ONLY the public interface methods — `listNodes()` + a new
`listEdges()` finder.** Justification:

- A parity harness that hits raw dialect cannot be reused by a third
  adapter without adding a third raw-dialect rebuilder. The harness
  becomes a Liskov-conformance test only when it goes through the
  public surface.
- Today's `listNodes()` already exists and rehydrates correctly
  (`interface.ts:52-74`). The missing piece is `listEdges()` — which
  the new finder set adds anyway (see L2.4 below).
- The step-zero / languageStats / deadness coercions live in
  `column-encode.ts` per L1.3 above, so the harness need not duplicate
  them.
- Result: the harness is ~30 lines (read all nodes + all edges, sort,
  emit `KnowledgeGraph`). Adding a third backend is "import and call",
  not "add a third raw-dialect rebuilder".

This re-frames AC-A-7: not "hoist the rebuilders" but "replace the
two raw-dialect rebuilders with one public-interface rebuilder".

#### 2.1.5 What L1 deliberately does NOT contain

- `@duckdb/node-api` types or imports (kept in L3 DuckDB adapter).
- `@ladybugdb/core` types or imports (kept in L3 graph adapter).
- Any SQL or Cypher string literal.
- Any reference to file extensions like `graph.duckdb` or `graph.lbug`
  (those move to L2's `describeArtifacts(backend)` per AC-A-8).

### 2.2 Layer 2 — Store interfaces

**Lives in:** `@opencodehub/storage/src/interface.ts` (extended).

#### 2.2.1 The split

```ts
// L2 — graph-only interface
export interface IGraphStore {
  // Lifecycle (unchanged)
  open(): Promise<void>;
  close(): Promise<void>;
  createSchema(): Promise<void>;

  // Bulk write (graph nodes + edges only)
  bulkLoad(graph: KnowledgeGraph, opts?: BulkLoadOptions): Promise<BulkLoadStats>;

  // Embeddings (graph-tier — vectors live alongside graph nodes)
  upsertEmbeddings(rows: readonly EmbeddingRow[]): Promise<void>;
  listEmbeddingHashes(): Promise<Map<string, string>>;
  listEmbeddings(opts?: ListEmbeddingsOptions): AsyncIterable<EmbeddingRow>;

  // Read-side: typed finders only — NO rawQuery escape hatch
  listNodes(opts?: ListNodesOptions): Promise<readonly GraphNode[]>;
  listNodesByKind(kind: NodeKind, opts?: ListNodesByKindOptions): Promise<readonly GraphNode[]>;
  listEdges(opts?: ListEdgesOptions): Promise<readonly CodeRelation[]>;
  listEdgesByType(type: RelationType, opts?: ListEdgesByTypeOptions): Promise<readonly CodeRelation[]>;
  listFindings(opts?: ListFindingsOptions): Promise<readonly FindingNode[]>;
  listDependencies(opts?: ListDependenciesOptions): Promise<readonly DependencyNode[]>;
  countNodesByKind(kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>>;

  // Search
  search(q: SearchQuery): Promise<readonly SearchResult[]>;
  vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]>;

  // Traversal — typed, replaces WITH RECURSIVE
  traverse(q: TraverseQuery): Promise<readonly TraverseResult[]>;
  traverseAncestors(opts: AncestorTraversalOptions): Promise<readonly TraverseResult[]>;
  traverseDescendants(opts: DescendantTraversalOptions): Promise<readonly TraverseResult[]>;

  // Meta + health
  getMeta(): Promise<StoreMeta | undefined>;
  setMeta(meta: StoreMeta): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;

  // ESCAPE HATCH (optional, deliberately last) — community adapter use only
  /**
   * Run a backend-native read-only Cypher (or equivalent) statement.
   * Returns Records with engine-specific scalar types coerced through the
   * adapter's codec. Throws on write verbs. Use only when a typed finder
   * does not exist; the OCH core never calls this method itself.
   */
  execCypher?(statement: string, params?: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>;
}

// L2 — temporal/tabular-only interface
export interface ITemporalStore {
  // Lifecycle (mirrors IGraphStore)
  open(): Promise<void>;
  close(): Promise<void>;
  createSchema(): Promise<void>;

  // Cochanges (was on IGraphStore via CochangeStore)
  bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void>;
  lookupCochangesForFile(file: string, opts?: CochangeLookupOptions): Promise<readonly CochangeRow[]>;
  lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined>;

  // Symbol summaries (was on IGraphStore via SymbolSummaryStore)
  bulkLoadSymbolSummaries(rows: readonly SymbolSummaryRow[]): Promise<void>;
  lookupSymbolSummary(nodeId: string, contentHash: string, promptVersion: string): Promise<SymbolSummaryRow | undefined>;
  lookupSymbolSummariesByNode(nodeIds: readonly string[]): Promise<readonly SymbolSummaryRow[]>;

  // Risk-snapshot temporal aggregates (was raw COUNT in analysis/risk-snapshot.ts)
  countFindingsBySeverity(opts?: { baselineState?: BaselineState }): Promise<Record<Severity, number>>;
  countByKind(kinds: readonly NodeKind[]): Promise<Map<NodeKind, number>>;

  // Temporal raw-SQL escape hatch — required by `codehub query --sql`
  exec(sql: string, params?: readonly SqlParam[], opts?: { timeoutMs?: number }): Promise<readonly Record<string, unknown>[]>;

  // Health
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

// L2 — open both stores together
export interface OpenStoreResult {
  readonly graph: IGraphStore;
  readonly temporal: ITemporalStore;
  readonly close: () => Promise<void>;  // closes both deterministically
}

export function openStore(opts: { path: string; backend?: BackendKind }): Promise<OpenStoreResult>;
```

#### 2.2.2 Where embeddings live

`upsertEmbeddings` + `listEmbeddingHashes` + `listEmbeddings` + `vectorSearch`
sit on **`IGraphStore`** because:

- LadybugDB stores Embedding nodes natively (`graphdb-schema.ts:204-227`)
  with `CALL QUERY_VECTOR_INDEX` (`graphdb-adapter.ts:717-734`).
- Apache AGE / Neo4j / Memgraph / Neptune all expose vector search at
  the graph layer (Memgraph + Neo4j with native HNSW; AGE via pgvector
  side-table; Neptune Analytics with native ANN). The research packet
  (`research-graphdb-backends.yaml:embeddings_support`) confirms this
  is the correct seam.
- DuckDB's `vss` / `hnsw_acorn` extensions also live on the graph
  side of the DuckDB adapter — the existing duckdb-adapter wires
  vector search via the `embeddings` table joined to `nodes`
  (`duckdb-adapter.ts:1010-1014`).

`exportEmbeddingsToSidecar` does NOT sit on either interface. It lives
in `pack/`, reads via `IGraphStore.listEmbeddings()`, and writes Parquet
via either DuckDB `COPY TO PARQUET` (when a temporal store is present)
or `@dsnp/parquetjs` fallback. See L4.4.

#### 2.2.3 Where `bulkLoad(KnowledgeGraph)` lives

On `IGraphStore` only. The graph backend is the only consumer.
Cochange + symbol-summary bulk-loads are separate `ITemporalStore`
methods (already named above).

#### 2.2.4 Composition vs union

`openStore({path,backend})` returns `{graph, temporal, close}` —
**composition**. Justification:

- Single object via inheritance would force the graph backend to
  implement temporal methods (the current `extends CochangeStore,
  SymbolSummaryStore` mistake).
- Composition lets the runtime route `cochanges` → DuckDB even when
  the graph backend is LadybugDB.
- It also lets a future "graph backend has no temporal sidecar"
  deployment open just `{graph}` (e.g. AGE on its own Postgres).
- Callers that genuinely need both (rare — only `code-pack` and
  `wiki-render`) take both. Callers that only do graph reads
  (most MCP tools) take only `graph`.

#### 2.2.5 Re-uniting at the call site (optional sugar)

For convenience, the storage package can export a `Store` type alias:

```ts
export type Store = OpenStoreResult;
```

So `function withStore(store: Store) { store.graph.listNodes(...); store.temporal.exec(...); }`. No magic, no runtime cost.

#### 2.2.6 What this collapses from current AC list

- AC-A-1's `Store.dialect: "sql" | "cypher"` marker is deleted. Dialect
  is type-determined: `IGraphStore` is Cypher (or in-memory typed
  finders), `ITemporalStore` is SQL. Rename `query()` doesn't apply
  on `IGraphStore` because `query()` doesn't exist there — only typed
  finders + an optional `execCypher?()` escape hatch.
- AC-A-3's "fill CochangeStore + SymbolSummaryStore on `GraphDbStore`"
  becomes "delete the methods from `GraphDbStore`; route to
  `ITemporalStore`". `graphdb-adapter.ts:881-916` deletes outright.
- The `StoreDialectMismatchError` in AC-A-1 is unnecessary — the type
  system enforces it.

### 2.3 Layer 3 — Adapters

**Lives in:** `@opencodehub/storage/src/{duckdb,graphdb}-adapter.ts` plus
optional community forks.

#### 2.3.1 DuckDbStore split

Today's `DuckDbStore` (`duckdb-adapter.ts:102-2000+`) implements
`IGraphStore` (which extends `CochangeStore + SymbolSummaryStore`).
Under the split it must implement BOTH `IGraphStore` AND
`ITemporalStore` — but only because DuckDB happens to be capable of
both. The implementation factors as:

```ts
// Same DuckDB connection backs both classes — composition, not inheritance.
class DuckDbGraphStore implements IGraphStore {
  constructor(private readonly conn: DuckDBConnection, opts: ...) {}
  // listNodes, listEdges, traverse, search, vectorSearch, bulkLoad, embeddings
}

class DuckDbTemporalStore implements ITemporalStore {
  constructor(private readonly conn: DuckDBConnection, opts: ...) {}
  // cochanges, symbol summaries, exec(sql)
}

// Factory composes both over one connection
export async function openDuckDbStore(path: string, opts: ...): Promise<OpenStoreResult> {
  const conn = await DuckDBInstance.create(path).connect();
  const graph = new DuckDbGraphStore(conn, opts);
  const temporal = new DuckDbTemporalStore(conn, opts);
  await graph.open();  // creates tables
  await temporal.open();
  return { graph, temporal, close: async () => { await graph.close(); /* conn.closeSync via temporal.close */ }};
}
```

The legacy `DuckDbStore` class can stay as a deprecated facade that
delegates to both — single milestone deprecation per AC-A-1's existing
shim convention, then removed in v1.1.

#### 2.3.2 GraphDbStore (LadybugDB)

`GraphDbStore` implements `IGraphStore` only. The
`NotImplementedError` block at `graphdb-adapter.ts:881-916` deletes
outright — those methods leave the interface entirely. The
`bulkLoadCochanges` / `lookupCochangesForFile` / etc. don't exist on
`GraphDbStore` because they don't exist on `IGraphStore`.

`openGraphDbStore(path, opts)` returns `{graph: graphDbStore, temporal: duckTemporal, close}` —
i.e. on a LadybugDB-default deployment, the `temporal` slot is filled
by a DuckDB temporal-only store opened against `temporal.duckdb` (see
the AC-A-8 `describeArtifacts` extension in §3 below).

#### 2.3.3 Community adapters (AGE / Memgraph / Neo4j / Neptune)

Per `research-graphdb-backends.yaml:compatibility_risks.local_first_violation:354-360`,
none of the four can serve as a temporal store cleanly. They are
graph-only. So the community adapter slot is exclusively `IGraphStore`,
and the temporal slot is always DuckDB (or a future SQLite/Parquet
adapter).

The escape-hatch `execCypher?()` on `IGraphStore` handles AGE's
`cypher('graph_name', $$ ... $$)` framing; the codec hook from
`research-graphdb-backends.yaml:igraphstore_union_surface.codecs:332-334`
is deferred to v1.1 ADR 0013 follow-on (not in v1.0 scope).

#### 2.3.4 Legacy `codehub query --sql`

The temporal-analytics escape hatch (S-A-3 in current spec) routes to
`store.temporal.exec(sql, params)`, full stop. `IGraphStore` has no
`exec(sql)` method, so the only place SQL can land is the temporal
store. This is structurally sound under the split.

### 2.4 Layer 4 — Consumers

Each consumer takes only what it needs. The migration map (§5)
classifies every one of the 108 sites by which interface it lands on.

The pattern is uniform:

```ts
// BEFORE
function listFindings(store: DuckDbStore) {
  return store.query("SELECT * FROM nodes WHERE kind = ?", ["Finding"]);
}

// AFTER
function listFindings(store: IGraphStore) {
  return store.listFindings();
}
```

For consumers that need both graph and temporal:

```ts
function buildPack(store: Store) {
  const xrefs = await store.graph.listEdgesByType("CALLS");
  const cochanges = await store.temporal.lookupCochangesForFile(file);
}
```

The 41 concrete-class type pins (`explore-storage.yaml:ambient_couplings.concrete_class_type_pins`)
become `IGraphStore` (most cases) or `Store` (cases that need both).

---

## 3. Migration plan: revised AC list for Track A

The revised ACs preserve numbering for spec-diff legibility but mark
the changes inline. The new shape merges some current ACs and adds
two new ones for the temporal split.

### AC-A-1 (REWRITTEN) — Split `IGraphStore` into graph-only + `ITemporalStore`

Current AC-A-1 renames `query` → `rawQuery` and adds a `dialect` marker.
Under the revised design, the rename is unnecessary because the method
moves entirely:

- [ ] `packages/storage/src/interface.ts` — remove `query(sql, params)` from
  `IGraphStore`; remove `extends CochangeStore, SymbolSummaryStore`; add
  `ITemporalStore` interface with `exec(sql, params)` + cochange + summary
  methods; add `OpenStoreResult` + `openStore({path,backend})` signature.
- [ ] `packages/storage/src/interface.ts` — add optional `execCypher?(statement, params)`
  on `IGraphStore` for community-adapter use. OCH core never calls it.
- [ ] Remove `StoreDialectMismatchError` proposal (no longer needed —
  type system enforces the split).
- [ ] Update `interface.test.ts` to assert structural separation: a value
  satisfying `IGraphStore` must not have a `cochanges` method.
- **Dependencies:** none — MUST land first.
- [P]

### AC-A-2 (UNCHANGED in scope, EXTENDED in content) — Hoist column encoders + sentinel coercions

- [ ] `packages/storage/src/column-encode.ts` — exports per current AC-A-2,
  PLUS new entries: `stepZeroSentinel`, `coerceLanguageStats`,
  `applyRepoNullables` — promotion of the parity-test sentinel rules.
- [ ] Both adapters drop local definitions and import from
  `./column-encode.js`.
- [ ] Document the sentinel rules in interface.ts JSDoc (per
  current spec's "priority_2_nice_to_have" #295).
- **Dependencies:** AC-A-1.
- [P]

### AC-A-3 (REWRITTEN) — Delete `CochangeStore` + `SymbolSummaryStore` from `GraphDbStore`; route via `ITemporalStore`

Current AC-A-3 implements six methods on `GraphDbStore` against the
LadybugDB cochange/summary NODE TABLEs. Under the split, those
NODE TABLEs delete and the temporal store handles cochanges
universally:

- [ ] `packages/storage/src/graphdb-adapter.ts:881-916` — delete the
  `NotImplementedError` block AND the cochange/summary method
  signatures. They don't exist on `IGraphStore` anymore.
- [ ] `packages/storage/src/graphdb-schema.ts:204-227` — delete
  `Cochange` + `SymbolSummary` NODE TABLEs.
- [ ] `packages/storage/src/duckdb-adapter.ts` — split into
  `DuckDbGraphStore` + `DuckDbTemporalStore` over one
  `DuckDBConnection` (per L3.1).
- [ ] `openStore({backend:'lbug'})` → `{graph: GraphDbStore, temporal: DuckDbTemporalStore over '.codehub/temporal.duckdb'}`.
- [ ] `openStore({backend:'duck'})` → `{graph: DuckDbGraphStore, temporal: DuckDbTemporalStore over the same '.codehub/graph.duckdb' connection}`.
- [ ] Parity-test extension: cochange/summary parity moves to a
  separate `temporal-parity.test.ts` against `ITemporalStore` only;
  graph parity (`graph-hash-parity.test.ts`) loses cochange + summary
  fixtures.
- **Dependencies:** AC-A-1, AC-A-2.
- [P]

### AC-A-4 (REWRITTEN) — Move sidecar emission to `pack/`

- [ ] `packages/storage/src/interface.ts` — add `listEmbeddings(opts?: ListEmbeddingsOptions): AsyncIterable<EmbeddingRow>` on `IGraphStore`.
- [ ] `packages/storage/src/duckdb-adapter.ts:465-496` — delete
  `exportEmbeddingsParquet` from the public surface (move logic into
  pack/). Keep a private DuckDB-specific Parquet emitter as an
  internal helper called by pack.
- [ ] `packages/storage/src/graphdb-adapter.ts` — implement
  `listEmbeddings` over LadybugDB's Embedding NODE TABLE.
- [ ] `packages/pack/src/embeddings-sidecar.ts` — rewrite to call
  `store.graph.listEmbeddings()`, write Parquet via DuckDB COPY when
  `store.temporal` is a DuckDB-backed adapter, else fall back to
  `@dsnp/parquetjs` (deterministic). Stamp `determinism_class:
  degraded` only if no Parquet path is achievable.
- [ ] Test: byte-identity Parquet emission on DuckDb path; deterministic
  emission on LadybugDB path via either DuckDB-fallback or
  `@dsnp/parquetjs`.
- **Dependencies:** AC-A-1.
- [P]

### AC-A-5 (UNCHANGED in scope, EXTENDED) — Replace `DuckDbStore` parameter types with `IGraphStore` / `Store`

- [ ] All 41 files from current AC-A-5 plus the new finer routing:
  callers that read graph only take `IGraphStore`; callers that need
  both take `Store` (= `OpenStoreResult`).
- [ ] `packages/cli/src/commands/code-pack.ts:39,71,120,129,131,182` —
  delete `instanceof DuckDbStore` branch; ownership flows through
  `Store.close()`.
- [ ] `packages/cli/src/commands/list.ts:37,48` — replace
  `existsSync('.codehub/graph.duckdb')` with `codehubIsIndexed(repoPath)`
  helper that checks any of `graph.duckdb` / `graph.lbug` / `temporal.duckdb`.
- [ ] `packages/cli/src/commands/doctor.ts:217-247` — symmetric probe
  per current spec.
- **Dependencies:** AC-A-1, AC-A-2, AC-A-3, AC-A-4.
- [P]

### AC-A-6 (REWRITTEN) — Full 108-SQL migration via typed finders

This is the biggest change. Current AC-A-6 migrates 4 of 108 sites.
The revised AC migrates all 108, classified per §5 below.

- [ ] `packages/storage/src/interface.ts` — add the full finder set
  per §4: `listNodesByKind`, `listEdges`, `listEdgesByType`,
  `listFindings`, `listDependencies`, `listRoutes`,
  `traverseAncestors`, `traverseDescendants`, `countNodesByKind`,
  `listConsumerProducerEdges`, `getRepoNode`. (Justified per-site
  in §5.)
- [ ] Both adapters implement every finder.
- [ ] Migrate every one of the 108 sites per §5's table — broken
  into four sub-PRs / four commits inside Track A:
  - 6a — analysis/ (27 sites)
  - 6b — mcp/ (46 sites)
  - 6c — pack/ + wiki/ (15 sites)
  - 6d — cli/ (20 sites)
- [ ] Rewrite `packages/analysis/src/test-utils.ts:214-482` from a
  DuckDB-dialect regex fake into a typed `IGraphStore` fake that
  implements the finder surface.
- [ ] Test: each migrated tool runs end-to-end on BOTH DuckDb and
  LadybugDB backends.
- **Dependencies:** AC-A-1, AC-A-5.
- **Not [P]** within itself — the four sub-commits sequence
  sequentially to keep each commit reviewable.

### AC-A-7 (REWRITTEN) — Rewrite parity harness as public-interface rebuilder

- [ ] `packages/storage/src/test-utils/parity-harness.ts` — exports
  `rebuildFromStore(graph: IGraphStore): Promise<KnowledgeGraph>`,
  `assertGraphParity(fixture, {stores: IGraphStore[]})`.
- [ ] The rebuilder uses ONLY public methods: `listNodes()` +
  `listEdges()`. No SQL, no Cypher.
- [ ] `packages/storage/src/graph-hash-parity.test.ts` — reduces to
  fixture builders + `assertGraphParity(fixture, {stores: [duckGraph, graphDbGraph]})`.
- [ ] `packages/storage/src/temporal-parity.test.ts` (new) — tests
  cochange + summary round-trip on `ITemporalStore` adapters
  separately. NOT part of `graphHash` (cochanges never enter the
  graph hash anyway — `interface.ts:122-127` already says so).
- [ ] Doc-comment in interface.ts: third-party adapter authors only
  need to satisfy `IGraphStore` and pass `assertGraphParity` to claim
  conformance.
- **Dependencies:** AC-A-2, AC-A-3, AC-A-6.
- [P]

### AC-A-8 (EXTENDED) — Generalize `paths.ts` for two-store deployments

- [ ] `packages/storage/src/paths.ts:14` — replace `DB_FILE_NAME`
  with `describeArtifacts(backend): { graphFile, temporalFile, schemaName }`:
  - `backend: "lbug"` → `{ graphFile: "graph.lbug", temporalFile: "temporal.duckdb" }`
  - `backend: "duck"` → `{ graphFile: "graph.duckdb", temporalFile: "graph.duckdb" }` (same file)
- [ ] `packages/cli/src/commands/list.ts:37,48` — `codehubIsIndexed(repoPath)`
  checks for any of the three legacy/current artifacts.
- [ ] `packages/mcp/src/tools/shared.ts:170` — error message lists all
  candidate paths.
- **Dependencies:** AC-A-5.
- [P]

### AC-A-9 (UNCHANGED) — Flip `CODEHUB_STORE=lbug` default

- [ ] `packages/cli/src/commands/open-store.ts` — default `backend: "lbug"` when
  `CODEHUB_STORE` unset and `@ladybugdb/core` importable; else fall
  back to `"duck"` with stderr warning.
- [ ] Dual-artifact detection — prefer newer-mtime when both
  `graph.duckdb` and `graph.lbug` present.
- [ ] `docs/adr/0013-m7-default-flip-and-abstraction.md` — documents
  the layer split, the temporal/graph separation, and the
  AGE/Memgraph/Neo4j/Neptune escape-hatch surface.
- **Dependencies:** AC-A-3, AC-A-5, AC-A-6, AC-A-7, AC-A-8.
- **Not [P]**.

### AC-A-10 (UNCHANGED) — Final graphHash parity audit on testbed corpus

Same as current spec.

### AC-A-11 (NEW) — Conformance test contract for community adapters

- [ ] `packages/storage/src/test-utils/conformance.ts` — exports
  `assertIGraphStoreConformance(name: string, factory: () => Promise<IGraphStore>)`.
- [ ] The conformance suite tests:
  - All finder methods return well-typed results.
  - `listNodes()` + `listEdges()` round-trip every fixture in
    `parity-harness.ts` (the Liskov contract).
  - `listEdgesByType` is byte-equivalent to `listEdges().filter(e => e.type === t)`.
  - `traverse` hits `(target, depth, path)` invariants.
  - `vectorSearch` returns ordered results when the optional vector
    capability is present.
  - `healthCheck` returns `{ok: true}` after `open() + createSchema()`.
- [ ] Both DuckDb and GraphDb adapters opt in by importing the suite
  in their respective test files.
- [ ] Doc-comment names this as the v1.0 community-adapter conformance
  contract.
- **Dependencies:** AC-A-7.
- [P]

### What changes vs current spec

| Current AC | Status | New shape |
|---|---|---|
| AC-A-1 | REWRITTEN | Split interface, drop dialect marker (type-enforced) |
| AC-A-2 | EXTENDED | Hoist + promote sentinel rules |
| AC-A-3 | REWRITTEN | Delete cochange/summary from `GraphDbStore`; route to `ITemporalStore` |
| AC-A-4 | REWRITTEN | Move sidecar to `pack/`; add `listEmbeddings()` to `IGraphStore` |
| AC-A-5 | EXTENDED | Replace types with `IGraphStore` or `Store` per call-site needs |
| AC-A-6 | REWRITTEN | Full 108-site migration in 4 sub-commits |
| AC-A-7 | REWRITTEN | Public-interface rebuilder, not raw-dialect rebuilders |
| AC-A-8 | EXTENDED | `describeArtifacts` returns two files for lbug, one for duck |
| AC-A-9 | UNCHANGED | Default flip after all above land |
| AC-A-10 | UNCHANGED | Parity audit |
| AC-A-11 | **NEW** | Conformance test suite for community adapters |

---

## 4. Minimum complete `IGraphStore` + `ITemporalStore` interface

TypeScript signatures with comments naming each method's caller(s).

### 4.1 `IGraphStore` — graph-only

```ts
export type BackendKind = "duck" | "lbug" | "age" | "memgraph" | "neo4j" | "neptune";

/**
 * Graph-only store. NEVER carries cochanges, symbol summaries, or
 * temporal-table queries. NEVER exposes a SQL escape hatch (community
 * adapters that need Cypher escape use the optional `execCypher?`).
 */
export interface IGraphStore {
  // ── Lifecycle ────────────────────────────────────────────────────────
  open(): Promise<void>;
  close(): Promise<void>;
  createSchema(): Promise<void>;
  /** Connectivity + binding probe. Used by codehub doctor + AC-A-3 startup checks. */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;

  // ── Bulk write ──────────────────────────────────────────────────────
  /**
   * Replace or upsert the graph. Uses `KnowledgeGraph.orderedNodes()` /
   * `orderedEdges()` so the parity invariant U1 holds. Used by ingestion
   * orchestrator and analyze CLI.
   */
  bulkLoad(graph: KnowledgeGraph, opts?: BulkLoadOptions): Promise<BulkLoadStats>;

  // ── Embeddings (graph-tier — vectors live with graph nodes) ─────────
  upsertEmbeddings(rows: readonly EmbeddingRow[]): Promise<void>;
  listEmbeddingHashes(): Promise<Map<string, string>>;
  /**
   * Stream every embedding row (no in-memory materialization). Used by
   * pack/embeddings-sidecar.ts to write the Parquet artifact.
   */
  listEmbeddings(opts?: ListEmbeddingsOptions): AsyncIterable<EmbeddingRow>;

  // ── Read finders (typed; replaces 94 of 108 raw SQL sites) ──────────
  /** All nodes, optionally filtered by kind set + paged. Used by listNodes-callers. */
  listNodes(opts?: ListNodesOptions): Promise<readonly GraphNode[]>;
  /** Single-kind shorthand. Used by xrefs, skeleton, list-findings, dependencies, wiki. */
  listNodesByKind<K extends NodeKind>(kind: K, opts?: ListNodesByKindOptions): Promise<readonly NodeOfKind<K>[]>;
  /** All edges, optionally filtered + paged. Used by parity rebuilder + xrefs/skeleton. */
  listEdges(opts?: ListEdgesOptions): Promise<readonly CodeRelation[]>;
  /** Single-type shorthand. Used by pack/xrefs.ts, pack/skeleton.ts, group-contracts.ts. */
  listEdgesByType(type: RelationType, opts?: ListEdgesByTypeOptions): Promise<readonly CodeRelation[]>;
  /** Findings filter. Used by analysis/verdict.ts, mcp/tools/list-findings.ts, pack/findings.ts, wiki. */
  listFindings(opts?: ListFindingsOptions): Promise<readonly FindingNode[]>;
  /** Dependencies filter. Used by mcp/tools/dependencies.ts, license_audit, wiki. */
  listDependencies(opts?: ListDependenciesOptions): Promise<readonly DependencyNode[]>;
  /** Routes filter. Used by mcp/tools/route-map.ts, group-contracts.ts. */
  listRoutes(opts?: ListRoutesOptions): Promise<readonly RouteNode[]>;
  /** Repo-node by id (replaces SELECT repo_uri FROM nodes WHERE id = ?). Used by mcp/repo-uri-for-entry.ts, group-cross-repo. */
  getRepoNode(id: string): Promise<RepoNode | undefined>;
  /** Counts grouped by kind. Used by analysis/risk-snapshot.ts and project_profile. */
  countNodesByKind(kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>>;
  /** Counts grouped by edge type. Used by risk-snapshot, route-map. */
  countEdgesByType(types?: readonly RelationType[]): Promise<Map<RelationType, number>>;

  // ── Search ──────────────────────────────────────────────────────────
  /** BM25 search. Same shape as today; backend-internal index. */
  search(q: SearchQuery): Promise<readonly SearchResult[]>;
  /** Vector search. `whereClause` becomes `kindFilter` + `confidenceFloor` (typed) — no raw SQL. */
  vectorSearch(q: VectorQuery): Promise<readonly VectorResult[]>;

  // ── Traversal (typed; replaces WITH RECURSIVE) ──────────────────────
  /** Generic traverse — same as today. */
  traverse(q: TraverseQuery): Promise<readonly TraverseResult[]>;
  /** Specialized — replaces WITH RECURSIVE in analysis/impact.ts:332-355 and mcp/tools/query.ts. */
  traverseAncestors(opts: AncestorTraversalOptions): Promise<readonly TraverseResult[]>;
  /** Specialized — symmetric to traverseAncestors. */
  traverseDescendants(opts: DescendantTraversalOptions): Promise<readonly TraverseResult[]>;

  // ── Producer/consumer edges (cross-repo contracts) ──────────────────
  /** Replaces group-contracts.ts FETCHES + Route SQL. Returns producer-consumer pairs across repos. */
  listConsumerProducerEdges(opts?: { repoUris?: readonly string[] }): Promise<readonly ConsumerProducerEdge[]>;

  // ── Meta + escape hatch ─────────────────────────────────────────────
  getMeta(): Promise<StoreMeta | undefined>;
  setMeta(meta: StoreMeta): Promise<void>;

  /**
   * Optional escape hatch for community adapters whose backend exposes
   * a feature OCH's typed finders don't cover. The OCH core never calls
   * this method; it exists so an AGE adapter author can wire AGE's
   * `cypher('graph_name', $$ ... $$)` framing through user-supplied
   * Cypher. Returns Records with adapter-coerced scalars.
   *
   * Throws on write verbs (adapter-side guard, mirrors today's
   * assertReadOnlyCypher).
   */
  execCypher?(statement: string, params?: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>;
}
```

### 4.2 `ITemporalStore` — tabular-only

```ts
/**
 * Temporal/tabular store. Cochanges, symbol summaries, time-travel,
 * and the `codehub query --sql` escape hatch all live here. Backed by
 * DuckDB today; future SQLite or Parquet-sidecar adapters fit the same
 * surface. Graph-only community backends (AGE/Memgraph/Neo4j/Neptune)
 * NEVER implement this interface — they pair with a DuckDb temporal
 * store.
 */
export interface ITemporalStore {
  open(): Promise<void>;
  close(): Promise<void>;
  createSchema(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;

  // ── Cochanges (was IGraphStore.CochangeStore) ────────────────────────
  bulkLoadCochanges(rows: readonly CochangeRow[]): Promise<void>;
  lookupCochangesForFile(file: string, opts?: CochangeLookupOptions): Promise<readonly CochangeRow[]>;
  lookupCochangesBetween(fileA: string, fileB: string): Promise<CochangeRow | undefined>;

  // ── Symbol summaries (was IGraphStore.SymbolSummaryStore) ────────────
  bulkLoadSymbolSummaries(rows: readonly SymbolSummaryRow[]): Promise<void>;
  lookupSymbolSummary(nodeId: string, contentHash: string, promptVersion: string): Promise<SymbolSummaryRow | undefined>;
  lookupSymbolSummariesByNode(nodeIds: readonly string[]): Promise<readonly SymbolSummaryRow[]>;

  // ── Risk-snapshot temporal aggregates ────────────────────────────────
  /** Replaces analysis/risk-snapshot.ts:172 raw COUNT. */
  countFindingsBySeverity(opts?: { baselineState?: BaselineState }): Promise<Record<Severity, number>>;

  // ── SQL escape hatch — required by `codehub query --sql` (S-A-3) ─────
  /**
   * Run a user-supplied read-only SQL statement with bound parameters.
   * Backend-internal guard rejects write verbs. Used by mcp/tools/query.ts
   * and cli/commands/query.ts ONLY when --sql is explicitly passed. Other
   * MCP tools do NOT call this — they go through IGraphStore typed finders.
   */
  exec(sql: string, params?: readonly SqlParam[], opts?: { timeoutMs?: number }): Promise<readonly Record<string, unknown>[]>;
}
```

### 4.3 `OpenStoreResult` + factory

```ts
export interface OpenStoreResult {
  readonly graph: IGraphStore;
  readonly temporal: ITemporalStore;
  /** Closes both stores in deterministic order. */
  readonly close: () => Promise<void>;
}

export type Store = OpenStoreResult;

export interface OpenStoreOptions {
  readonly path: string;
  readonly backend?: BackendKind;       // default: "auto" (lbug if available, else duck)
  readonly readOnly?: boolean;
  readonly embeddingDim?: number;
  readonly timeoutMs?: number;
}

/**
 * Single entry point for every consumer. Resolves the backend via env
 * (CODEHUB_STORE) + binding-availability + dual-artifact mtime, then
 * composes a graph store and a temporal store over the chosen
 * underlying database file(s).
 *
 * Layout per AC-A-8:
 *   - backend: "lbug" → graph at .codehub/graph.lbug, temporal at .codehub/temporal.duckdb
 *   - backend: "duck" → graph + temporal share .codehub/graph.duckdb (single file)
 *   - backend: community → graph at <connection-string>, temporal at .codehub/temporal.duckdb
 */
export function openStore(opts: OpenStoreOptions): Promise<OpenStoreResult>;
```

---

## 5. The 108-SQL migration map

**Total sites:** 108. **Graph-bound:** ~94. **Temporal-bound:** ~14.

Site counts grounded in `explore-storage.yaml:outside_storage_leaks:54-108` and the `runtime_symptom`/`high_value_targets` tables at `:253-267`.

### 5.1 analysis/ (27 sites — all graph-bound)

| File:line | Today's SQL | Target interface | New finder method |
|---|---|---|---|
| `impact.ts:83-86` | `SELECT id,kind,file_path FROM nodes WHERE id = ?` | `IGraphStore` | `listNodes({ids:[id]})` (extend `ListNodesOptions` with `ids`) |
| `impact.ts:106-108` | `SELECT from_id,to_id,type,confidence FROM relations WHERE from_id = ?` | `IGraphStore` | `listEdges({fromId})` |
| `impact.ts:131-135` | `SELECT ... FROM nodes WHERE entry_point_id = ?` | `IGraphStore` | `listNodesByEntryPoint(id)` (specialized; alternative: extend `ListNodesOptions.entryPointId`) |
| `impact.ts:196-201` | `SELECT id,kind,name FROM nodes WHERE kind IN (...)` | `IGraphStore` | `listNodesByKind(kinds)` |
| `impact.ts:251-258` | `SELECT ... FROM relations` | `IGraphStore` | `listEdges({types, confidenceFloor})` |
| `impact.ts:273-280` | similar | `IGraphStore` | `listEdges` |
| `impact.ts:332-355` | `WITH RECURSIVE ... USING KEY (ancestor_id)` | `IGraphStore` | **`traverseAncestors({startId, maxDepth, relationTypes, confidenceFloor})`** |
| `verdict.ts:520-540` | `SELECT FROM nodes WHERE kind='Finding'` | `IGraphStore` | `listFindings({severity, baselineState, suppressed})` |
| `verdict.ts:541-580` | `SELECT FROM relations` | `IGraphStore` | `listEdges` |
| `verdict.ts:581-620` | `SELECT FROM nodes WHERE kind='Finding'` filter on `suppressed_json` | `IGraphStore` | `listFindings({suppressed:false})` (rehydrate suppressed_json into typed field) |
| `verdict.ts:621-660` | mixed | `IGraphStore` | `listFindings` |
| `verdict.ts:661-700` | mixed | `IGraphStore` | `listFindings` + `countNodesByKind` |
| `verdict.ts:701-715` | mixed | `IGraphStore` | `countNodesByKind` |
| `detect-changes.ts:103-130` | `SELECT FROM nodes WHERE id IN (...)` | `IGraphStore` | `listNodes({ids})` |
| `detect-changes.ts:131-145` | similar | `IGraphStore` | `listNodes({ids})` |
| `detect-changes.ts:146-165` | `SELECT FROM relations WHERE from_id IN (...)` | `IGraphStore` | `listEdges({fromIds})` |
| `detect-changes.ts:166-170` | `SELECT FROM relations WHERE to_id IN (...)` | `IGraphStore` | `listEdges({toIds})` |
| `rename.ts:51` | `SELECT id,name,file_path,kind,start_line,end_line FROM nodes WHERE name = ?` | `IGraphStore` | `listNodesByName(name, opts?)` (new specialized finder) |
| `rename.ts:59` | similar with `kind` filter | `IGraphStore` | `listNodesByName(name, {kinds})` |
| `rename.ts:81` | `SELECT FROM relations` JOIN `nodes` | `IGraphStore` | `listEdges({fromIds, toIds})` + post-join in TS |
| `rename.ts:104` | similar | `IGraphStore` | `listEdges` + TS join |
| `dead-code.ts:242-260` | `SELECT FROM nodes WHERE kind IN ('Function','Method','Class') AND deadness IS NOT NULL` | `IGraphStore` | `listNodesByKind(kinds, {deadness:'any'})` (extend `ListNodesByKindOptions` with `deadness` filter) |
| `dead-code.ts:261-280` | `SELECT FROM relations WHERE type IN (...)` | `IGraphStore` | `listEdgesByType(types)` |
| `dead-code.ts:281-305` | `SELECT FROM nodes` + relations join | `IGraphStore` | `listNodes` + `listEdges` |
| `risk-snapshot.ts:123` | `SELECT COUNT(*) FROM nodes WHERE kind = ?` | `IGraphStore` | `countNodesByKind` |
| `risk-snapshot.ts:154` | similar | `IGraphStore` | `countNodesByKind` |
| `risk-snapshot.ts:160` | `SELECT COUNT(*) FROM relations WHERE type = ?` | `IGraphStore` | `countEdgesByType` |
| `risk-snapshot.ts:172` | `SELECT COUNT(*) FROM nodes WHERE kind='Finding' AND severity = ?` | **`ITemporalStore`** | `countFindingsBySeverity()` (it's a tabular aggregate over finding rows) — OR keep on `IGraphStore.listFindings({severity}).length` if Finding nodes never leave the graph |

**Note:** `risk-snapshot.ts:172` is the one site that could go either way. Recommendation: keep on `IGraphStore.listFindings({severity})` since Finding nodes are graph-tier. `ITemporalStore` is for cochanges/summaries/time-travel, not finding aggregates.

### 5.2 mcp/ (46 sites — mostly graph-bound)

| File:line | Pattern | Target | Finder |
|---|---|---|---|
| `mcp/tools/query.ts:46` | `SELECT FROM information_schema` | `ITemporalStore.exec()` (debug introspection) OR delete | `exec` |
| `mcp/tools/query.ts:206` | `SELECT FROM nodes WHERE kind=?` | `IGraphStore` | `listNodesByKind` |
| `mcp/tools/query.ts:236` | `SELECT FROM nodes ORDER BY ...` | `IGraphStore` | `listNodes` |
| `mcp/tools/query.ts:261` | similar | `IGraphStore` | `listNodes` |
| `mcp/tools/query.ts:331` | `WITH RECURSIVE` | `IGraphStore` | `traverseAncestors` |
| `mcp/tools/query.ts:474` | `WITH RECURSIVE USING KEY` | `IGraphStore` | `traverseAncestors` |
| `mcp/tools/query.ts:491-510` | mixed | `IGraphStore` | various finders |
| `mcp/tools/group-contracts.ts:24` | type pin | type-only | none |
| `mcp/tools/group-contracts.ts:85` | `SELECT FROM relations WHERE type='FETCHES'` | `IGraphStore` | `listEdgesByType('FETCHES')` |
| `mcp/tools/group-contracts.ts:104` | `SELECT FROM nodes WHERE kind='Route'` | `IGraphStore` | `listRoutes()` |
| `mcp/tools/api-impact.ts:25,134,206,218,230,239` | type pin + 5 SELECTs | `IGraphStore` | `listRoutes`, `listNodesByKind`, `traverseDescendants` |
| `mcp/tools/shape-check.ts:25,127,166` | type pin + 2 SELECTs | `IGraphStore` | `listNodesByKind('Process')`, `listEdgesByType('PROCESS_STEP')` |
| `mcp/tools/dependencies.ts:94` | `SELECT FROM nodes WHERE kind='Dependency'` | `IGraphStore` | `listDependencies()` |
| `mcp/tools/list-findings.ts:103` | `SELECT FROM nodes WHERE kind='Finding'` | `IGraphStore` | `listFindings()` |
| `mcp/tools/route-map.ts:150` | type pin | `IGraphStore` | `listRoutes` |
| `mcp/tools/pack-codebase.ts:257-265` | dynamic import of `DuckDbStore` | factory | `openStore(...)` |
| `mcp/tools/remove-dead-code.ts:32,256` | type-pinned IGraphStore but with raw SQL | `IGraphStore` | `listNodesByKind({deadness})` |
| `mcp/connection-pool.ts:22,26,43,45,48,91` | `DuckDbStore` pool | factory | `openStore(...)` |
| `mcp/repo-uri-for-entry.ts:20,30,32` | `SELECT repo_uri FROM nodes WHERE id = ?` | `IGraphStore` | `getRepoNode(id)` |
| `mcp/resources/repo-cluster.ts:15,134` | type pin | `IGraphStore` | `listNodesByKind('Repo')` |
| `mcp/resources/repo-process.ts:20,158,226` | type pin + 2 reads | `IGraphStore` | `listNodesByKind('Process')` |
| `mcp/resources/store-helper.ts:13,36` | type pin | `IGraphStore` | none |
| `mcp/tools/shared.ts:15,141,162` | factory pin | factory | `openStore` returning `Store` |

### 5.3 pack/ (4 sites — graph-bound)

| File:line | Pattern | Target | Finder |
|---|---|---|---|
| `pack/xrefs.ts:53` | `SELECT FROM relations WHERE type='CALLS'` | `IGraphStore` | `listEdgesByType('CALLS')` |
| `pack/skeleton.ts:97` | similar | `IGraphStore` | `listEdgesByType('CALLS')` |
| `pack/findings.ts:65` | `SELECT FROM nodes WHERE kind='Finding'` | `IGraphStore` | `listFindings()` |
| `pack/embeddings-sidecar.ts:77-113` | duck-typed `exportEmbeddingsParquet` probe | new shape | `store.graph.listEmbeddings()` + DuckDB writer in pack |

### 5.4 wiki/ (12 sites — mixed)

| File:line | Pattern | Target | Finder |
|---|---|---|---|
| `wiki/wiki-render/shared.ts:142` | `SELECT FROM nodes WHERE kind='File' ORDER BY file_path` | `IGraphStore` | `listNodesByKind('File')` |
| `wiki/wiki-render/shared.ts:172` | `SELECT FROM nodes WHERE kind='Process'` | `IGraphStore` | `listNodesByKind('Process')` |
| `wiki/wiki-render/shared.ts:205` | `SELECT FROM nodes WHERE kind='Community'` | `IGraphStore` | `listNodesByKind('Community')` |
| `wiki/wiki-render/shared.ts:233` | `SELECT FROM nodes WHERE kind='Contributor'` | `IGraphStore` | `listNodesByKind('Contributor')` |
| `wiki/wiki-render/shared.ts:258` | `SELECT FROM nodes WHERE kind='Dependency'` | `IGraphStore` | `listDependencies()` |
| `wiki/wiki-render/shared.ts:281` | `SELECT FROM nodes WHERE kind='Route'` | `IGraphStore` | `listRoutes()` |
| `wiki/wiki-render/shared.ts:304` | `SELECT FROM nodes WHERE kind='ProjectProfile'` | `IGraphStore` | `listNodesByKind('ProjectProfile')` |
| `wiki/wiki-render/shared.ts:330` | `SELECT FROM relations WHERE type='OWNED_BY'` | `IGraphStore` | `listEdgesByType('OWNED_BY')` |
| `wiki/wiki-render/shared.ts:354` | `SELECT FROM nodes WHERE kind='Finding'` | `IGraphStore` | `listFindings()` |
| `wiki/wiki-render/shared.ts:375` | similar | `IGraphStore` | varies |
| `wiki/wiki-render/ownership-map.ts:98` | `SELECT FROM relations WHERE type='OWNED_BY'` | `IGraphStore` | `listEdgesByType('OWNED_BY')` |
| `wiki/index.ts:252` | `SELECT FROM relations` | `IGraphStore` | `listEdgesByType` |

### 5.5 cli/ (17+ raw-SQL sites — mostly graph-bound; ~3 temporal)

CLI sites are a mix of type pins (handled by AC-A-5) and raw SQL.
The raw SQL sites largely overlap with what the MCP tools call —
`cli/commands/query.ts:312` does cochange lookup (temporal), `analyze.ts:466,595,628,660` does `listNodes` for orchestrator outputs (graph). Per `explore-storage.yaml:cli` block (`:88-99`), the breakdown:

- Type-pin only: 8 files (open-store, augment, scan, ingest-sarif, group, query, doctor, list, skills-gen, code-pack) — handled by AC-A-5.
- Raw SQL through `query()`: ~17 sites total per `explore-storage.yaml:outside_storage_leaks` — distributed across analyze.ts, augment.ts, ingest-sarif.ts, code-pack.ts.
  - Most call `listNodes` / `listNodesByKind` / `listEdges` (graph-bound).
  - 2-3 call cochange queries (temporal-bound).

Per-site mapping not enumerated here because it tracks identical patterns to mcp/. The 6d sub-commit of AC-A-6 covers cli/.

### 5.6 Summary

**Net new finders** required to cover all 108 sites:

```ts
listNodes(opts: ListNodesOptions)               // existing
listNodesByKind<K>(kind, opts?)                 // new
listNodesByName(name, opts?)                    // new
listEdges(opts: ListEdgesOptions)               // new (replaces parity rebuilder SQL)
listEdgesByType(type, opts?)                    // new
listFindings(opts?)                             // new
listDependencies(opts?)                         // new
listRoutes(opts?)                               // new
getRepoNode(id)                                 // new
countNodesByKind(kinds?)                        // new
countEdgesByType(types?)                        // new
listConsumerProducerEdges(opts?)                // new
traverseAncestors(opts)                         // new (replaces WITH RECURSIVE)
traverseDescendants(opts)                       // new
listEmbeddings(opts?)                           // new (powers sidecar)
```

15 new finders (some are specializations of `listNodes` and could be
collapsed via opts variants, but spelling them out as named methods
makes call sites self-documenting and avoids the
"options-bag-of-mystery" anti-pattern). This honors **interface
segregation balanced against KISS**: each finder is a recognizable
concept in OCH's domain (Findings, Dependencies, Routes — Repo nodes
have always been first-class). It does NOT add per-caller methods
(no `listFindingsForVerdict` etc.).

`ListNodesOptions` extension (one shared options shape):

```ts
export interface ListNodesOptions {
  readonly kinds?: readonly NodeKind[];
  readonly ids?: readonly string[];                 // new: id-set filter
  readonly entryPointId?: string;                   // new: covers impact.ts:131-135
  readonly filePath?: string;                       // new: covers detect-changes.ts patterns
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListNodesByKindOptions extends Omit<ListNodesOptions, "kinds"> {
  readonly deadness?: "any" | "none" | DeadnessTag;  // new: covers dead-code.ts
  readonly nameLike?: string;                        // new: covers rename.ts ad-hoc patterns
}

export interface ListEdgesOptions {
  readonly types?: readonly RelationType[];
  readonly fromIds?: readonly string[];
  readonly toIds?: readonly string[];
  readonly fromId?: string;
  readonly toId?: string;
  readonly confidenceFloor?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AncestorTraversalOptions {
  readonly startId: string;
  readonly maxDepth: number;
  readonly relationTypes?: readonly RelationType[];
  readonly confidenceFloor?: number;
}
```

---

## 6. Conformance test contract

A third-party adapter (community AGE / Memgraph / Neo4j adapter) declares
v1.0 conformance by implementing `IGraphStore` and passing the conformance
suite. The contract is small and absolute.

### 6.1 What a third-party adapter implements

| # | Method | Required | Notes |
|---|---|---|---|
| 1 | `open()`, `close()`, `createSchema()`, `healthCheck()` | yes | lifecycle |
| 2 | `bulkLoad(graph, opts)` | yes | replace + upsert modes |
| 3 | `upsertEmbeddings`, `listEmbeddingHashes`, `listEmbeddings` | yes when adapter declares vector capability | optional only if adapter explicitly declares no-vector |
| 4 | All read finders in §4.1 | yes | the finder set is closed; no per-caller methods |
| 5 | `search`, `vectorSearch`, `traverse{,Ancestors,Descendants}` | yes | search optional only if adapter declares no-FTS |
| 6 | `getMeta`, `setMeta` | yes | for store_meta |
| 7 | `execCypher?` | optional | escape hatch |
| 8 | NO `bulkLoadCochanges`, `lookupSymbolSummary`, `exec(sql)` | required NOT to expose | type-enforced |

### 6.2 How a third-party adapter proves parity

```ts
// In the third-party adapter's test file
import { assertIGraphStoreConformance } from "@opencodehub/storage/test-utils";

assertIGraphStoreConformance("AgeStore", async () => {
  const conn = await createPgConnectionForTesting();
  const store = new AgeStore(conn, { graphName: "och_test" });
  await store.open();
  await store.createSchema();
  return store;
});
```

The conformance suite runs:

1. **Graph parity** — `assertGraphParity(fixture, {stores: [duckGraphStore, adapterStore]})` over the small + medium + large + repo + repo-null fixtures. `graphHash` must be byte-identical across all backends.
2. **Finder consistency** — `listEdgesByType('CALLS')` must equal `listEdges({types:['CALLS']})` must equal `listEdges().filter(e => e.type === 'CALLS')`. (Three implementations of the same predicate; all must agree.)
3. **Traversal invariants** — `traverseAncestors({startId: x, maxDepth: 3})` must terminate with depth ≤ 3 and every result's `path` must end at `x`.
4. **Embedding round-trip** — `upsertEmbeddings(rows); listEmbeddings()` must return rows byte-identical to the input.
5. **Health on empty** — `healthCheck()` returns `{ok:true}` on a freshly-opened empty store.
6. **Unsupported features fail loudly** — if the adapter declares no-vector, `vectorSearch()` throws `UnsupportedFeatureError` (it does not silently return empty).

### 6.3 The minimum test interface

A third-party adapter's package needs exactly two things:

```ts
// 1. Implement IGraphStore
class FooStore implements IGraphStore { /* ... */ }

// 2. Run the conformance suite
import { assertIGraphStoreConformance } from "@opencodehub/storage/test-utils";
assertIGraphStoreConformance("FooStore", () => Promise.resolve(new FooStore(...)));
```

That's it. No editing of `graph-hash-parity.test.ts`. No copying of
rebuilder helpers. No knowledge of step-zero / languageStats sentinels
(those live in `column-encode.ts` and the harness applies them
internally).

---

## 7. Risks introduced by the split + mitigations

### 7.1 Two stores per repo means two file artifacts

**Risk:** `.codehub/graph.lbug` + `.codehub/temporal.duckdb` is a
two-file deployment. Users may delete one and not the other; backup
scripts must capture both; `codehub status` must check both.

**Mitigation:**

- AC-A-8's `describeArtifacts(backend)` enumerates both. Every CLI
  command uses it.
- `codehubIsIndexed(repoPath)` checks ALL artifacts and returns a
  status object: `{graph: true, temporal: false}`.
- `codehub doctor` extends to probe both.
- Document the two-file layout in ADR 0013 + `packages/storage/README.md`.

### 7.2 Cochange queries lose graph context

**Risk:** today's DuckDB has cochanges in the same database as graph
nodes, so a query that joins `cochanges.source_file` to
`nodes.file_path` works. Splitting to two stores means cross-store
joins go through TS code (load file paths from graph, ask temporal
for cochanges).

**Mitigation:**

- The use case is rare. `lookupCochangesForFile(file)` is keyed by
  string file path, not by node id. The cochange surface is
  intentionally NOT in the graph; this was always the design (per
  `interface.ts:122-127` "never promote it into the deterministic
  graph").
- TS-side join is O(N file paths) — not a perf concern at OCH scale.
- The one site that genuinely joins cochanges to graph nodes is in
  `mcp/tools/context.ts`; rewrite as `graph.listNodesByKind('File').then(files => temporal.lookupCochangesForFile(...))`.

### 7.3 Embedding sidecar emission depends on which temporal backend is present

**Risk:** if a community adapter ships `IGraphStore` but no temporal
sidecar (e.g. someone runs OCH purely on Memgraph with no DuckDB),
the Parquet-via-DuckDB path is unavailable.

**Mitigation:**

- v1.0 ships only `lbug` and `duck` backends; both pair with DuckDB
  temporal. The risk is hypothetical for v1.0.
- ADR 0013 documents that community adapters that ship without a
  temporal store stamp `determinism_class: degraded` on pack output.
- The `pack/embeddings-sidecar.ts` path uses
  `@dsnp/parquetjs` as a deterministic fallback when DuckDB is
  absent. (Per the existing exploration note at AC-A-4 step 3.)

### 7.4 Graph-only community backends can't satisfy `codehub query --sql`

**Risk:** `codehub query --sql 'SELECT ...'` is the temporal-analytics
escape hatch (S-A-3). On a Memgraph-only deployment, the temporal
store is still DuckDB, so this works. But the user's mental model
might be "I switched to Memgraph, why is there still DuckDB?".

**Mitigation:**

- ADR 0013 names the contract: graph backend is replaceable; temporal
  store stays DuckDB until a community SQLite/Parquet temporal
  adapter ships. Both files are deletable independently.
- The `codehub doctor` output makes this explicit: "graph backend:
  memgraph (remote), temporal backend: duck (local file)".

### 7.5 The split changes 41 type pins to two patterns

**Risk:** under current AC-A-5, every site goes from `DuckDbStore` to
`IGraphStore`. Under the split, sites go to `IGraphStore` (most) or
`Store` (cases needing both). Sub-decision per site.

**Mitigation:**

- Default to `IGraphStore`. The exceptions (callers needing temporal
  too) are 2-3 files — `cli/commands/query.ts` (`--sql` mode),
  `cli/commands/analyze.ts` (writes both), `pack/code-pack.ts`
  (reads both for embeddings sidecar + cochange-aware xrefs).
- `mcp/tools/shared.ts:executeToolWithStore` already factories the
  store; widen its type from `DuckDbStore` to `Store` (returns both)
  and tools take only what they need.

### 7.6 `traverseAncestors` / `traverseDescendants` are LCD-pinned to the lowest common denominator

**Risk:** DuckDB's WITH RECURSIVE is fast; Cypher's variable-length
match is fast on LadybugDB but O(N×depth) on AGE without
optimization; Neo4j is fast. The `traverseAncestors` semantics must
work on all four.

**Mitigation:**

- The signature is `{startId, maxDepth, relationTypes, confidenceFloor}`
  — purely declarative.
- Each adapter chooses its native execution: DuckDB emits
  `WITH RECURSIVE`, LadybugDB emits `MATCH p=(...)<-[:T*1..N]-(...)`,
  AGE emits CTE-wrapped Cypher.
- `engineCapabilities()` (deferred to ADR 0013 community-adapter
  surface, not in v1.0 core) lets a slow adapter declare
  `traversalCostHint: "linear-per-step"` so callers can adjust depth
  defaults.

### 7.7 `risk-snapshot.ts:172` is the one ambiguous site

Already discussed in §5.1. Resolution: keep on `IGraphStore.listFindings({severity})`.

### 7.8 Conformance suite weight

**Risk:** the conformance suite at AC-A-11 adds CI cost. Running every
fixture (small, medium, large, repo, repo-null) on N adapters
multiplies test time.

**Mitigation:**

- `hasGraphDbBinding()` style skip already exists. CI runs the full
  matrix; dev machines without the binding skip cleanly.
- The large fixture (≥500 nodes) already runs on both adapters today.
  Adding a third adapter is +1× time, not exponential.
- Adapters opt out of optional features (vector, FTS) with a single
  flag; conformance test honors it.

---

## 8. Diff vs current spec — what changes, stays, is added

### 8.1 ACs that change scope

| AC | Change | Why |
|---|---|---|
| AC-A-1 | Drops dialect marker; splits interface | Type system enforces dialect; no marker needed |
| AC-A-3 | Deletes cochange/summary from `GraphDbStore` (vs. implementing them) | Anchor: graph backend is graph-only |
| AC-A-4 | Moves sidecar to `pack/`; adds `listEmbeddings()` | Anchor: sidecar is temporal artifact, not graph method |
| AC-A-6 | Migrates all 108 sites (vs. 4 today) | User explicit: full scope |
| AC-A-7 | Public-interface rebuilder (vs. raw-dialect rebuilders) | Liskov: harness uses only public methods |

### 8.2 ACs that grow scope

| AC | Addition |
|---|---|
| AC-A-2 | Promotes parity-test sentinel rules to `column-encode.ts` |
| AC-A-5 | Refines: type pins go to `IGraphStore` OR `Store` per site |
| AC-A-8 | `describeArtifacts` returns `{graphFile, temporalFile}` for two-file deployments |

### 8.3 ACs that are NEW

| AC | Purpose |
|---|---|
| AC-A-11 | Conformance test suite — `assertIGraphStoreConformance(name, factory)` for community adapters |

### 8.4 ACs that stay unchanged

- AC-A-9 (default flip) — same trigger, same artifact
- AC-A-10 (parity audit on testbed) — same shape

### 8.5 Open Questions affected

| Q | Current SPEC ASSUMES | Revised assumption |
|---|---|---|
| Q2 | Migrate 4 of 108; defer rest to follow-on | Migrate ALL 108 in Track A (PR-split critic confirms this is the right call) |
| Q3 | Rename `query` → `rawQuery` with `dialect` marker | Drop the rename entirely; method moves to `ITemporalStore.exec` |
| Q7 | 2 ADRs (0013 + 0014) | 2 ADRs unchanged; 0013 grows to document `IGraphStore`/`ITemporalStore` split |

### 8.6 Hard rails preserved

| Rail | Status under revised design |
|---|---|
| U1 — graphHash byte-identity | Tightened: parity harness uses public methods only; conformance suite extends parity to N adapters |
| U2 — pack_hash byte-identity | Preserved: sidecar emission still deterministic via DuckDB COPY or `@dsnp/parquetjs` |
| U3 — Stdio-only | Preserved: openStore returns local handles, no HTTP |
| U4 — No LLM in query path | Preserved: `IGraphStore` finders are pure graph reads |
| U5 — Capability declaration | Strengthened: optional `execCypher?` is the formal capability marker; no duck-typing |
| U6 — `mise run check` exit 0 | Preserved across every commit |
| U7 — Skills not CLI features | Preserved |

### 8.7 Migration sequence inside Track A

Ordered for graphHash invariance per-commit:

1. AC-A-2 — hoist column encoders + sentinels (pure refactor, hash-neutral).
2. AC-A-1 — split interface (type-only, hash-neutral).
3. AC-A-3 — delete cochange/summary from `GraphDbStore` + `ITemporalStore`-backed routing (graph hash unchanged because cochanges never participated in graphHash).
4. AC-A-7 — rewrite parity harness (refactor, parity test still green).
5. AC-A-11 — add conformance suite (new tests, not new code paths).
6. AC-A-6a..d — migrate 108 sites in 4 sub-commits (each commit graphHash-neutral; CI parity gate runs per-commit).
7. AC-A-4 — move sidecar to pack/ (changes pack output format only if adapters disagree; both should produce identical Parquet by U2).
8. AC-A-5 — replace type pins (type-only, hash-neutral).
9. AC-A-8 — `describeArtifacts` (path-only, hash-neutral).
10. AC-A-9 — flip default (the moment when parity must hold end-to-end on the default code path).
11. AC-A-10 — testbed parity audit.

---

## 9. Closing — what the user gets

Under the revised design:

- **One sentence describes the storage layer:** "Graph operations on
  `IGraphStore`; temporal operations on `ITemporalStore`; both opened
  by `openStore()`."
- **Adding a community adapter is one file:** implement `IGraphStore`,
  call `assertIGraphStoreConformance` in your test. You inherit DuckDB
  for temporal; you don't have to invent it.
- **The 108 raw-SQL sites collapse into 15 named finders.** Each finder
  is a recognizable OCH domain concept. Call sites self-document.
- **`graphHash` parity is provable, not asserted by hand.** The parity
  harness uses only public methods, so any adapter that types-checks
  against `IGraphStore` and passes the harness has byte-identical
  output.
- **The temporal escape hatch survives unmoved.** `codehub query --sql`
  routes to `store.temporal.exec()`. SQL-backed analytics work;
  graph-backed analytics work; neither leaks into the other.

The cost is two-store composition at the call site (~2-3 files take
`Store`, the rest take `IGraphStore`). That cost is one-time and
well-localized. The benefit is a stack that the user can hand to a
community contributor with one document and a conformance test.

---

## References

- `.erpaval/specs/006-v1-finalize/spec.md` — current Track A scope
- `.erpaval/sessions/session-33f24f/explore-storage.yaml` — leak audit
- `.erpaval/sessions/session-33f24f/research-graphdb-backends.yaml` — community-backend union surface
- `.erpaval/sessions/session-33f24f/pr-split-analysis.md` §5 + §6 — 108-SQL critique + commit-level discipline
- `packages/storage/src/interface.ts` — current contract
- `packages/storage/src/duckdb-adapter.ts:72-200, 465-496, 911-958, 1010-1014, 1232-1253` — DuckDB shape
- `packages/storage/src/graphdb-adapter.ts:24-92, 226-260, 537-552, 717-792, 881-916, 929-980` — LadybugDB shape
- `packages/storage/src/graph-hash-parity.test.ts:1-100, 377-475, 516-550` — parity invariants
- `packages/core-types/src/{nodes.ts,edges.ts,graph.ts,hash.ts,graph-hash.ts}` — L1 canonical shape
- `.erpaval/INDEX.md` — `storage-list-nodes-over-scattered-sql`, `lift-pure-functions-to-shared-dep-to-break-cycles`, `scip-monorepo-dist-src-alias` (durable lessons informing this design)
