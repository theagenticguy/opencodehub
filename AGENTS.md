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
- `rename` — graph-assisted multi-file rename; dry-run is the default.
- `sql` — read-only SQL against the local graph store with a 5 s timeout.

Run `codehub analyze` after pulling new commits so the index stays aligned
with the working tree. `codehub status` reports staleness.

## Full MCP surface

The full MCP surface is **29 tools** (see `packages/mcp/src/server.ts`);
the 7 listed above are the high-frequency exploration tools. For the
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
provides a `code-analyst` subagent and 10 skills. Install via
`codehub init` (writes `.mcp.json` + links the plugin).

## Storage backend — lbug graph + DuckDB temporal

The graph tier is always `@ladybugdb/core` (`graph.lbug`); the temporal
tier — cochanges, structured symbol summaries, and the
`codehub query --sql` escape hatch — is always DuckDB
(`temporal.duckdb`). Both files live under `<repo>/.codehub/`. There is
no env-var, no probe, no fallback; if the lbug binding fails to load,
`open()` throws `GraphDbBindingError` and the operation aborts. See
ADR 0016 (`docs/adr/0016-duckdb-graph-rip.md`) for the rationale and the
AGE/Memgraph/Neo4j/Neptune community-adapter contract that survives the
rip-out (the segregated `IGraphStore` / `ITemporalStore` interfaces stay
exactly because community-fork adapters are a deliberate escape hatch).

`IGraphStore` lives only on `GraphDbStore`; `DuckDbStore` implements
`ITemporalStore` only. Embeddings live in `graph.lbug` and stream into a
per-call DuckDB temp table at pack time so the byte-identical Parquet
sidecar still works (see `packages/pack/src/embeddings-sidecar.ts`).
Future temporal swap (e.g. SQLite-WASM) only needs a new `ITemporalStore`
implementor — no graph-tier change.
