---
title: Tool decision matrix
description: Map an agent's intent to the right OpenCodeHub MCP tool, with anti-patterns.
sidebar:
  order: 3
---

import { LinkCard } from "@astrojs/starlight/components";

Use this matrix to pick a tool from an intent. Every tool name resolves
to `mcp__opencodehub__<name>` in the agent's tool namespace. The
anti-pattern column says what _not_ to reach for first.

## Single-repo intents

| Intent | Tool | Why this one | Don't use |
| --- | --- | --- | --- |
| "What does this function do?" | `context` | Returns the symbol's signature, callers, callees, and the processes it participates in — one call. | `query` (returns search hits, not the 360° view); `Read` (you'll miss the call graph). |
| "If I change this, what breaks?" | `impact` | Computes upstream/downstream blast radius up to depth N, with a risk tier. | `Grep` (misses re-exports and dynamic dispatch). |
| "Find me code about X" | `query` | Hybrid BM25 + vector search, results grouped by execution flow. | Embeddings-only search; `Grep` for concepts. |
| "Coordinate a rename across files" | `rename` (dry-run first) | Graph-aware. Catches dynamic dispatch, re-exports, and shadowed locals. | Editor's textual rename; sed; `Edit` per file. |
| "Bundle the codebase for an LLM" | `pack_codebase` | Deterministic 9-item BOM (manifest, skeleton, file-tree, deps, AST chunks, xrefs, optional embeddings, findings, licenses + readme) — byte-identical for the same `(commit, tokenizer, budget)`. | Hand-rolled `cat **/*.ts` blob. |
| "Who owns this file?" | `owners` | Top contributors with commit counts, last-touched dates, lines changed. | `git blame` parsing. |
| "What's the repo's overall shape?" | `project_profile` | One call: language mix, top processes, hotspots, dependencies summary. | Multiple `query` calls. |
| "What external packages do I depend on?" | `dependencies` | Returns the full external-dep list, scoped per package. | Reading `package.json` files manually. |
| "What changed since this commit?" | `detect_changes` | Maps an uncommitted or committed diff to affected symbols and processes. | `git diff` (no graph context). |
| "Run scanners now" | `scan` | Spawns the 20 Priority-1 scanners and writes SARIF. **`openWorld` — only when the user explicitly asks.** | Calling `scan` to "see if anything's wrong" without consent. |
| "Are there security findings on this branch?" | `list_findings_delta` | Diffs the latest scan against the frozen baseline (new / fixed / unchanged / updated). | `list_findings` if you only need the delta. |
| "Show all current findings" | `list_findings` | Filterable by severity, scanner, file. | Re-running `scan` if a recent scan exists. |
| "Is this PR safe to merge?" | `verdict` | 5-tier merge decision: `auto_merge` / `single_review` / `dual_review` / `expert_review` / `block`. Exit codes 0/1/2 from CLI. | Stitching `impact` + `list_findings_delta` by hand. |
| "What HTTP routes does this service expose?" | `route_map` | Method, path, handler, file:line. Works across Express, Fastify, Hono, FastAPI, Flask, Spring, etc. | `Grep` for `app.get(`. |
| "What's the structural shape of this payload?" | `shape_check` | Detects payload/type drift across handlers and clients. | Manual diff of TypeScript interfaces. |
| "What CLI/MCP tools does this codebase ship?" | `tool_map` | Surfaces commander/yargs/click handlers and MCP tool registrations. | Reading every entry-point manually. |
| "What's been deprecated or dead?" | `list_dead_code` | Unreferenced exports, dead functions, orphan files. | `tsc --noUnusedLocals` (catches different things). |
| "Apply the dead-code removal" | `remove_dead_code` | Writes the deletes after a `list_dead_code` review. **Destructive — confirm first.** | Calling `remove_dead_code` without the list_dead_code review step. |
| "What's the license tier of my deps?" | `license_audit` | Tiers each transitive dep: permissive / weak-copyleft / strong-copyleft / proprietary / unknown. | `license-checker` raw output. |
| "Which areas are getting riskier?" | `risk_trends` | Per-community trend lines + 30-day projection from temporal data. | One-off risk snapshots. |
| "Who is changing what most, and where" | `risk_trends` + `owners` | Trends point to communities; `owners` names the people. | Either alone. |
| "Bespoke graph query I can't express above" | `sql` | Read-only SQL against the local graph store, 5s timeout. | When a typed tool covers it — typed tools return `next_steps`. |

## Cross-repo group intents

`group_*` tools require an indexed group. Run `codehub group sync` to
register one. See [Cross-repo groups](/opencodehub/guides/cross-repo-groups/).

| Intent | Tool | Why this one | Don't use |
| --- | --- | --- | --- |
| "Which repos are in my group, and are they fresh?" | `group_list` + `group_status` | Inventory + per-repo staleness. | `list_repos` (single-repo scope). |
| "Search across the whole group" | `group_query` | Fans out BM25 across the group. Returns `{ group, query, results[] }`. | Calling `query` per repo. |
| "Which services consume this API?" | `api_impact` (group) | Edges from API surface to downstream consumers across repos. | `Grep` across cloned repos. |
| "Map the HTTP contract surface across services" | `group_contracts` | Producer/consumer matrix derived from `route_map` + client calls. | Hand-merged Postman collections. |
| "Where does the group share types or DB schemas?" | `group_cross_repo_links` | Cross-repo references — typed shared models, schema imports, etc. | Searching every repo manually. |

## When to chain

Some questions decompose:

- **PR review without `verdict`**: chain `detect_changes` → `impact`
  → `list_findings_delta` → summarize. `verdict` does this in one call
  with a tier; use the chain when you need bespoke shaping.
- **Pre-rename safety**: `context` → `impact` → `rename --dry-run` →
  human review → `rename --apply`.
- **New-engineer onboarding**: `project_profile` → top processes from
  `query` → entry points from `route_map` and `tool_map` →
  `owners` per area. The `codehub-onboarding` skill orchestrates this
  for Claude Code.

<LinkCard
  title="Idiomatic prompts"
  href="/opencodehub/agents/idiomatic-prompts/"
  description="Five worked examples — prompt, tools called, output shape."
/>
