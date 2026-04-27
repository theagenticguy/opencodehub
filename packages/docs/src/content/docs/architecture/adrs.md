---
title: Architecture decision records
description: Index of OpenCodeHub ADRs — every accepted and superseded decision.
sidebar:
  order: 30
---

Every load-bearing architectural choice in OpenCodeHub is recorded as
an ADR under `docs/adr/` in the repo. This page is the index. Click
through to the source ADR for the full context, candidates
considered, and consequences.

## Accepted

### ADR 0001 — Storage backend selection

**Status:** Accepted (2026-04-18; supersedes prior SQLite recommendation).

**Decision:** DuckDB via `@duckdb/node-api`, with the `hnsw_acorn`
community extension for filter-aware vector search, the official `fts`
extension for BM25, and recursive CTEs with `USING KEY` for
memory-efficient graph traversal. All three choices are MIT.

SQLite + `sqlite-vec` was considered and rejected because FTS5 has no
filtered-HNSW story and `sqlite-vec` HNSW was still early when this
ADR was written. LanceDB was considered and kept as a future alternate
adapter behind the `IGraphStore` interface.

[Read ADR 0001](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0001-storage-backend.md)

### ADR 0002 — Rust core spike deferred to v2.1+

**Status:** Accepted (2026-04-20).

**Decision:** v2.0 ships pure TypeScript. A Rust NAPI-RS native core
is deferred to v2.1+ because the measured p95 single-file incremental
edit on the 100-file fixture (~195-250 ms) is well under the 1 s hard
gate, and the extrapolated cold full analyze on a 100k-LOC fixture
(~3-5 s) is well under the 30 s trigger from the PRD.

Reopens if cold analyze on a user-reported 500k+ LOC repo exceeds 4
minutes, p95 incremental edit on 10k+ files exceeds 30 s, or a
`--cpu-prof` run shows a single function burning >40% of wall clock.

[Read ADR 0002](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0002-rust-core-deferred.md)

### ADR 0004 — Hierarchical embeddings with filter-aware HNSW

**Status:** Accepted (shipped as P03 in v1.1).

**Decision:** One `embeddings` table with a `granularity` discriminator
column (`symbol | file | community`) and a single HNSW index.
Filter-aware traversal via `hnsw_acorn` keeps the one index serving
every tier — the ACORN-1 algorithm pushes the granularity predicate
into the graph walk.

ColBERT / token-level embeddings were rejected (10–30× storage,
bespoke index). RAPTOR tree-traversal was rejected — collapsed-tree +
filter-aware HNSW matches the recall at lower latency.

[Read ADR 0004](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0004-hierarchical-embeddings.md)

### ADR 0005 — SCIP replaces LSP; repomix is output-side only

**Status:** Accepted (2026-04-26).

**Decision:** The four per-language LSP phases and `@opencodehub/lsp-oracle`
are deleted and replaced with a single `scip-index` phase backed by
`@opencodehub/scip-ingest`. Oracle-edge provenance switches from
per-LSP to `scip:<indexer>@<version>`. The old LSP-specific reason
suffix `+lsp-unconfirmed` is renamed to `+scip-unconfirmed` (the old
constant is aliased for one release).

This cuts ~10.6k LOC of LSP client and per-language phases, removes
the pyright / typescript-language-server binary dependency from npm
install, and reshapes indexing from stateful per-symbol JSON-RPC to
one-shot protobuf ingestion.

[Read ADR 0005](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0005-scip-replaces-lsp.md)

### ADR 0006 — SCIP indexer CI pins

**Status:** Accepted (2026-04-27).

**Decision:** Pin table for the per-language SCIP indexers the gym
installs:

| Language   | Indexer         | Version          | Install channel                         |
|------------|-----------------|------------------|-----------------------------------------|
| TypeScript | scip-typescript | 0.4.0            | `npm install -g @sourcegraph/scip-typescript` |
| Python     | scip-python     | 0.6.6            | `npm install -g @sourcegraph/scip-python` |
| Go         | scip-go         | v0.2.3           | `go install github.com/scip-code/scip-go/cmd/scip-go` |
| Rust       | rust-analyzer   | stable component | `rustup component add rust-analyzer`    |
| Java       | scip-java       | 0.12.3           | `coursier install scip-java`            |

Versions are mirrored in `.github/workflows/gym.yml` and
`packages/gym/baselines/performance.json` so the regression harness
has a single source of truth. The ADR also explains why `scip-go`
resolves to the `scip-code` fork rather than upstream `sourcegraph`.

[Read ADR 0006](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0006-scip-indexer-pins.md)

### ADR 0007 — Artifact factory

**Status:** Accepted (2026-04-27).

**Decision:** Ship an artifact-generation skill family inside
`plugins/opencodehub/` that turns the graph into committed Markdown.
Four P0 skills (`codehub-document`, `codehub-pr-description`,
`codehub-onboarding`, `codehub-contract-map`), six `doc-*` subagents,
Phase 0 precompute, `.docmeta.json` + Phase E assembler, PostToolUse
staleness hook, discoverability patches.

Scope exclusions (durable, not timeline): no hosted/managed/SaaS tier,
no remote/HTTP MCP server, no agent SDK, no `grounding_pack`
compositor tool, no own coding agent, no LLM-based PR review, no
IDE plugin/LSP, no model fine-tuning.

[Read ADR 0007](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0007-artifact-factory.md)

### ADR 0008 — codeprobe pattern port

**Status:** Accepted (2026-04-27).

**Decision:** Port codeprobe's four-phase `/document` pattern (Phase 0
precompute → Phase AB parallel content → Phase CD parallel diagrams +
specialty → Phase E deterministic assembler) to OpenCodeHub, with
three adaptations: six subagents instead of eight (supply-chain tools
pre-digest), group mode as a first-class topology, and an extended
assembler contract that handles both `path:LOC` and `repo:path:LOC`
citation forms.

Preserves the pattern invariants verbatim: shared-context files on
disk (not in-prompt copy-paste), eight-section agent scaffold,
deterministic Phase E (no LLM call), `.docmeta.json` as source of
truth for `--refresh`, no YAML frontmatter on outputs.

[Read ADR 0008](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0008-codeprobe-pattern-port.md)

### ADR 0009 — Artifact output conventions

**Status:** Accepted (2026-04-27).

**Decision:** Single authoritative output contract. `.codehub/docs/`
gitignored default; `--committed` opts in to `docs/codehub/`. Backtick
citation grammar with a single Phase E regex covering both single-repo
and group-qualified forms. `.docmeta.json` schema v1 with
`cross_repo_refs[]` for group mode. Mermaid-only diagrams (no
SVG/PNG). 20-node diagram cap with a Legend table for overflow.
Deterministic structure; non-deterministic prose; disclaimer on every
generated `README.md`.

[Read ADR 0009](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0009-artifact-output-conventions.md)

## Superseded

### ADR 0003 — CI toolchain pins (gopls ↔ Go, pnpm build-script allowlist)

**Status:** Superseded by ADR 0006 (2026-04-27).

The gopls pin matrix is historical — OpenCodeHub no longer runs
long-running language servers; code-graph oracle edges come from SCIP
indexers. See ADR 0005 for the migration and ADR 0006 for the current
pin table. The pnpm lifecycle-script guidance remains in force and is
reiterated in ADR 0006.

[Read ADR 0003](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0003-ci-toolchain-pins.md)

## Adding an ADR

New architectural decisions go under `docs/adr/NNNN-slug.md` using the
next numeric prefix. Keep the headings: Status, Date, Context,
Decision, Consequences, plus any ADR-specific sections.

If a new decision supersedes an older one, update the superseded
ADR's status line with a forward link and add a reverse link from the
new ADR's context section.
