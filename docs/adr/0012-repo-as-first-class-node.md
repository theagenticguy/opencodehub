# ADR 0012 — Repo as a first-class graph node

- Status: **Accepted** — `feat/v1-m5-m6` PR / 2026-05-07.
- Authors: Laith Al-Saadoon + Claude.
- Branch: `feat/v1-m5-m6`.
- Supersedes nothing. Extends ADR 0011 (LadybugDB phase-1) by adding a
  new graph-side entity behind the same `IGraphStore` seam, and ADR 0001
  (DuckDB backend) by adding the corresponding columns to the
  polymorphic `nodes` table without a schema-version bump.

## Context

OpenCodeHub's M1 – M5 graph treated each indexed repository as a runtime
detail. The repo handle was the absolute working-tree path stored in
`~/.codehub/registry.json`, and every per-repo MCP tool keyed off that
on-disk registry rather than off the graph itself. That shape held up
while OCH was a single-repo tool, but the M6 cross-repo federation
surface — `group_query`, `group_status`, `group_contracts`,
`group_list`, `group_cross_repo_links`, plus the structured
`AMBIGUOUS_REPO` envelope — surfaced three specific problems the
runtime-only registry could not solve.

1. **Cross-repo edges had no typed source/target.** `group_cross_repo_links`
   (the AC-M6-3-reframed analysis helper at
   `packages/analysis/src/group/cross-repo-links.ts`) emits
   `{source_repo_uri, target_repo_uri, source_doc_path, target_doc_path,
   relation}` records that the orchestrator embeds into `.docmeta.json`
   v2. Without a graph-side `Repo` entity, those records had no
   declaration site — they were free-floating tuples that could not be
   audited, joined to `Contributor` ownership, or surfaced through
   `sql` / Cypher queries. The graph already has typed `Process`,
   `Route`, `Tool`, `Section`, `Finding`, `Operation`, `Contributor`,
   and `ProjectProfile` entities; `Repo` was the missing peer.
2. **`AMBIGUOUS_REPO` `choices[]` had no graph backing.** AC-M6-2
   landed the structured `_meta` payload on
   `structuredContent.error` carrying
   `{error_code, jsonrpc_code, choices: [{repo_uri, default_branch,
   group}], total_matches, hint}`. The `choices[]` shape is sourced
   from the registry today, but the canonical store for those three
   attributes — `repoUri`, `defaultBranch`, and `group` — is the graph
   itself once a repo is a first-class node. The runtime registry then
   becomes a session-scoped index over the graph's `RepoNode`
   singletons, not the source of truth.
3. **The runtime-only registry was not deterministic.** The same repo
   cloned to two absolute paths produced two registry entries with
   different generated IDs, even though the graph contents were
   byte-identical. Promoting `Repo` into the graph (and computing the
   id from a stable `("Repo", "", "repo")` triple) gives every clone
   the same node identity — the absolute path no longer leaks into
   `graphHash`, and the same commit on two machines produces the same
   `RepoNode.id`.

The clean fix is a graph-native `Repo` entity that synthesizes the
Sourcegraph-style repository URI scheme with SCIP `Metadata.toolInfo`:
a stable cross-repo handle (`repoUri`) plus the indexer name + version
that produced this graph. The M6 scope adds that entity additively —
the union grows by one kind, the DuckDB `nodes` table grows by 9
columns, the LadybugDB `CodeNode` table grows by the same 9 columns,
and `graphHash` byte-identity holds for every pre-M6 graph because the
new fields are absent on legacy nodes (W-M6-1).

## Decision

Append `Repo` to the `NodeKind` union at `packages/core-types/src/nodes.ts`
(the file's L41-43 warning mandates appending at the end) and add the
nine attributes mandated by spec 005 §E-M6-1:

- `originUrl: string | null` — canonical remote URL; `null` when no git
  remote exists.
- `repoUri: string` — Sourcegraph-style host-path key
  (e.g. `github.com/org/repo`). When `originUrl` is null, this is
  `local:<sha256(absolute-path)[:12]>` per S-M6-1 so the handle remains
  deterministic and distinguishable.
- `defaultBranch: string | null` — default branch at index time.
- `commitSha: string` — 40-char commit SHA the index was built against.
- `indexTime: string` — RFC-3339 UTC. Sourced from `git show -s
  --format=%cI HEAD`, **not** from `new Date().toISOString()`.
- `group: string | null` — federation-group tag.
- `visibility: "private" | "internal" | "public"` — visibility for MCP
  gating; defaults to `private`.
- `indexer: string` — name+version of the indexer, per SCIP
  `Metadata.toolInfo` (e.g. `opencodehub@0.1.0`).
- `languageStats: Readonly<Record<string, number>>` — language
  distribution by fraction; sum bounded at 1.0.

The node is a singleton per graph — constructed via
`makeNodeId("Repo", "", "repo")` so the id stays stable across clones
of the same repo on different absolute paths (mirroring
`ProjectProfileNode`). The phase that emits it is
`packages/ingestion/src/pipeline/phases/repo-node.ts`, run after
`profile` (so `languageStats` can inherit the detected-languages list
from `ProjectProfileNode.languages`) and before `scip-ingest`.

The `repo_uri` shape is the on-the-wire canonical form for every M6
MCP surface: the `AMBIGUOUS_REPO` `choices[]` array (AC-M6-2), every
`group_*` tool's response payload (AC-M6-4), and the cross-repo link
emissions surfaced by `group_cross_repo_links` (AC-M6-3 reframed). All
four MCP tools accept `repo_uri` as an input alias for the legacy
`repo` registry-name argument; both inputs resolve through the same
`packages/mcp/src/repo-resolver.ts` path.

The phased plan, sequenced by milestone:

- **M6** (this milestone): `RepoNode` ships behind the existing
  `IGraphStore` seam. New repos get a `RepoNode` on the next `codehub
  analyze`. Pre-M6 graphs are **not** backfilled — see §Migration. The
  AMBIGUOUS_REPO `_meta.choices[]` payload, the `group_*` tools'
  additive `repo_uri` fields, and the cross-repo link records all
  source `repo_uri` from the new node.
- **M7** (planned at authoring time; **not pursued** — see §Edge kinds
  deferred below): drop the legacy `repo` registry-name argument across
  all per-repo and group MCP tools (T-M7-6) and add `Repo`-rooted edge
  kinds (T-M7-7). Neither task shipped. The clean-slate v1 release keeps
  the legacy `repo` argument as an accepted alias alongside `repo_uri`,
  and `Repo` remains an edge-less singleton node.

## Schema choice — append-only `NodeKind` union

The serialized shape of `NODE_KINDS` is load-bearing. `graphHash`
(`packages/core-types/src/graph-hash.ts`, 45 LOC) computes the
SHA-256 of the canonical-JSON projection `{edges, nodes}` with every
object's keys sorted, and the kind discriminator is part of every node
payload. The file's own comment at L41-43 captures the constraint:

> Insertion order is load-bearing: any reorder of NODE_KINDS changes
> the serialized payload hashed by graphHash. New kinds must be
> APPENDED at the end to preserve stability of existing graph hashes
> across schema minor bumps.

`Repo` is appended at the end of both `NodeKind` and the runtime
`NODE_KINDS` array (`packages/core-types/src/nodes.ts:40,82`). The
discriminated `GraphNode` union is extended in the same file at
L591 with `RepoNode` appended at the end. Pre-M6 graphs read back
without any `Repo` node, so their canonical-JSON projection is
byte-identical to the M5 projection — `graphHash` is preserved.

The DuckDB schema does not need a version bump. The polymorphic
`nodes` table absorbs the 9 new attributes as additional nullable
columns (the storage adapter already serializes per-kind property
sets through this single table). The LadybugDB `CodeNode` table at
`packages/storage/src/graphdb-schema.ts:101-176` is updated with the
same 9 columns: `origin_url`, `repo_uri`, `default_branch`,
`commit_sha`, `index_time`, `repo_group`, `visibility`, `indexer`,
`language_stats_json`. Both backends serialise the `Repo` node behind
the existing `kind` discriminator — no per-kind table partitioning is
needed for a singleton.

Rejected alternative: a separate `repos` (DuckDB) /
`Repo` (LadybugDB) table dedicated to repo-level metadata. Reasons for
rejection:

1. The graph already has one polymorphic node table by design (ADR
   0001's column-store choice). Splitting per kind for a singleton
   adds DDL surface without paying off — the table would always have
   exactly one row per indexed repo.
2. Cross-table joins would have to be added to every `sql` MCP query
   that wants the indexer or commit SHA, defeating the whole point of
   keeping `RepoNode` first-class.
3. The LadybugDB rel-table-per-kind shape (ADR 0011 §Schema choice)
   is for **edges**, not nodes. Splitting nodes by kind is not the
   idiomatic Cypher pattern; LadybugDB's `MATCH (r:CodeNode {kind:
   "Repo"})` is the canonical lookup.

## graphHash invariant and the parity gate (W-M6-1)

`graphHash` is store-agnostic by construction (ADR 0011 §graphHash
invariant). The W-M6-1 invariant adds three guarantees specific to
the M6 schema bump:

1. **Appending `Repo` to `NodeKind` MUST NOT change `graphHash`**
   for any pre-M6 graph. The append-only ordering at
   `packages/core-types/src/nodes.ts:41-43,82` is the mechanical
   guarantee. The parity test at
   `packages/storage/src/graphdb-adapter.test.ts` covers a fixture
   that has no `Repo` node and asserts the round-trip
   `graphHash(fixture) === graphHash(rebuildFromGraphDb(...))`.
2. **`indexTime` MUST come from `git show -s --format=%cI HEAD`**, not
   from wall-clock `new Date().toISOString()`. The
   `packages/ingestion/src/pipeline/phases/repo-node.ts:121-125`
   `probeCommitTime` helper enforces this. Wall-clock noise would
   poison `graphHash` on every pipeline run; pinning to the HEAD
   commit time gives "stable per commit" without excluding the field
   from `graphHash`.
3. **Existing graphs are NOT backfilled.** Pre-M6 graphs read back
   without a `RepoNode`, and the engine tolerates the absence (no
   `for-each-node` loop assumes a `Repo` is present). The first
   `codehub analyze` after upgrading to M6 is the only path that
   adds the node — and that run produces a brand-new graph anyway,
   so byte-identity is moot for it.

The fallback sentinel `1970-01-01T00:00:00Z` (set by
`probeCommitTime` when git is unavailable or the repo is not a
working tree) carries no run-to-run variance and is the core of
W-M6-1's determinism guarantee for non-git inputs. The injected `now`
override is reserved for tests and reproducible-build paths — the
production phase never uses it.

The reframed AC-M6-3 work landed as commit `86e295b` (the
`computeCrossRepoLinks` analysis helper plus the
`group_cross_repo_links` MCP tool) and the orchestrator-side
`.docmeta.json` v2 schema. The orchestrator Sonnet writes
`.docmeta.json` at runtime — no engine TS writer exists, by design.

## Migration

There is **no backfill**. Pre-M6 graphs on disk continue to read back
without a `RepoNode`. Three rules govern the migration:

1. **Lazy population.** The `Repo` node is added on the next `codehub
   analyze` against the repo. Until that runs, the registry resolver
   in `packages/mcp/src/repo-resolver.ts` falls back to the on-disk
   `~/.codehub/registry.json` for the `AMBIGUOUS_REPO.choices[]`
   payload — the structured envelope still works, just without
   graph-sourced provenance.
2. **Engine tolerance.** Every consumer of `RepoNode` checks for its
   presence and degrades gracefully when it's missing. The
   `group_cross_repo_links` tool, for instance, reads `repoUri` from
   a `repo → repo_uri` map computed from the persisted
   ContractRegistry — when the graph has no `RepoNode`, the map is
   built from registry entries directly. The `local:<hash>` form is
   the canonical fallback for repos with no git remote (S-M6-1).
3. **No mass re-analyze runbook.** Users do not need to run `codehub
   analyze --force` across their entire indexed corpus to pick up
   M6. The change is opt-in by activity: as repos are re-analyzed in
   the normal course of work, they pick up `RepoNode` one at a time.
   The runbook for AMBIGUOUS_REPO retries (cited in `AGENTS.md` and
   `CLAUDE.md`) works regardless of whether the graph has the node
   yet.

## Edge kinds deferred → not pursued (won't-do for v1)

`Repo` ships **without new edge kinds**, and that stayed true for v1.
At authoring time this section sketched four `Repo`-rooted edges —
`Repo HAS_FILE File`, `Repo HAS_DEPENDENCY Dependency`,
`Repo OWNED_BY Contributor`, `Repo IN_GROUP Community` (or similar) —
to land in M7 under tasks T-M7-6 / T-M7-7. **None of them shipped.**

> **Resolution (v1 clean-slate, 2026-06): won't-do.** The four
> `Repo`-rooted edge kinds were never added. The v1 release does not
> carry the M7 edge-schema extension; `RelationType` /
> `RELATION_TYPES` in `packages/core-types/src/edges.ts` has **25**
> members (`CONTAINS` … `TYPE_OF`), none of them `Repo`-rooted, and
> `Repo` remains an edge-less singleton. `OWNED_BY` does exist in that
> enum, but it is a **blame-level** edge from a symbol/file to a
> `Contributor` (its `confidence` carries the normalized blame-line
> share, per `CodeRelation`'s doc comment) — it is **not** the
> `Repo OWNED_BY Contributor` repo-level edge sketched above. The
> federation surface (AMBIGUOUS_REPO, the `group_*` tools, cross-repo
> links) reads `repo_uri` straight off the `RepoNode` and from the
> persisted ContractRegistry, so no `Repo`-rooted edge was needed to
> ship it.

The original deferral rationale (left for the record): every new edge
kind is a new physical rel table on the LadybugDB backend
(rel-table-per-kind shape, ADR 0011 §Schema choice), so each new kind
costs one DDL update plus one parity-test fixture. The cost never paid
off — the v1 surface ships without these edges, and any future
`Repo`-rooted edge work would land under its own ADR.

## Risks

1. **`NodeKind` union grows non-additively in a future change.** If a
   future contributor reorders `NODE_KINDS` or inserts a new kind in
   the middle of the array, `graphHash` will drift across the entire
   indexed corpus. The L41-43 warning is the documented guardrail; the
   parity test at
   `packages/storage/src/graphdb-adapter.test.ts` is the mechanical
   guardrail. We accept this risk because the alternative — a
   schema-version bump on every union extension — would force every
   user to re-index their corpus on every minor release.
2. **`local:<hash>` collisions.** The S-M6-1 fallback hashes the
   absolute path with SHA-256 truncated to 12 hex chars (48 bits).
   The collision probability at 1k repos is < 2^-22 (negligible), but
   two clones of the same repo at different absolute paths will
   produce different `local:<hash>` URIs. This is intentional: when a
   repo has no git remote, the absolute path **is** the only stable
   handle we have. Once the repo gets a git remote, the next analyze
   replaces the `local:<hash>` URI with the canonical
   `host/path` form.
3. **`indexTime` poisoning if a writer ever uses wall clock.** The
   `repo-node` phase pins `indexTime` to `git show -s --format=%cI
   HEAD`, but a future contributor adding a different writer (e.g. a
   migration that synthesizes a `RepoNode` post-hoc) could
   accidentally use `new Date().toISOString()`, breaking
   determinism. The mechanical guardrail is the parity test; the
   prose guardrail is this ADR plus the inline doc comment at
   `packages/ingestion/src/pipeline/phases/repo-node.ts:241-246`.
4. **SCIP boundary off-by-one bugs.** SCIP is 0-indexed at the symbol
   boundary, the OCH graph is 1-indexed at the file-line boundary
   (`.erpaval/solutions/conventions/scip-0-indexed-vs-graph-1-indexed.md`).
   The `RepoNode` itself does not carry line numbers, so this risk is
   indirect — but if a future edge kind (say `Repo CONTAINS_SYMBOL
   Symbol`) is added in M7 without the boundary normalisation, it
   could drift `graphHash` on every existing graph. The M7 ADR is the
   right place to encode that constraint.
5. **Visibility default may leak data.** `RepoNode.visibility`
   defaults to `private`. The MCP gating layer at
   `packages/mcp/src/repo-resolver.ts` checks this field before
   returning a repo in `AMBIGUOUS_REPO.choices[]` for a caller that
   has not authenticated to that visibility tier. If a future writer
   forgets to set the field, the default is the conservative
   `private` value — failing closed rather than open. The runtime
   default is intentional defensive depth, not coincidence.

## Status

- **Proposed**: 2026-05-07 (M6 ADR commit).
- **Accepted**: on merge of `feat/v1-m5-m6` → `main`. The status
  flips to **Accepted** in the same commit that ships AC-M6-5 (this
  ADR plus the AGENTS.md / CLAUDE.md cross-references plus the
  synthetic 2-repo quickcheck) — see §References below.
- **Superseded**: no. The planned M7 follow-up (drop the legacy `repo`
  argument, add `Repo`-rooted edge kinds) was **not pursued** — see
  §Edge kinds deferred → not pursued. The `RepoNode` shape this ADR
  introduced stands as-is in v1.

## References

- Spec: `.erpaval/specs/005-m5-m6/spec.md` §AC-M6-1 (RepoNode in
  graph), §AC-M6-2 (AMBIGUOUS_REPO `choices[]`), §AC-M6-3 (reframed —
  `group_cross_repo_links` MCP tool + `.docmeta.json` v2 schema),
  §AC-M6-4 (`group_*` tools emit `repo_uri`), §AC-M6-5 (regression +
  this ADR), §S-M6-1 (`local:<hash>` fallback), §W-M6-1 (graphHash
  byte-identity).
- Commits:
  - `9ee6a96` — feat(core-types): first-class `RepoNode` in graph
    (AC-M6-1).
  - `26e507b` — feat(mcp): structured AMBIGUOUS_REPO with `choices[]`
    + `repo_uri` alias (AC-M6-2).
  - `f9fdde2` — feat(mcp): `group_*` tools emit `repo_uri` additively
    (AC-M6-4).
  - `86e295b` — feat(analysis): `group_cross_repo_links` MCP tool +
    v2 docmeta spec (AC-M6-3 reframed).
- Code:
  - `packages/core-types/src/nodes.ts:40,82,524-552,591` —
    `NodeKind` union, `NODE_KINDS` array, `RepoNode` interface,
    `GraphNode` union extension.
  - `packages/ingestion/src/pipeline/phases/repo-node.ts` — phase
    implementation (329 LOC), `deriveRepoUri` URL normaliser,
    `deriveLocalRepoUri` SHA-256 fallback, `probeCommitTime` git
    HEAD reader.
  - `packages/storage/src/graphdb-schema.ts:101-176` — LadybugDB
    `CodeNode` table with the 9 RepoNode columns appended.
  - `packages/mcp/src/repo-resolver.ts` — `AMBIGUOUS_REPO.choices[]`
    construction, `repo_uri` alias resolution.
  - `packages/analysis/src/group/cross-repo-links.ts` — pure helper
    that emits `{source_repo_uri, target_repo_uri, source_doc_path,
    target_doc_path, relation}` records (AC-M6-3 reframed).
  - `packages/mcp/src/tools/group-cross-repo-links.ts` — the MCP
    surface for the helper.
- Tests:
  - `packages/storage/src/graphdb-adapter.test.ts` — graphHash parity
    on the round-trip through both backends (ADR 0011's W-M3-1 and
    this ADR's W-M6-1 share the same gate).
  - `packages/ingestion/src/pipeline/phases/repo-node.test.ts` —
    git-probe injection covers HTTPS, SSH, no-remote, and `local:`
    fallback shapes.
  - `packages/analysis/src/group/cross-repo-links.test.ts` —
    determinism + 5-tuple alpha-sort coverage.
  - `packages/analysis/src/group/cross-repo-links-quickcheck.test.ts` —
    synthetic 2-repo populated-case fixture (this ADR's commit).
- Related ADRs:
  - ADR 0001 — DuckDB backend; `RepoNode` adds 9 nullable columns to
    the polymorphic `nodes` table without a schema-version bump.
  - ADR 0011 — LadybugDB phase-1; this ADR's `RepoNode` adds the same
    9 columns to the LadybugDB `CodeNode` table behind the same
    `kind` discriminator. The W-M6-1 parity gate piggybacks on the
    W-M3-1 round-trip fixture coverage.
- Conventions:
  - `.erpaval/solutions/conventions/scip-0-indexed-vs-graph-1-indexed.md` —
    boundary normalisation rule. The `RepoNode` itself is
    line-number-free, but any future M7 edge kind that joins
    `RepoNode` to a symbol must respect this boundary.

## Provenance

The Sourcegraph-style `host/path` URI scheme is the de-facto cross-repo
handle in code-search literature; we adopt it because every Sourcegraph
client and every CodeHub-style federation tool already speaks it. The
`local:<sha256(path)[:12]>` fallback is OCH-original — Sourcegraph's
public surface has no equivalent, because Sourcegraph hosts are
remote-first. Our embedded-use posture (ADR 0001's self-hosted-OSS
rail) means many user repos have no remote, and the fallback has to
be deterministic without one.

The 9-attribute `RepoNode` shape is the union of Sourcegraph's repo
metadata fields and SCIP's `Metadata.toolInfo` shape. We chose to
synthesise both rather than pick one because the Sourcegraph fields
(URI, default branch, group) are the cross-repo handle, while the
SCIP fields (indexer name + version, language stats) are the
provenance trail — and OCH needs both to surface a coherent
`AMBIGUOUS_REPO.choices[]` payload AND a coherent `.docmeta.json` v2
cross-repo-links graph. Splitting them across two node kinds would
defeat the singleton-per-graph property.

The `indexTime` field is the one place this ADR diverges from both
Sourcegraph and SCIP. Sourcegraph stores `indexedAt` as a wall-clock
timestamp; SCIP does not record an index time at all (the SCIP
document is the source of truth). We chose `git show -s --format=%cI
HEAD` for the third option: stable per commit, deterministic across
machines, and not subject to clock skew or wall-clock noise. The
fallback sentinel `1970-01-01T00:00:00Z` is the documented signal
for "no git working tree" and never appears for a valid index.
