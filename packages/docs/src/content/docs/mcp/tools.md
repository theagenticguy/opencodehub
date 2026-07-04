---
title: MCP tools
description: All 29 MCP tools the opencodehub server registers, grouped by functional family. Every tool is read-only with respect to user source.
sidebar:
  order: 20
---

The `opencodehub` MCP server registers **29 tools**, imported and
invoked from `packages/mcp/src/server.ts`. The number is taken live
from `buildServer()` at startup. Every tool is **read-only with respect
to user source** — no tool edits the working tree.

Every per-repo tool accepts an optional `repo` argument (registry
name) or `repo_uri` alias (Sourcegraph-style URI). See
[MCP overview](/opencodehub/mcp/overview/) for the resolution rules
and the `AMBIGUOUS_REPO` envelope.

The agent-friendly machine-readable catalog (same content, JSON shape)
is published at
[`/tool-catalog.json`](/opencodehub/tool-catalog.json) so a coding
agent can `fetch` the catalog directly.

## Exploration (7)

The high-frequency tools. Most agent loops live here.

### `list_repos`

| | |
|---|---|
| **Use when** | The agent does not know what repos are indexed on the host. Always cheap. |
| **Avoid when** | You already know the target repo — pass `repo_uri` directly. |
| **Inputs** | — (no arguments) |
| **Returns** | `{ repos: [{ name, repo_uri, default_branch, group?, root, indexed_at, graph_hash }] }` |

### `query`

| | |
|---|---|
| **Use when** | You want symbols, files, or communities for a natural-language phrase. The result is grouped by execution-flow process. |
| **Avoid when** | You need precise callers/callees of a known symbol — call `context` instead. |
| **Inputs** | `text` (required), `repo?`, `repo_uri?`, `limit?`, `granularity?: "symbol" \| "file" \| "community"`, `bm25_only?`, `goal?`, `context?` |
| **Returns** | `{ processes: [{ name, steps, files }], symbols: [{ id, name, file_path, kind, score }], next_steps }` |

### `context`

| | |
|---|---|
| **Use when** | You have a specific symbol and need its callers, callees, ACCESSES edges, and the processes it participates in. |
| **Avoid when** | You only have a fuzzy concept — call `query` first. |
| **Inputs** | `symbol` (required), `repo?`, `repo_uri?`, `file_path?`, `kind?` |
| **Returns** | `{ target, callers, callees, accesses, processes, next_steps }` |

### `impact`

| | |
|---|---|
| **Use when** | You're about to edit a symbol and need the blast radius (dependents, processes, risk tier). |
| **Avoid when** | Your change is purely additive (new file, new function with no callers). |
| **Inputs** | `symbol` (required), `repo?`, `repo_uri?`, `depth?` (default 3), `direction?: "up" \| "down" \| "both"` |
| **Returns** | `{ target, direct_callers, transitive_callers, affected_processes, risk: "LOW" \| "MEDIUM" \| "HIGH" \| "CRITICAL", confidence, next_steps }` |

### `detect_changes`

| | |
|---|---|
| **Use when** | The agent has a staged or compared diff and needs the affected symbols, files, and processes with risk tiers. |
| **Avoid when** | The tree is clean (the tool refuses with a helpful error). |
| **Inputs** | `repo?`, `repo_uri?`, `scope?: "unstaged" \| "staged" \| "all" \| "compare"` (default `all`), `compare_ref?`, `strict?` |
| **Returns** | `{ symbols, files, processes, max_risk, next_steps }` |

### `sql`

| | |
|---|---|
| **Use when** | You need a custom view of `store.sqlite` that no other tool exposes. Everything is directly SQL-queryable: `nodes`, `edges`, `embeddings`, `cochanges`, `symbol_summaries`, and `store_meta` (ADR 0019); reach kind-specific fields via SQLite JSON1, `payload->>'$.field'`. Read-only. 5-second timeout. |
| **Avoid when** | A typed tool (`context`, `impact`, `query`) already covers the question. The typed tools stay the high-level path; the `cypher` arg is reserved for community-fork graph adapters and is not supported by the default backend. |
| **Inputs** | `query` (required), `repo?`, `repo_uri?` |
| **Returns** | `{ rows: [...], row_count, next_steps }` |

### `signature`

| | |
|---|---|
| **Use when** | You want a symbol's shape without reading the whole file — a class/interface declaration plus its method and property signatures with bodies elided (stub syntax per language). For a standalone function, returns a single signature. |
| **Avoid when** | You need callers/callees — call `context` instead. |
| **Inputs** | `name?`, `uid?`, `file_path?`, `kind?`, `repo?`, `repo_uri?` (one of `name` or `uid` is required) |
| **Returns** | `{ target, language, member_count, members, stub, next_steps }` |

## Group / federation (6)

Cross-repo tools. Backed by the typed `Repo` graph node and the group
registry (ADR 0012). Every group tool emits `repo_uri` in the canonical
form so a follow-up `AMBIGUOUS_REPO` retry can use it as input.

### `group_list`

| | |
|---|---|
| **Use when** | The agent does not know which groups are configured. |
| **Inputs** | — |
| **Returns** | `{ groups: [{ name, description?, member_repo_uris }] }` |

### `group_query`

| | |
|---|---|
| **Use when** | One BM25/vector query over an entire fleet of repos. Fused with reciprocal-rank fusion (RRF). |
| **Inputs** | `group`, `text`, `limit?` (default 20) |
| **Returns** | `{ group, results: [{ repo_uri, hits: [...] }], next_steps }` |

### `group_status`

| | |
|---|---|
| **Use when** | Per-repo staleness audit before relying on cross-repo answers. |
| **Inputs** | `group` |
| **Returns** | `{ group, repos: [{ repo_uri, indexed_at, graph_hash, staleness_lag_commits }] }` |

### `group_contracts`

| | |
|---|---|
| **Use when** | You need the cross-repo HTTP contract matrix (consumer ↔ producer routes). |
| **Inputs** | `group` |
| **Returns** | `{ contracts: [{ producer_repo_uri, route, consumer_repo_uri, handler }], unresolved_fetches }` |

### `group_cross_repo_links`

| | |
|---|---|
| **Use when** | You need the audit trail of every cross-repo edge with a typed source/target. |
| **Inputs** | `group` |
| **Returns** | `{ links: [{ source_repo_uri, target_repo_uri, source_doc_path, target_doc_path, relation }] }` |

### `group_sync`

| | |
|---|---|
| **Use when** | After a group member has been re-indexed, rebuild the cross-repo contract registry and link table. |
| **Inputs** | `group` |
| **Returns** | `{ group, contracts_written, cross_links_written, next_steps }` |

## Scan / findings / verdict (8)

`scan` is the only tool that spawns processes (`openWorldHint=true`).
`verdict` exits 0/1/2/3 by tier — the canonical source of CI signal.

### `scan`

| | |
|---|---|
| **Use when** | You want fresh SARIF findings for the repo. Picks scanners from the project profile or an explicit list. |
| **Inputs** | `repo?`, `repo_uri?`, `scanners?: string[]`, `severity?: string[]`, `concurrency?`, `timeout_ms?` |
| **Returns** | `{ scanners_run, sarif_path, summary: { by_tool, by_level }, next_steps }` |

### `list_findings`

| | |
|---|---|
| **Use when** | Browse findings without re-running scanners. |
| **Inputs** | `repo?`, `repo_uri?`, `severity?`, `tool?` |
| **Returns** | `{ findings: [{ rule_id, severity, file_path, start_line, message, fingerprint }], next_steps }` |

### `list_findings_delta`

| | |
|---|---|
| **Use when** | Diff the current scan against a frozen baseline. |
| **Inputs** | `baseline` (path), `repo?`, `repo_uri?` |
| **Returns** | `{ new, fixed, unchanged, updated, next_steps }` |

### `list_dead_code`

| | |
|---|---|
| **Use when** | Find symbols with zero in-graph references and dead exports. |
| **Inputs** | `repo?`, `repo_uri?` |
| **Returns** | `{ candidates: [{ id, name, file_path, kind, reason }] }` |

### `license_audit`

| | |
|---|---|
| **Use when** | Tier the dependency license posture: copyleft / unknown / proprietary / permissive. |
| **Inputs** | `repo?`, `repo_uri?` |
| **Returns** | `{ tiers: { permissive, copyleft, unknown, proprietary }, dependencies, next_steps }` |

### `verdict`

| | |
|---|---|
| **Use when** | One PR-level decision tier. Wraps `detect_changes` + `impact` + findings + owners. |
| **Inputs** | `repo?`, `repo_uri?`, `base?` (default `main`), `head?` (default `HEAD`) |
| **Returns** | `{ tier: "auto_merge" \| "single_review" \| "dual_review" \| "expert_review" \| "block", exit_code, reasons, signals }` |

### `change_pack`

| | |
|---|---|
| **Use when** | A CI agent needs everything a diff touches in one deterministic, read-only payload: the changed symbols, their upstream impacted subgraph, the `verdict` tier, the affected tests, and a token-cost estimate. |
| **Inputs** | `repo?`, `repo_uri?`, `base?` (default `main`), `head?` (default `HEAD`), `depth?` (upstream traversal, default 4), `budget?` (context budget in heuristic tokens, default 100000) |
| **Returns** | `{ changed, impacted_subgraph, verdict, affected_tests, cost_estimate }` — the same `ChangePack` the CLI's `codehub change-pack --json` emits, snake-cased under `structuredContent`. |

### `risk_trends`

| | |
|---|---|
| **Use when** | Per-community risk trend lines plus a 30-day projection. |
| **Inputs** | `repo?`, `repo_uri?` |
| **Returns** | `{ communities: [{ id, name, trend, projection_30d, drivers }] }` |

## HTTP / routing (4)

For services. Each tool is a thin slice over the `Route` graph node and
its consumers.

### `route_map`

| | |
|---|---|
| **Use when** | List every HTTP route in the repo with its handler and known consumers. |
| **Inputs** | `repo?`, `repo_uri?` |
| **Returns** | `{ routes: [{ method, path, handler, consumers, framework }] }` |

### `api_impact`

| | |
|---|---|
| **Use when** | Blast radius for a route change. Walks `FETCHES` edges across repos when the repo is in a group. |
| **Inputs** | `route`, `repo?`, `repo_uri?` |
| **Returns** | `{ route, direct_consumers, transitive_consumers, risk, next_steps }` |

### `shape_check`

| | |
|---|---|
| **Use when** | Validate that callers expect the response shape the handler currently returns. |
| **Inputs** | `route`, `repo?`, `repo_uri?` |
| **Returns** | `{ route, mismatches: [{ consumer, expected, actual }], next_steps }` |

### `tool_map`

| | |
|---|---|
| **Use when** | List MCP tools defined in the repo (for repos that ship their own MCP server). |
| **Inputs** | `repo?`, `repo_uri?` |
| **Returns** | `{ tools: [{ name, file_path, schema, examples }] }` |

## Meta (4)

### `project_profile`

| | |
|---|---|
| **Use when** | One-shot summary of language mix, entry points, top processes, owners. |
| **Inputs** | `repo?`, `repo_uri?` |
| **Returns** | `{ languages, entry_points, top_processes, top_owners, frameworks, ia_types, api_contracts }` |

### `dependencies`

| | |
|---|---|
| **Use when** | Dependency inventory (production + dev). |
| **Inputs** | `repo?`, `repo_uri?` |
| **Returns** | `{ production, development, peer, by_package_manager }` |

### `owners`

| | |
|---|---|
| **Use when** | Top contributors for a node (file, symbol). |
| **Inputs** | `node`, `repo?`, `repo_uri?` |
| **Returns** | `{ owners: [{ name, email, share, last_touch }], bus_factor }` |

### `pack_codebase`

| | |
|---|---|
| **Use when** | Produce a deterministic LLM-ready code-pack snapshot of the repo (powered by the bundled deterministic pack). |
| **Inputs** | `repo?`, `repo_uri?`, `path?`, `style?: "xml" \| "markdown" \| "json" \| "plain"`, `compress?`, `remove_comments?` |
| **Returns** | `{ output_path, item_count, total_chars, token_estimate, next_steps }` |

## See also

- [MCP overview](/opencodehub/mcp/overview/) — server name, transport,
  envelope conventions, and the `AMBIGUOUS_REPO` retry pattern.
- [Error codes](/opencodehub/reference/error-codes/) — the structured
  error envelope under `structuredContent.error`.
- [Resources](/opencodehub/mcp/resources/) — structured views
  alongside the tools.
- [Tool catalog (JSON)](/opencodehub/tool-catalog.json) —
  machine-readable form an agent can `fetch`.
