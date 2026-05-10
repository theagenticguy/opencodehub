# ADR 0013 — M7 default-flip + storage abstraction (LadybugDB phase-2)

> Note: there is a sibling ADR — `0013-parse-runtime-wasm-default.md` —
> that landed concurrently and shares the same number. Both are kept
> in-tree because they were authored in parallel branches and accepted
> on the same release. The next ADR uses 0014.

- Status: **Accepted** — 2026-05-09 (Proposed) → flipped on the
  `feat/v1-finalize-track-a` merge (PR #71).
- Authors: Laith Al-Saadoon + Claude.
- Branch: `feat/v1-finalize-track-a`.
- Supersedes nothing. Extends ADR 0011 (LadybugDB phase-1) by flipping
  the default backend selector and introducing the `IGraphStore /
  ITemporalStore` interface segregation. Extends ADR 0012 (Repo as a
  first-class graph node) by routing the M6 federation surface through
  the new typed finders rather than backend-specific raw SQL.

## Context

ADR 0011 added `@ladybugdb/core` as the opt-in graph-database backend
behind the `IGraphStore` interface, deliberately holding the default at
DuckDB through M3 – M6. Three milestones of parallel-work traffic
later, four facts forced the M7 architectural shift.

1. **DuckDB's recursive-CTE traversals do not get faster.** The shape
   limit identified in ADR 0011 §Context (one polymorphic `relations`
   table, `WHERE type = ?` evaluated after the join, no per-kind
   columnar pushdown) holds across every workload we measured in M4 –
   M6. The 24-edge-kind cardinality is now 28 with M5/M6 additions
   (`HAS_FILE`, `HAS_DEPENDENCY`, `IN_GROUP`, `OWNED_BY` repo-level
   edges). DuckDB is the right engine for time-series / cochange
   queries — its column-store strengths land squarely in the temporal
   domain — but the graph workload is a different shape and benefits
   from a graph-native engine.
2. **The `IGraphStore` interface had grown two non-graph
   responsibilities.** By the end of M6 it carried `cochanges` and
   `symbol-summaries` queries — both temporal, neither graph. Every
   community adapter author would have had to implement those two
   surfaces against their own engine, even though `Cochange` /
   `SymbolSummary` are statistical (git-history) signals that never
   enter `graphHash` (the round-trip invariant `interface.ts:122-127`
   already documented). Splitting the interface keeps the conformance
   bar honest.
3. **108 raw-SQL call sites were scattered across the consumer
   packages.** `analysis/` had 27 sites. `mcp/` had 46. `pack/` and
   `wiki/` had 15 between them. `cli/` had 20. Every site hard-coded
   the DuckDB dialect via `store.query("SELECT ... FROM nodes WHERE
   ...")`. The graph-DB backend (ADR 0011) ran the same workload
   through a Cypher-emitting dialect adapter, but the consumer-side
   shape leaked the DuckDB SQL into every tool and prevented community
   adapters (AGE / Memgraph / Neo4j / Neptune) from substituting in.
4. **The `graphHash` parity gate caught every shape regression but
   could not catch a contract regression.** ADR 0011 §graphHash
   invariant pins the byte-identity of the in-memory `KnowledgeGraph`
   across the two backends. That gate cannot tell us, however, whether
   `listEdgesByType("CALLS")` returns the same rows as
   `listEdges().filter(e => e.type === "CALLS")` — the rebuilder uses
   only `listNodes()` + `listEdges()`, so the typed finders had no
   second-source equivalence test. Track A adds a public-interface
   parity harness AND a community-adapter conformance suite to fill
   that gap.

The clean fix is the M7 architectural shift: split the interface, hoist
the column encoders, migrate every raw-SQL site to typed finders,
publish a parity harness + conformance suite for community adapters,
and flip the default backend to `lbug` when `@ladybugdb/core` is
importable.

## Decision

Adopt LadybugDB as the default graph backend, with DuckDB retained as
the legacy graph store + the canonical temporal store. The default
selector is the new `"auto"` mode:

- `CODEHUB_STORE` unset and `@ladybugdb/core` importable →
  `GraphDbStore` over `<dir>/graph.lbug`; `DuckDbStore` over
  `<dir>/temporal.duckdb`.
- `CODEHUB_STORE` unset and `@ladybugdb/core` NOT importable →
  `DuckDbStore` over `<dir>/graph.duckdb` (BOTH views; one connection).
  A one-shot stderr advisory fires under TTY / `OCH_VERBOSE=1`.
- `CODEHUB_STORE=duck` explicitly → DuckDB-only (legacy default).
- `CODEHUB_STORE=lbug` explicitly → LadybugDB; if the binding is
  missing, `GraphDbStore.open()` surfaces a `GraphDbBindingError` at
  the lifecycle boundary (ADR 0011 risk #1).

The probe is a cached `Promise<boolean>` at module scope in
`packages/storage/src/index.ts`. The first invocation runs
`import("@ladybugdb/core")`; subsequent invocations return the cached
promise. The probe never blocks synchronously and never re-runs.

## Architecture — graph / temporal interface segregation

Track A landed three structural changes that this ADR records.

### Split `IGraphStore` into graph-only + `ITemporalStore`

`packages/storage/src/interface.ts` now exports two interfaces:

- `IGraphStore` — graph-only. Lifecycle, schema, bulk write, vector
  search, embedding management, 13 typed finders (see §Typed finders
  below) plus 2 specialized (xrefs, skeleton). NEVER carries
  cochanges, symbol summaries, or temporal-table queries.
- `ITemporalStore` — temporal-only. Cochange + symbol-summary upserts
  and reads. Backed by DuckDB regardless of which graph backend is
  selected.

The composed `Store` envelope (`OpenStoreResult`) carries both views.
For the `duck` backend a single `DuckDbStore` instance satisfies both
interfaces structurally and is returned twice (one connection serves
both). For the `lbug` backend a `GraphDbStore` backs `graph` and a
sibling `DuckDbStore` backs `temporal`.

### Hoisted column encoders + sentinel coercions

`packages/storage/src/column-encode.ts` carries the per-column
serialization rules previously duplicated in
`duckdb-adapter.ts:bulkLoad` and `graphdb-adapter.ts:bulkLoad`. The
hoist resolves the `step: 0` vs `step: null` parity asymmetry (ADR
0011 §graphHash invariant captured the workaround; the shared encoder
prevents the two adapters from drifting).

### Public-interface parity harness + community-adapter conformance suite

`packages/storage/src/test-utils/parity-harness.ts` exports
`rebuildFromStore(graph: IGraphStore): Promise<KnowledgeGraph>` and
`assertGraphParity(fixture, {stores: IGraphStore[]})`. The rebuilder
uses ONLY `listNodes()` + `listEdges()` — no SQL, no Cypher, no
adapter-specific surface. A community adapter that satisfies
`IGraphStore` and passes `assertGraphParity` claims conformance.

`packages/storage/src/test-utils/conformance.ts` exports
`assertIGraphStoreConformance(name, factory)`. The suite asserts the
13 typed finders return well-typed results, `listEdgesByType` is
byte-equivalent to `listEdges().filter`, `traverse` hits the
`(target, depth, path)` invariants, `vectorSearch` is ordered, and
`healthCheck` returns `{ok: true}` after `open() + createSchema()`.
Both DuckDB and LadybugDB adapters opt in by importing the suite in
their respective test files.

## 13 typed finders + 2 specialized — the service-layer foundation

`IGraphStore` exposes these read methods (listed by primary caller):

| Method | Primary callers |
|---|---|
| `listNodes(opts?)` | `parity-harness`, generic listing |
| `listNodesByKind(kind, opts?)` | xrefs, skeleton, list-findings, dependencies, wiki |
| `listNodesByName(name, opts?)` | rename, query, context |
| `listNodesByEntryPoint(opts?)` | route-map |
| `listEdges(opts?)` | parity rebuilder, xrefs, skeleton |
| `listEdgesByType(type, opts?)` | pack/xrefs, pack/skeleton, group-contracts |
| `listEdgesIncidentTo(nodeId, opts?)` | context, impact |
| `listFindings(opts?)` | analysis/verdict, mcp/list-findings, pack/findings, wiki |
| `listEmbeddings(opts?)` | pack/embeddings-sidecar |
| `listEmbeddingHashes()` | dedupe + analyze incremental gate |
| `listDependencies(opts?)` | dependencies tool |
| `listRoutes(opts?)` | route-map |
| `traverse(query)` | impact, context |

The 2 specialized finders are `loadXrefs(opts)` and
`loadSkeleton(opts)` — both compose multiple typed finders behind a
single call to keep the pack layer's I/O contract narrow.

## 108-site SQL migration

The migration landed in four sub-commits, sequenced sequentially to
keep each commit reviewable:

| Package | Sites |
|---|---|
| `analysis/` | 27 |
| `mcp/` | 46 |
| `pack/` + `wiki/` | 15 |
| `cli/` | 20 |

Total: **108 raw-SQL call sites** replaced with typed-finder calls.
Every migrated tool runs end-to-end on BOTH DuckDb and LadybugDB
backends (the parity harness is wired into every consumer test).
`packages/analysis/src/test-utils.ts` was rewritten from a
DuckDB-dialect regex fake into a typed `IGraphStore` fake that
implements the finder surface, unblocking the rest of the
consumer-side migration.

## Dual-artifact detection

The factory at `packages/storage/src/index.ts:openStore` runs a
post-resolution check via `detectDualArtifacts(graphFile, temporalFile,
backend)`. When both `graph.duckdb` AND `graph.lbug` exist as siblings
in the same `<dir>/.codehub/`, the helper picks the newer-mtime one
and rewrites the resolved backend. The override fires a one-shot
stderr advisory under TTY / `OCH_VERBOSE=1`. Rationale: during the
M7 transition a user re-analyzes with `CODEHUB_STORE=lbug`, but the
older DuckDB artifact stays on disk; on the next read with
`CODEHUB_STORE` unset, the user expects the data they just wrote, not
the stale legacy file. Newer-mtime is the only deterministic choice.

In-memory paths (`:memory:`) short-circuit. Single-file deployments
(only one of the two artifacts present) skip the check — the
resolution is honored. The check is a pure stat call; no read of
either artifact.

## Community-adapter escape hatch — AGE / Memgraph / Neo4j / Neptune

The `BackendKind` union widens in `packages/storage/src/interface.ts`
to `"duck" | "lbug" | "age" | "memgraph" | "neo4j" | "neptune"`.
In-tree implementations remain `duck` and `lbug`; the four community
identifiers are reserved for out-of-tree adapter packages. The escape
hatch is:

- A community adapter implements `IGraphStore` directly. The
  conformance suite (`packages/storage/src/test-utils/conformance.ts`)
  is the contract: pass it, claim conformance.
- The optional `execCypher?(query, params?, opts?)` hook on
  `IGraphStore` lets adapters with a Cypher-native query path expose
  it for the `sql` MCP tool's `cypher` input mode without leaking
  dialect into the consumer-side typed-finder calls.
- `describeArtifacts(backend)` (`packages/storage/src/paths.ts`)
  derives `<dir>/graph.<backend>` for unknown backends, paired with
  the canonical `<dir>/temporal.duckdb` sibling. The `CodeHub`
  registry, `codehub list` indexed-status probe, and the MCP
  store-unreadable error envelope all enumerate the candidate paths
  via this helper, so a community adapter's on-disk presence is
  surfaceable end-to-end without engine-side changes.

The fallback documented in ADR 0011 §Fallback (Apache AGE on Postgres
18) is now the canonical example of how a community adapter slots in
behind the v1.0 `IGraphStore` seam. An OCH user who wants AGE wires up
an `@opencodehub-community/age` package that implements `IGraphStore`,
exports it, and registers it via the in-tree extension point — no fork
of `@opencodehub/storage` required.

## Rationale for the default flip

- **Performance.** Multi-hop graph traversals (`impact`, `context`)
  benefit from the rel-table-per-kind shape (ADR 0011 §Schema choice).
  M6 measurements showed ~5–8x faster `impact` queries on the same
  fixture between the two backends; the gap widens with edge-kind
  cardinality.
- **Concurrency.** The LadybugDB pool adapter
  (`packages/storage/src/graphdb-pool.ts`, ADR 0011 §Concurrency
  model) gives one `Database` per repo + a pool of `Connection`
  objects, with the one-query-per-Connection invariant enforced by
  the pool. DuckDB's single-connection-per-process posture made the
  MCP tools serialize at the connection level — the graph-DB
  concurrency model is a strict superset.
- **Future-proofing.** Every new graph-side feature in M5 – M6 was
  already written against `IGraphStore` (the M4 – M6 phase plan from
  ADR 0011 enforced this). Flipping the default does not require any
  consumer-side change beyond the `openStore` factory.
- **The legacy path is preserved.** Setting `CODEHUB_STORE=duck`
  retains the old behavior. DuckDB is still the temporal store. No
  data is lost; no re-analyze is required for users who stay on the
  legacy backend.

## Risks

1. **Binding availability gap on first `analyze`.** A user upgrades
   OCH and immediately runs `codehub analyze` without
   `CODEHUB_STORE=duck`. If `@ladybugdb/core` lacks a prebuilt binary
   for their platform, the probe resolves to `false`, the advisory
   fires, and the fallback writes a DuckDB artifact. The next session
   on a platform WITH the binding will then see a stale DuckDB file
   and a fresh attempt to write `graph.lbug` — the dual-artifact
   detection catches this exactly: newer-mtime wins. Mitigation:
   `codehub doctor` (the storage-side probe) surfaces the binding
   status before the user runs analyze.
2. **CI runs producing non-deterministic backends.** A CI matrix
   that pins `node@22` + `linux-x64` will get the binding; a matrix
   that pins `node@24` (currently waiting on
   `node-tree-sitter@0.25.1`, see CLAUDE.md §Parse runtime) might
   not. The fix is to set `CODEHUB_STORE=duck` (or `lbug`) explicitly
   in CI workflows that need byte-deterministic outputs across
   matrix entries. The default-flip is a developer-experience win,
   not a CI-determinism contract.
3. **Stderr advisory pollution.** The advisory fires at most once
   per process and only under TTY / `OCH_VERBOSE=1`. Non-interactive
   CI runs stay quiet. The risk is a misconfigured terminal multiplexer
   that reports `isTTY: true` for a non-interactive shell — those
   users see one extra line per run, no functional impact.
4. **Community adapters drifting from the conformance contract.** The
   conformance suite is opt-in by import in the adapter's test file.
   A community adapter that ships without the suite cannot claim
   conformance; we recommend (but cannot enforce) that adapter authors
   wire the suite into their CI. Mitigation: the v1.0 release notes
   call this out, and the published `@opencodehub/storage`
   typing surface includes the suite re-export so adapter authors do
   not have to discover it.
5. **`describeArtifacts` extending to unknown backends.** The path
   helper now generates `<dir>/graph.<backend>` for any unknown
   backend identifier, paired with the canonical
   `<dir>/temporal.duckdb`. A future in-tree backend that wants a
   non-DuckDB temporal store would have to override this. No such
   backend is on the v1.0 roadmap; the helper's signature can grow
   if needed.

## Status

- **Proposed**: 2026-05-09 (Track A authoring commit).
- **Accepted**: on merge of `feat/v1-finalize-track-a` → `main` (the PR
  that shipped this ADR alongside the rest of Track A's deliverables).
- **Superseded**: not on the v1.0 roadmap. M8+ may add new edge kinds
  or community-backend extension points; those changes get follow-up
  ADRs.

## References

- Code:
  - `packages/storage/src/interface.ts` — `IGraphStore` + `ITemporalStore`
    type definitions; the typed-finder method surface.
  - `packages/storage/src/index.ts` — `openStore` factory,
    `resolveStoreBackendAsync` async resolver,
    `detectDualArtifacts` newer-mtime helper.
  - `packages/storage/src/column-encode.ts` — hoisted per-column
    serialization rules.
  - `packages/storage/src/paths.ts` — `describeArtifacts(backend)`,
    the canonical filename source of truth for two-store deployments.
  - `packages/storage/src/test-utils/parity-harness.ts` —
    public-interface rebuilder + `assertGraphParity`.
  - `packages/storage/src/test-utils/conformance.ts` —
    community-adapter conformance suite.
- Tests:
  - `packages/storage/src/resolver.test.ts` — async resolver +
    dual-artifact detection.
  - `packages/storage/src/graph-hash-parity.test.ts` — graph-hash
    parity gate (continues to enforce ADR 0011's byte-identity
    invariant).
  - `packages/storage/src/temporal-parity.test.ts` — round-trip
    parity for `ITemporalStore` adapters.
  - `packages/storage/src/interface.test.ts` — interface-level
    contract assertions.
  - `packages/storage/src/finders.test.ts` — typed-finder coverage.
- Related ADRs:
  - ADR 0001 — DuckDB selection. This ADR keeps DuckDB as the
    temporal store and the legacy graph store; no rip-out.
  - ADR 0011 — LadybugDB phase-1. This ADR is its M7 follow-up.
  - ADR 0012 — Repo as a first-class graph node. The M6 federation
    surface routes through the new typed finders via this ADR's
    108-site SQL migration.

## Provenance

The interface-segregation pattern (graph-only `IGraphStore` plus
temporal-only `ITemporalStore`) follows the SOLID dependency-inversion
shape from `Clean Architecture` (Robert C. Martin, 2017): the
high-level consumer code depends on the abstraction, not on the
concrete adapter, and the abstraction is owned by the consumer side.
The 13-finder service-layer surface is OCH-original — the choice of
which queries to typify came from the 108-site usage census in
`architecture-revised.md` §3, not from a generic graph-DB API.

The dual-artifact newer-mtime rule has no direct precedent we found;
it is a pragmatic response to the M3 – M7 transition window where
both files coexist on user disks. The same shape recurs in build-tool
caches (Bazel's `bazel-out`, Cargo's `target/`), but those tools use
a checksum-based invalidation; the OCH default-flip cannot rely on
checksums because the two artifacts are written by different engines
and have different on-disk representations. mtime is the only stable
signal.

## Empirical evidence — graphHash parity audit

The whole-pipeline parity gate is `scripts/m7-parity-audit.sh`. It runs
`codehub analyze --force` against the same corpus under
`CODEHUB_STORE=duck` and `CODEHUB_STORE=lbug`, then compares the
`graph <hash>` summary line emitted by each invocation. This is the
end-to-end companion to the in-memory `assertGraphParity` harness;
together they pin graphHash byte-identity from both layers — fixtures
and a real on-disk analyze.

The script is wired into `scripts/acceptance.sh` as gate 17 (the final
gate). Sample outputs follow.

**Dev box without the @ladybugdb/core binding (skip-clean, exit 0)**:

```text
$ bash scripts/m7-parity-audit.sh
[m7-parity-audit][skip] @ladybugdb/core unavailable on this host; lbug leg skipped
$ echo $?
0
```

The acceptance harness translates the `[skip]` line into a `[SKIP]`
gate marker; the run continues without touching the exit code.

**Testbed environment with the binding installed (pass, exit 0)**:

```text
$ bash scripts/m7-parity-audit.sh
[m7-parity-audit][pass] graphHash byte-identical across duck + lbug: 4f9c2a73
$ echo $?
0
```

**Regression posture (fail, exit 1)**:

When the two backends disagree, the script retains the temp directory
and emits the divergence loudly. That output is what gate 17 escalates
into a hard `[FAIL]`:

```text
[m7-parity-audit][FAIL] graphHash divergence — U1 invariant breach:
  duck: 4f9c2a73
  lbug: 8e1d3b09
  artifacts retained at: /tmp/och-m7-audit-XXXXXX
```

The retained artifacts (two `.codehub/` trees, two analyze logs) are
the forensic surface for diagnosing whether the divergence comes from
column encoding, sentinel coercion, edge ordering, or a typed-finder
asymmetry. The expected workflow is to feed those two trees into
`packages/storage/src/test-utils/parity-harness.ts:assertGraphParity`
to localize the divergence to a specific node or edge before fixing
the adapter.
