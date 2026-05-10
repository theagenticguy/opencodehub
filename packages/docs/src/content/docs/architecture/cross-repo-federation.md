---
title: Cross-repo federation
description: Repo as a first-class graph node, the group registry, the AMBIGUOUS_REPO envelope, and the M5 / M6 design.
sidebar:
  order: 27
---

OpenCodeHub federates across repos at the graph layer, not at the
client layer. The repo is a typed graph node, group membership is a
graph relation, and every per-repo MCP tool understands the same
canonical `repo_uri` shape.

## Repo as a typed node

ADR 0012 promoted the repo from a runtime-only registry handle (the
absolute working-tree path stored in `~/.codehub/registry.json`) to a
typed `Repo` node in the graph. The promotion fixed three concrete
gaps the earlier shape could not close:

1. **Cross-repo edges had no typed source/target.**
   `group_cross_repo_links` emits records like
   `{source_repo_uri, target_repo_uri, source_doc_path, target_doc_path, relation}`.
   Without a graph-side `Repo` entity those records were free-floating
   tuples; with it, they are first-class edges that join into
   ownership and centrality queries.
2. **`AMBIGUOUS_REPO` `choices[]` had no graph backing.** The
   structured envelope payload now sources `{repo_uri, default_branch,
   group}` straight from the graph, not the runtime registry.
3. **`group_*` tools needed a typed primitive for fan-out.** The Repo
   node lets group tools compose with the rest of the graph instead of
   going through a separate registry-only code path.

## `repo_uri` — the canonical handle

`repo_uri` is a Sourcegraph-style URI. Two shapes:

| Shape | Example | When |
|---|---|---|
| Hosted | `github.com/org/repo` | Repos with a known remote. |
| Local | `local:<sha256-of-path>` | Unpublished or local-only repos. |

Every per-repo tool accepts both `repo` (registry name — the
human-readable handle) and `repo_uri` (the typed graph attribute).
When both are supplied, `repo_uri` wins. Every group tool emits
`repo_uri` in the same canonical form, so a caller can chain a group
query into a per-repo retry without translation.

## The `AMBIGUOUS_REPO` envelope

When two or more repos are registered and a per-repo tool is called
without either `repo` or `repo_uri`, the server returns
`AMBIGUOUS_REPO` in the structured-error envelope:

```jsonc
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

The `choices[]` array is capped at 10. When `total_matches >
choices.length`, the caller knows the list was truncated.

The retry shape:

```jsonc
{ "tool": "context", "args": { "repo_uri": "github.com/org/api-svc", "symbol": "..." } }
```

This is what makes the federation surface composable from a
deterministic agent loop: the loop never has to guess.

## The group surface

Six MCP tools form the group cluster. All of them key off a named
group; `codehub group create` registers it.

### `group_list`

List the groups configured on this machine. Cheap. Always safe to
call before fanning out.

### `group_query`

BM25 + RRF over every member repo, fused into a single ranked list.
Each hit carries its source `repo_uri` so a follow-up `context` /
`impact` call has the disambiguator handed to it.

### `group_status`

Per-repo staleness across the group. Returns `{repo_uri, indexed_at,
graph_hash, staleness_lag_commits}` per member. The agent uses this
to decide whether the cross-repo answer can be trusted before
spending tokens on it.

### `group_contracts`

The HTTP contract matrix. Walks `Route` (producers) and `Fetch`
(consumers) edges across repo boundaries. Pairs every producer route
with its known consumers, including the `fetches:unresolved:<id>`
pseudo-targets that the heuristic resolver emits when a consumer's
URL pattern does not match any local route.

### `group_cross_repo_links`

The audit-trail tool. Returns every typed cross-repo edge in the
group, with both endpoints fully qualified by `repo_uri` and
`source_doc_path` / `target_doc_path` filled in for documentation
references.

### `group_sync`

Rebuild the group's contract registry and cross-link table after a
member has been re-indexed. Idempotent.

## How groups compose with the rest

Groups are **not** a separate ingestion pipeline. Each member repo is
indexed independently with its own `codehub analyze`. The group
registry is a thin layer on top — it tells the federation tools how
to fan out.

That has two consequences worth calling out:

- **Re-indexing one member does not invalidate the rest.** `codehub
  analyze` on `repoA` does not touch `repoB`'s `.codehub/`. The next
  `group_query` simply sees a fresher hash for `repoA`.
- **Group queries respect per-repo determinism.** Fan-out is
  reciprocal-rank-fusion of independently deterministic per-repo
  results, so the group answer is deterministic by construction (at
  fixed group membership).

## See also

- [ADR 0012 — Repo as a first-class graph node](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0012-repo-as-first-class-node.md)
- [Cross-repo groups guide](/opencodehub/guides/cross-repo-groups/)
- [MCP tools — group family](/opencodehub/mcp/tools/#group--federation-6)
- [Error codes — AMBIGUOUS_REPO](/opencodehub/reference/error-codes/#ambiguous_repo-envelope)
