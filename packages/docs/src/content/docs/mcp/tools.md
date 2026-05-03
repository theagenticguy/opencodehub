---
title: MCP tools
description: All 28 MCP tools the opencodehub server registers, grouped by functional cluster.
sidebar:
  order: 20
---

The `opencodehub` MCP server registers **28 tools**, imported and
invoked from `packages/mcp/src/server.ts`. The canonical number is
taken live from `buildServer()` at startup.

> `scripts/smoke-mcp.sh` currently expects 19 tools in its default
> `EXPECTED_TOOLS` env var — that is a stale smoke baseline, not the
> source of truth.

Every per-repo tool accepts an optional `repo` argument; see
[MCP overview](/opencodehub/mcp/overview/) for the resolution rules.

## Search and navigation

| Tool | Purpose | Primary inputs |
|---|---|---|
| `list_repos` | List indexed repos on this machine. | — |
| `query` | Hybrid BM25 + vector code-graph search, grouped by process. | `text`, `repo?`, `limit?` |
| `context` | 360-degree view of one symbol: callers, callees, processes. | `symbol`, `repo?` |
| `impact` | Change-impact blast radius with risk tier. | `symbol`, `depth?`, `direction?`, `repo?` |
| `pack_codebase` | Pack a repo into an LLM-ready snapshot (repomix). | `path?`, `style?` |
| `sql` | Read-only SQL against the graph store; 5 s timeout. | `query`, `repo?` |

## Change analysis

| Tool | Purpose | Primary inputs |
|---|---|---|
| `detect_changes` | Map a git diff to indexed symbols and processes. | `scope?`, `compareRef?`, `repo?`, `strict?` |
| `rename` | Coordinated multi-file symbol rename with confidence-tagged edits. | `from`, `to`, `repo?`, `dryRun?` |
| `list_dead_code` | List dead and unreachable-export symbols. | `repo?` |
| `remove_dead_code` | Remove dead symbols from disk. | `repo?`, `targets` |

## Findings and verdict

| Tool | Purpose | Primary inputs |
|---|---|---|
| `scan` | Run Priority-1 scanners and ingest findings. | `scanners?`, `severity?`, `repo?` |
| `list_findings` | List SARIF findings for a repo. | `repo?`, `severity?` |
| `list_findings_delta` | Diff SARIF findings against a baseline. | `baseline`, `repo?` |
| `verdict` | 5-tier PR verdict. | `base?`, `head?`, `repo?` |
| `risk_trends` | Per-community risk trend plus 30-day projection. | `repo?` |

## Routes and contracts

| Tool | Purpose | Primary inputs |
|---|---|---|
| `route_map` | Map HTTP routes to handlers and consumers. | `repo?` |
| `api_impact` | Route change blast radius. | `route`, `repo?` |
| `shape_check` | Route response-shape mismatch check. | `route`, `repo?` |
| `tool_map` | Map MCP tool definitions defined in the repo. | `repo?` |

## Cross-repo groups

| Tool | Purpose | Primary inputs |
|---|---|---|
| `group_list` | List cross-repo groups on this machine. | — |
| `group_query` | Cross-repo BM25 + RRF search. | `group`, `text`, `limit?` |
| `group_status` | Staleness and last-sync report for a group. | `group` |
| `group_contracts` | Cross-repo HTTP contracts plus cross-links. | `group` |
| `group_sync` | Rebuild the cross-repo contract registry. | `group` |

## Metadata

| Tool | Purpose | Primary inputs |
|---|---|---|
| `project_profile` | Summary profile for the repo (language mix, entry points, owners). | `repo?` |
| `dependencies` | List external dependencies. | `repo?` |
| `license_audit` | Audit dependency licenses against the allowlist. | `repo?` |
| `owners` | List owners for a node. | `node`, `repo?` |

## See also

- [MCP overview](/opencodehub/mcp/overview/) — server name, transport,
  envelope conventions.
- [Error codes](/opencodehub/reference/error-codes/) — the fixed error
  envelope under `structuredContent.error`.
- [Resources](/opencodehub/mcp/resources/) — structured views
  alongside the tools.
