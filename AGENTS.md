<!-- Intentionally synchronized with CLAUDE.md. Edit both files together.
     v1 docs sweep: AGENTS.md drops session-local spec coordinates that
     CLAUDE.md still carries. The substantive guidance is identical. -->
## OpenCodeHub MCP Tools

This repository has been indexed by OpenCodeHub. When you are working in this
codebase, prefer the following MCP tools over raw file search — they return
graph-aware results grouped by execution flow and include blast-radius risk
tiers.

- `list_repos` — enumerate repos currently indexed on this machine.
- `query` — hybrid BM25 + vector search over symbols, grouped by process.
- `context` — inbound/outbound refs and participating flows for one symbol.
- `impact` — dependents of a target up to a configurable depth, with a risk tier.
- `detect_changes` — map an uncommitted or committed diff to affected symbols.
- `list_findings` — browse SARIF findings from the latest scan by severity and rule.
- `sql` — read-only SQL against the local temporal store (cochanges + symbol_summaries), 5 s timeout; the node/edge graph is queried via the typed tools or Cypher via the MCP `sql` tool.

Run `codehub analyze` after pulling new commits so the index stays aligned
with the working tree. `codehub status` reports staleness.

## Full MCP surface

The full MCP surface is **29 tools** (see `packages/mcp/src/server.ts`);
the 6 listed above are the high-frequency exploration tools. For the
full inventory, use the `/opencodehub-guide` skill.

## AMBIGUOUS_REPO

When two or more repos are indexed on this machine, per-repo tools require
an explicit `repo:` (or the `repo_uri:` alias — a Sourcegraph-style URI
such as `github.com/org/repo`, or `local:<hash>` for unpublished repos)
and return `AMBIGUOUS_REPO` otherwise. The error envelope carries a
structured `_meta` payload on `structuredContent.error`:
`{ error_code: "AMBIGUOUS_REPO", jsonrpc_code: -32602, choices: [ { repo_uri, default_branch, group } ] (capped at 10), total_matches, hint }` —
so the calling agent can retry deterministically with a single `repo_uri`
from `choices`. When `total_matches > choices.length`, the caller knows
the list was truncated.

See ADR 0012 (`docs/adr/0012-repo-as-first-class-node.md`) for the
rationale behind `repo_uri` as a first-class node attribute. The
`repo_uri` shape is a typed graph attribute on every `Repo` node
(`packages/core-types/src/nodes.ts`). `group_cross_repo_links` and
the `group_*` family of MCP tools all emit `repo_uri` in the same
canonical form, so a caller can use any of those tools' `repo_uri`
outputs as input to `AMBIGUOUS_REPO.choices` retries.

Worked example — error envelope, then retry:

```jsonc
// Error envelope returned by a per-repo tool when two repos are indexed
{
  "structuredContent": {
    "error": {
      "error_code": "AMBIGUOUS_REPO",
      "jsonrpc_code": -32602,
      "choices": [
        { "repo_uri": "github.com/org/api-svc", "default_branch": "main", "group": "platform" },
        { "repo_uri": "github.com/org/billing-svc", "default_branch": "main", "group": "platform" }
      ],
      "total_matches": 2,
      "hint": "Retry with repo_uri=<one of above>"
    }
  }
}
```

```jsonc
// Retry — pick the first choice deterministically
{ "tool": "context", "args": { "repo_uri": "github.com/org/api-svc", "symbol": "..." } }
```

## Durable lessons

Prior-session architecture lessons live in `.erpaval/INDEX.md` (SCIP edge
conventions, BM25 caveats, SageMaker embedder patterns). Read before
making graph-index or retrieval changes.

## Claude Code plugin

This repo ships a Claude Code plugin at `plugins/opencodehub/` — it
provides a `code-analyst` subagent and 11 skills. Install via
`codehub init` (writes `.mcp.json` + links the plugin).

## Storage backend — single-file SQLite (ADR 0019)

The entire index lives in ONE `<repo>/.codehub/store.sqlite` file (WAL),
via Node's built-in `node:sqlite` — graph nodes, edges, embeddings, and
the temporal tables (cochanges, structured symbol summaries, and the
`codehub query --sql` escape hatch). One `SqliteStore` class implements
BOTH `IGraphStore` and `ITemporalStore`; `openStore()` returns that single
instance as both the `graph` and `temporal` views, so call sites use
`store.graph.X()` / `store.temporal.Y()` unchanged. There are zero native
storage bindings — `@ladybugdb/core` and `@duckdb/node-api` were both
removed. See ADR 0019 (`docs/adr/0019-single-file-sqlite-storage.md`) for
the rationale; it supersedes ADR 0016
(`docs/adr/0016-duckdb-graph-rip.md`).

The segregated `IGraphStore` / `ITemporalStore` interfaces remain as the
community-fork escape hatch: an AGE / Memgraph / Neo4j / Neptune adapter
implements `IGraphStore` and pairs with any SQL-shaped `ITemporalStore`.
Embeddings live in the `embeddings` table inside `store.sqlite` — the
write-only Parquet sidecar was dropped with DuckDB (nothing ever read it
back).
