---
title: Cross-repo groups
description: Query and analyse a fleet of microservices as one group with codehub group.
sidebar:
  order: 70
---

A platform team with 40 microservices does not want to run 40 separate
`codehub query` commands to find "the users endpoint". Groups let you
bundle several indexed repos and hit them with one cross-repo search,
one contract scan, or one status probe.

## Create a group

```bash title="bundle three repos into a group named fleet"
codehub group create fleet repoA repoB repoC
```

The repo arguments must already be indexed (registered in
`~/.codehub/registry.json`). Use `codehub list` to see what is
registered, or `codehub analyze` inside each repo to register it.

Add `--description "core platform services"` to annotate the group.

## Sync the group

```bash title="rebuild the cross-repo contract registry"
codehub group sync fleet
```

`group sync` walks every repo in the group, rebuilds the contract
registry (HTTP routes, MCP tools, shared types), and populates the
cross-link table so route-change blast-radius is visible across
repos.

## Query across every repo

```bash title="fused BM25 + RRF search"
codehub group query fleet "users endpoint"
```

Cross-repo search runs BM25 (and embedding search, when each repo has
embeddings) against every member and fuses the ranked lists with
reciprocal-rank fusion (RRF). The result is a single ranked list of
hits annotated with their source repo.

Pass `--limit 20` (the default) or `--json` for a script-friendly
envelope.

## Contracts and cross-links

```bash title="list HTTP contracts and cross-repo call edges"
codehub group contracts fleet
```

`group contracts` surfaces every HTTP route defined in the group, the
handler that serves it, and every known consumer (caller) across the
other repos in the group. Combined with `api_impact` over MCP, this is
how platform teams see the blast radius of a route change before
shipping it.

## Other group commands

| Command | Purpose |
|---|---|
| `codehub group list` | List every group on this machine. |
| `codehub group status <name>` | Show staleness and last sync time for a group. |
| `codehub group delete <name>` | Drop the group (repos stay indexed). |

## MCP equivalents

Every `group` CLI command has an MCP tool with the same name prefix:
`group_list`, `group_query`, `group_status`, `group_contracts`,
`group_sync`. See [MCP tools](/opencodehub/mcp/tools/).
