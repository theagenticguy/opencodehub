# ADR 0011 — Graph-DB backend (LadybugDB phase-1)

- Status: **Proposed** — 2026-05-05 (flips to **Accepted** on the M3 merge).
- Authors: Laith Al-Saadoon + Claude.
- Branch: `feat/v1-m3-m4`.
- Supersedes nothing. Interacts with ADR 0001 (DuckDB backend stays the
  default through M6; this ADR records the opt-in second backend and the
  phased plan to flip the default in M7).

## Context

OpenCodeHub's storage layer was chosen in ADR 0001 with a relational shape:
DuckDB + the `hnsw_acorn` vector index + `fts` BM25 + recursive CTEs over
a single polymorphic `relations` table keyed by a `type` discriminator
column. That shape has held up for the first two milestones, but the M3
workload surfaces two specific strains the column-store cannot relieve by
configuration alone.

1. **Recursive-CTE traversals are slow on deep call graphs.** Multi-hop
   `impact` and `context` queries land on the `relations(from_id, to_id,
   type, …)` table and fan out via `WITH RECURSIVE … USING KEY`. DuckDB's
   `USING KEY` implementation is the right algorithm for this shape, but
   every hop pays the cost of a `WHERE type = ?` predicate against a table
   that stores all 24 edge kinds intermixed. The planner has no columnar
   pushdown to narrow the probe to the one kind we care about — the filter
   is evaluated after the join, not before.
2. **The polymorphic `type` column defeats columnar predicate pushdown.**
   A single rel table with a `type` discriminator was the right shape when
   OCH tracked ~10 edge kinds. The M2 additions (`FOUND_IN`, `DEPENDS_ON`,
   `OWNED_BY`, `WRAPS`, `QUERIES`, `REFERENCES`, `ACCESSES`) pushed the
   count to the **24 kinds** currently declared in
   `packages/storage/src/graphdb-schema.ts`. At that cardinality each query
   scans a fraction of rows it never uses, and the planner cannot prune
   what it cannot see.

The clean fix is a graph-native store that speaks Cypher, supports
multiple named relationship tables, and keeps each edge kind in its own
physical layout so the planner prunes at the table level, not the row
level. The M3 scope adds that backend behind the existing `IGraphStore`
seam as an opt-in surface. Flipping the default is explicitly out of M3.

## Decision

Add a graph-database backend bound to `@ladybugdb/core` (the community
LadybugDB project — the successor to the pre-1.0 Kuzu codebase after
Kuzu's Apple acquisition; see §Provenance at the end of this ADR)
behind the `IGraphStore` interface at
`packages/storage/src/interface.ts`. The store is selected at runtime by
the environment variable `CODEHUB_STORE`:

- `CODEHUB_STORE` unset or `=duck` → `DuckDbStore` (existing default).
- `CODEHUB_STORE=lbug` → `GraphDbStore` (the new backend).

`lbug` is the short token the CLI accepts; source-level naming never uses
it as a symbol. The class name is `GraphDbStore`, file names are
`graphdb-adapter.ts` / `graphdb-schema.ts` / `graphdb-pool.ts`, and the
per-kind rel table for the OCH-native `PROCESS_STEP` edge is named
`ProcessStep` in the Cypher schema. The `@ladybugdb/core` npm dependency
is the one allowed surface for the product name in tracked source, and
it is already permitted in `scripts/check-banned-strings.sh` via the
per-literal allowlist (`@ladybugdb[/A-Za-z0-9_-]*`).

The phased plan, sequenced by milestone dependency per the v1.0 roadmap:

- **M3** (this milestone): opt-in `CODEHUB_STORE=lbug` ships. DuckDB
  stays the default. A byte-identity graphHash parity gate runs on every
  CI build so the two backends cannot drift silently.
- **M4 – M6**: both stores stay green. Every new feature that touches
  storage writes against `IGraphStore`, not `DuckDbStore` or
  `GraphDbStore` directly.
- **M7**: flip the default to `CODEHUB_STORE=lbug` (task T-M7-1). Retain
  DuckDB as the legacy backend for temporal-analytics workloads only —
  the columnar engine is genuinely better for time-series queries, and
  there is no gain in ripping it out. Drop dual-emit `sql|cypher` down
  to `cypher`-only at the same time (T-M7-3).

## Schema choice — polymorphic rel-table-per-edge

The idiomatic Cypher-on-a-column-store shape is **one named rel table
per edge kind**, each with multiple `FROM / TO` node-type pairs. The ADR
records this explicitly because the v1.0 roadmap originally suggested
one `CodeRelation` rel table with a `type` column, and the LadybugDB
schema docs at
`docs.ladybugdb.com/cypher/data-definition/create-table` make the
opposite recommendation: `CREATE REL TABLE Calls(FROM Function TO
Function, FROM Method TO Method, confidence FLOAT)` gives the planner
the physical partition-by-kind it needs for predicate pushdown, and a
`MATCH (a)-[r:Calls]->(b)` query probes exactly one table with no row
filter.

Rejected alternative: a single rel table with a `type` property. Reasons
for rejection:

1. Identical full-scan cost to the DuckDB shape we are leaving — the
   planner has nothing to prune.
2. Forces every subsequent query rewrite to include `WHERE r.type = ?`,
   which is exactly the idiom the graph engine is supposed to replace.
3. Loses the ability to declare kind-specific constraints (e.g. the
   `HAS_METHOD` edge is always `Class → Method` or `Interface → Method`;
   the polymorphic shape encodes that constraint in DDL).

The schema translator in `packages/storage/src/graphdb-schema.ts` emits
one `CREATE REL TABLE` per entry in `getAllRelationTypes()` plus one
`CREATE NODE TABLE CodeNode` with the shared property columns from the
DuckDB `nodes` schema. The parity gate (§graphHash invariant below)
catches any drift between the two schemas at CI time.

## Concurrency model — process-wide Database + Connection pool

LadybugDB v0.16's public API exposes one `Database` handle and a pool of
`Connection` objects obtained via `new Connection(db)`. Connections are
**not** safe to call `.query()` on concurrently — two overlapping calls
on the same `Connection` segfault the native binding. The safe shape is
one `Database` opened `READ_WRITE` for the process, plus a pool of
`Connection` objects where each checkout guarantees exclusive use until
it is returned.

The pool adapter at `packages/storage/src/graphdb-pool.ts` (545 LOC)
encodes that contract. It was lifted from the same-shape adapter in
GitNexus and re-audited for the v0.16 API surface — the LadybugDB
fork's `Connection` lifecycle is materially identical to the Kuzu line
the GitNexus adapter was written against, and the audit did not turn up
a behavioural change that required a rewrite. Parameters (locked in by
AC-M3-2):

| Parameter | Value | Rationale |
|---|---|---|
| `MAX_CONNS_PER_REPO` | 8 | Matches the concurrent-query budget the MCP tools plan for; beyond 8 the lock contention on the LadybugDB journal becomes the bottleneck anyway. |
| Waiter timeout | 15 s | A queued checkout that waits longer than this surfaces a pool-exhaustion error rather than silently blocking the MCP tool call. |
| Query timeout | 30 s | Mirrors the existing `IGraphStore.query(timeoutMs)` contract. The `sql` MCP tool still enforces its own 5-second default; this ceiling is for long-running CLI paths. |
| Idle sweep | 60 s | Reclaims `Connection` objects that have been checked in but unused, so a quiet repo does not hold 8 native handles open indefinitely. |
| Pool cap | 5 | Upper bound on the **number of distinct `Database` handles** we hold across repos in one process. The v1.0 surface never indexes more than a few repos in one run, so 5 is ample. |

`W-M3-1` (spec 004) enforces the one-query-per-`Connection` invariant in
tests. The pool queue semantics are covered by the 100-concurrent-read
test under `graphdb-pool.test.ts`.

## Source naming — no product-name tokens in tracked source

The banned-strings guardrail (`scripts/check-banned-strings.sh`)
rejects the bare tokens `ladybug` and `kuzu` in tracked source. The
naming strategy below keeps the guardrail clean while still producing
readable, idiomatic TypeScript:

- Class name: `GraphDbStore` (not a product-name prefix).
- File names: `graphdb-adapter.ts`, `graphdb-schema.ts`,
  `graphdb-pool.ts`, `graphdb-adapter.test.ts`, etc.
- OCH-native edge kind `PROCESS_STEP` maps to a Cypher rel table named
  `ProcessStep`, **not** the banned GitNexus-style `STEP_IN_PROCESS`.
- The npm dependency `@ladybugdb/core` (declared in
  `packages/storage/package.json`) is allowed under a per-literal
  allowlist in `scripts/check-banned-strings.sh` — the package scope is
  an external identifier, not a source-level symbol.
- This ADR lives under `docs/adr/` and names the product in prose. The
  commit that introduces this file also adds `:(exclude)docs/adr` to
  the banned-strings `EXCLUDES` list so the historical-rationale prose
  does not have to play games with the token boundaries. Source files
  are still swept.

## graphHash invariant and the parity gate

`graphHash` is computed over the in-memory `KnowledgeGraph`
(`packages/core-types/src/graph-hash.ts`, 45 LOC). It is defined as the
SHA-256 of the canonical-JSON projection `{edges, nodes}` with every
object's keys sorted — the hash function never touches store rows, so
the invariant is **store-agnostic by construction**.

The parity gate lands at `packages/storage/src/graph-hash-parity.test.ts`
(AC-M3-4, 517 LOC). For every fixture, the test does a symmetric
round-trip through both backends and asserts:

```
graphHash(fixture)
  === graphHash(rebuildFromDuckDb(duckStore))
  === graphHash(rebuildFromGraphDb(graphDbStore))
```

Three fixtures cover the shape-space:

- **small**: ≤10 nodes, `DEFINES` + `CALLS` only (sanity shape).
- **medium**: ~60 nodes across `File` / `Class` / `Interface` / `Method`
  / `Contributor` with `DEFINES`, `IMPLEMENTS`, `HAS_METHOD`, `CALLS`,
  `OWNED_BY`.
- **large**: ≥500 nodes as a long `CALLS` chain with shortcuts, plus a
  sweep that emits one edge for every entry in `getAllRelationTypes()`
  — so a schema regression that silently drops a rel table surfaces as
  a hash mismatch on the next CI run.

Current runtime is ≈2.1 s across the three fixtures. The budget in spec
004 §AC-M3-4 is 30 s, and the gate is wired into `mise run check` so it
runs on every commit.

One subtlety the gate codifies: the DuckDB `step` column is `INTEGER
NOT NULL DEFAULT 0`, while the graph-db `step` column is a nullable
`INT32`. When an edge's step is explicitly `0`, the two backends
disagree on readback (DuckDB returns `0`, the graph-db returns `null`).
Both readers in the parity test normalize by dropping `step` when it
reads back as zero or null, which is the same convention
`duckdb-adapter.test.ts` already uses. The fixtures themselves avoid
`step: 0` so the original-graph comparison stays clean.

## Fallback — Apache AGE on Postgres 18

If LadybugDB breaks beyond repair at some point during M3 – M6 (the
library is pre-1.0; a sufficiently-bad ABI break could ship with no
easy fix), the documented escape hatch is Apache AGE on Postgres 18.
AGE is a Cypher extension for Postgres with a comparable data model — a
port would touch the same `IGraphStore` seam this ADR relies on. The
fallback is **documented, not implemented**; the work is scoped as
T-M7-5 and only fires if the primary backend fails the parity gate on
a version we cannot roll back from.

We pick AGE rather than Neo4j or the cloud-hosted graph engines because
of ADR 0001's rail: self-hosted OSS only, no hosted / managed / SaaS
tier. AGE ships as a Postgres extension and inherits Postgres's
embedded-use patterns directly. Neo4j Community Edition has license
terms (GPLv3) that conflict with our distribution rights under
Apache-2.0 (per the ADR 0001 license filter).

## 3-phase plan

| Phase | Milestones | What ships | Default backend |
|---|---|---|---|
| 1 | M3 | Opt-in `CODEHUB_STORE=lbug`, schema translator, pool adapter, parity gate, `sql` MCP tool gains a `cypher` input. | DuckDB. |
| 2 | M4 – M6 | Both backends stay green. Every storage-touching feature writes against `IGraphStore`. Cross-repo federation (M6) exercises both backends end-to-end. | DuckDB. |
| 3 | M7 | Flip default to `CODEHUB_STORE=lbug` (T-M7-1). Keep DuckDB for temporal analytics only (T-M7-2). Drop dual-emit `sql|cypher` down to `cypher`-only (T-M7-3). Final parity audit across the testbed corpus (T-M7-4). | GraphDB. |

The phased plan is the reason this ADR does not itself flip the default
— that decision belongs to M7, after the second backend has absorbed
two milestones of parallel-work traffic.

## Risks

1. **Pre-1.0 library with ABI churn.** `@ladybugdb/core` is at 0.16.1
   as of 2026-05-04. GitNexus pins 0.15.2, so we already know ABI
   breaks land every few months. Mitigation: pin the exact minor in
   `packages/storage/package.json` (`^0.16.1` today; bumped
   intentionally, not via `pnpm up`). The opt-in `CODEHUB_STORE=lbug`
   surface means any ABI mismatch shows up cleanly at `GraphDbStore.open()`
   time rather than silently corrupting a user's default workflow
   (spec 004 state req S-M3-3).
2. **Re-analyze-on-mismatch runbook.** When a user upgrades OCH across
   a LadybugDB minor bump, the on-disk database file from the prior
   version may refuse to open. `GraphDbStore.open()` surfaces a
   specific "database was written by a different `@ladybugdb/core`
   version; re-run `codehub analyze --force`" message and does **not**
   silently truncate. The runbook is linked from the error text, not
   the commit message of the version bump.
3. **Platform support for the native binding.** The library ships
   prebuilt binaries for linux-x64, linux-arm64, darwin-x64, and
   darwin-arm64 at v0.16.1. CI platforms without a prebuilt binary
   will fail the lazy import at `open()`; the parity test skips
   cleanly in that case rather than failing the whole run (the
   skip-on-missing-binding path is tested explicitly).
4. **Bundled dep vs optional peer.** This ADR hard-depends on
   `@ladybugdb/core` (spec 004 §AC-M3-1, user-approved 2026-05-05).
   Making it an optional peer was considered and rejected: the parity
   test needs the binding in CI, and platform-specific installers
   already gate per-OS binaries at the npm level. A missing binary is
   a platform issue, not a dependency issue.

## Status

- **Proposed**: 2026-05-05 (M3 ADR commit).
- **Accepted**: on merge of `feat/v1-m3-m4` → `main` (the PR that ships
  all of M3 at once, per spec 004 AC-M4-8).
- **Superseded**: not before M7. M7 adds a follow-up ADR (scope: flip
  default + drop SQL dual-emit + final parity audit).

## References

- `docs/adr/0001-storage-backend.md` — the DuckDB selection that this
  ADR leaves in place as the M3 – M6 default.
- `.erpaval/ROADMAP.md` §M3, §M7 — the durable roadmap rows that
  sequence this work.
- `.erpaval/specs/004-m3-m4/spec.md` §AC-M3-1..6 — acceptance criteria
  landed in Wave 1 + Wave 2.
- `packages/core-types/src/graph-hash.ts` — store-agnostic hash
  definition.
- `packages/storage/src/graph-hash-parity.test.ts` — parity gate, three
  fixtures (small / medium / large), 24-edge-kind sweep.
- `packages/storage/src/graphdb-pool.ts` — pool adapter, 545 LOC,
  lifted and re-audited from the GitNexus adapter.
- `packages/storage/src/graphdb-schema.ts` — polymorphic
  rel-table-per-kind DDL translator.
- `scripts/check-banned-strings.sh` — guardrail; this ADR's commit
  adds `:(exclude)docs/adr` to the `EXCLUDES` list so
  architectural-history prose can name the tool.
- LadybugDB schema docs (cited above) —
  `docs.ladybugdb.com/cypher/data-definition/create-table`.

## Provenance

LadybugDB is the community successor to the Kuzu project. Kuzu was
acquired by Apple in early 2026 and its public-source cadence stopped;
LadybugDB forked from the pre-acquisition open-source codebase under
the existing permissive license and continues development under the
`@ladybugdb/core` npm identifier. Pinning a specific minor is a hard
requirement in both pre-acquisition and post-fork lineages — this ADR
does not rely on any capability that was added to Kuzu after the fork
point, and the fork's schema surface (named rel tables, Cypher
dialect, native `Database` + `Connection` API) is 1:1 compatible with
the pre-acquisition docs. We cite the LadybugDB docs URL in the schema
section above because that is the current authoritative reference; the
Kuzu docs for the same surface are equivalent for our purposes but are
not guaranteed to stay online.
