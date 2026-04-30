---
name: opencodehub-guide
description: "Use when the user asks about OpenCodeHub itself — available MCP tools, resources, graph schema, or workflow reference. Examples: \"What OpenCodeHub tools are available?\", \"How do I query the code graph?\", \"Show me the schema\"."
---

# OpenCodeHub Guide

Quick reference for every OpenCodeHub MCP tool, MCP resource, and the DuckDB-backed graph schema.

## Always Start Here

For any task that touches code understanding, debugging, impact analysis, refactoring, or PR review:

1. Call `mcp__opencodehub__list_repos` — confirm the repo is indexed and pick a `repo` name.
2. Read `codehub://repo/{name}/context` — codebase stats and a staleness envelope.
3. Match the task to a skill below and follow that skill's checklist.

> If the context envelope reports the index is stale, run `codehub analyze` in the terminal first. If it says weights are missing, run `codehub setup --embeddings` to fetch the 768d gte-modernbert-base ONNX weights.

## Skills · analysis

| Task                                          | Skill to read                 |
| --------------------------------------------- | ----------------------------- |
| Understand architecture / "How does X work?"  | `opencodehub-exploring`       |
| Blast radius / "What breaks if I change X?"   | `opencodehub-impact-analysis` |
| Trace bugs / "Why is X failing?"              | `opencodehub-debugging`       |
| Rename / extract / split / restructure        | `opencodehub-refactoring`     |
| Review a PR / "Is this safe to merge?"        | `opencodehub-pr-review`       |
| Tools, resources, schema reference            | `opencodehub-guide` (here)    |

## Skills · artifact factory (spec 001)

These skills produce committed Markdown artifacts — the durable output
Principal engineers ship. See [ADR 0007](../../../docs/adr/0007-artifact-factory.md)
for the scope rationale.

| Task                                          | Skill to invoke               | Trigger phrase                                  |
| --------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| Generate the full doc tree (single or group)  | `codehub-document`            | "document this repo", "regenerate architecture docs" |
| Draft a PR description from the current diff  | `codehub-pr-description`      | "write the PR description", "summarize this branch" |
| Write an onboarding guide with reading order  | `codehub-onboarding`          | "write ONBOARDING.md", "what should a new hire read first" |
| Map inter-repo contracts for a group          | `codehub-contract-map`        | "map the contracts", "show the contract matrix for <group>" |
| Draft an ADR (P1 — not yet shipped)           | `codehub-adr` *(P1 backlog)*  | —                                               |

Fire these directly; do not nest them inside analysis skills. Each is a
standalone artifact producer with its own preconditions and output path.

## Tool Inventory (27 MCP tools)

### Code intelligence (per-repo)

| Tool                          | What it gives you                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `mcp__opencodehub__list_repos`        | Enumerate indexed repos on this machine                                   |
| `mcp__opencodehub__query`             | Hybrid BM25 + vector search over symbols, grouped by process              |
| `mcp__opencodehub__context`           | 360-degree symbol view + `confidenceBreakdown` + `cochanges` side-section |
| `mcp__opencodehub__impact`            | Blast radius with risk tier + `confidenceBreakdown`                       |
| `mcp__opencodehub__detect_changes`    | Map an uncommitted or committed diff to affected symbols and flows        |
| `mcp__opencodehub__rename`            | Graph-assisted multi-file rename; dry-run by default                      |
| `mcp__opencodehub__sql`               | Read-only DuckDB SQL against the graph (5 s timeout)                      |
| `mcp__opencodehub__signature`         | Function signature lookup for a target symbol                             |

### HTTP / RPC surface

| Tool                          | What it gives you                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `mcp__opencodehub__route_map`         | HTTP route inventory (method, path, handler, middleware)                  |
| `mcp__opencodehub__tool_map`          | MCP tool inventory exported by this repo                                  |
| `mcp__opencodehub__shape_check`       | Producer/consumer response-shape mismatches                               |
| `mcp__opencodehub__api_impact`        | HTTP consumer chain + middleware + affected processes for one route       |

### Cross-repo (groups)

| Tool                          | What it gives you                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `mcp__opencodehub__group_list`        | Discover named repo groups                                                |
| `mcp__opencodehub__group_query`       | BM25 fan-out across a group with reciprocal-rank fusion                   |
| `mcp__opencodehub__group_status`      | Per-repo staleness + contract freshness for a group                       |
| `mcp__opencodehub__group_contracts`   | HTTP contract cross-links (consumer FETCHES edge → producer Route)        |

### Supply-chain / PR review (OpenCodeHub differentiators)

| Tool                             | What it gives you                                                              |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `mcp__opencodehub__verdict`              | 5-tier PR decision (`auto_merge` → `block`) with top drivers           |
| `mcp__opencodehub__scan`                 | Run Priority-1 scanners (openWorld — spawns child processes)           |
| `mcp__opencodehub__list_findings`        | Browse SARIF findings produced by `scan` or `ingest-sarif`             |
| `mcp__opencodehub__list_findings_delta`  | Diff latest scan vs. frozen baseline (new / fixed / unchanged / updated) |
| `mcp__opencodehub__list_dead_code`       | Unreferenced exported symbols                                          |
| `mcp__opencodehub__remove_dead_code`     | Scripted removal of dead-code items (dry-run by default)               |
| `mcp__opencodehub__license_audit`        | Copyleft / unknown / proprietary tier check over dependencies          |
| `mcp__opencodehub__dependencies`         | External package list (ecosystem + version + manifest path)            |
| `mcp__opencodehub__owners`               | File/symbol ownership from CODEOWNERS + git blame signal               |
| `mcp__opencodehub__risk_trends`          | Per-community trend lines and 30-day projections                       |
| `mcp__opencodehub__project_profile`      | High-level repo summary (languages, stacks, entry points)              |

## Differentiators to surface in responses

- **`confidenceBreakdown`** — every `context` and `impact` response carries a `{confirmed, heuristic, unknown}` tally. `confirmed` means a SCIP indexer (scip-typescript / scip-python / scip-go / rust-analyzer / scip-java) has confirmed the edge at confidence ≥ 0.95. `heuristic` is tree-sitter or tier-1/tier-2 inference the SCIP oracle has not confirmed. `unknown` is demoted (≤ 0.2) — a SCIP-confirmed edge exists at the same triple and the heuristic carries a `+scip-unconfirmed` reason suffix. Report this breakdown when an agent is about to take a destructive action based on edges.
- **`cochanges` side-section** — `context` includes files historically co-edited with the target (by lift, from the dedicated `cochanges` table). This is a **git-history signal, not call dependencies** — label it that way when you report it. It is excluded from the graph hash.
- **`verdict` + `list_findings` + `list_findings_delta`** — PR review grade is deterministic, not opinion.
- **`license_audit`** + **`risk_trends`** + **`owners`** — first-class audit workflows without writing SQL.

## Resource Inventory

Lightweight reads for navigation (every URI uses the `codehub://` scheme):

| Resource                                       | Content                                     |
| ---------------------------------------------- | ------------------------------------------- |
| `codehub://repos`                              | Registry list: names, roots, graph hashes   |
| `codehub://repo/{name}/context`                | Stats + staleness envelope                  |
| `codehub://repo/{name}/schema`                 | Live node kinds / relation types for `sql`  |

> Cluster and process navigation resources (`codehub://repo/{name}/clusters`, `codehub://repo/{name}/processes`, etc.) are slated for a later wave. Use `sql` against the `nodes` table filtered to `kind = 'Community'` or `kind = 'Process'` in the meantime.

## Graph schema

The graph is a DuckDB-backed store. One unified `nodes` table, one `relations` table, an `embeddings` table, a `cochanges` side table, and `store_meta`.

**Node kinds** (load-bearing order — new kinds are appended):
File, Folder, Function, Class, Method, Interface, Constructor, Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Const, Static, Variable, Property, Record, Delegate, Annotation, Template, Module, CodeElement, Community, Process, Route, Tool.

**Relation types** (append-only):
CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, PROCESS_STEP, HANDLES_ROUTE, FETCHES, HANDLES_TOOL, ENTRY_POINT_OF, WRAPS, QUERIES, REFERENCES, FOUND_IN, DEPENDS_ON, OWNED_BY.

Cochange edges live in a **separate `cochanges` table**, NOT in `relations`. Do not query `relations` for them.

## SQL cheat-sheet (use `mcp__opencodehub__sql`)

All inbound callers of a function by name:

```sql
SELECT caller.name, caller.file_path, caller.start_line, r.confidence, r.reason
FROM relations r
JOIN nodes caller ON caller.id = r.from_id
JOIN nodes callee ON callee.id = r.to_id
WHERE r.type = 'CALLS'
  AND callee.name = 'validateUser'
  AND callee.kind = 'Function'
ORDER BY r.confidence DESC
LIMIT 50;
```

Top communities by cohesion:

```sql
SELECT name, inferred_label, cohesion, symbol_count, keywords
FROM nodes
WHERE kind = 'Community'
ORDER BY cohesion DESC
LIMIT 20;
```

Process entry points:

```sql
SELECT n.name, n.inferred_label, n.step_count, entry.name AS entry_point
FROM nodes n
LEFT JOIN nodes entry ON entry.id = n.entry_point_id
WHERE n.kind = 'Process'
ORDER BY n.step_count DESC;
```

SCIP-confirmed edges only (for strict impact queries):

```sql
SELECT from_id, to_id, type, reason
FROM relations
WHERE confidence >= 0.95
  AND reason LIKE 'scip:%';
```

## Invariants agents must respect

- Every per-repo tool accepts an optional `repo` argument. When exactly one repo is indexed, `repo` is optional. When two or more are indexed and `repo` is omitted, the tool returns `AMBIGUOUS_REPO` — pass `repo` explicitly.
- Every response may carry `_meta.codehub/staleness` when the index is behind HEAD. Surface that to the user when it is present.
- Every response includes a `next_steps` array under `structuredContent`. Use it to pick the next tool without guessing.
- `rename` is dry-run by default — explicitly pass `dry_run: false` to apply edits.
- `scan` has `openWorldHint: true` — it spawns child processes. Do not invoke it on every turn.
