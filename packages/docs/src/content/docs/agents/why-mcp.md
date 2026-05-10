---
title: Why an agent needs OpenCodeHub
description: What an LLM coding agent cannot see without a code graph, and what changes after wiring OpenCodeHub up.
sidebar:
  order: 1
---

import { Card, LinkCard } from "@astrojs/starlight/components";

## What an agent cannot see without it

A coding agent's default tools — Read, Grep, Glob — see one file at a
time. They cannot answer:

- Which symbols call this function across the repo, transitively?
- If I rename this type, which test files and which call sites move?
- What HTTP route is wired to this handler?
- Which services in the group consume this API, and at what version?

These are graph questions. Text search returns false positives (a
matching string in a comment), false negatives (a re-exported symbol
under a different name), and no ranking by structural distance.

OpenCodeHub answers them with a hybrid structural + semantic graph
built from your repo and queried over MCP. The agent gets a
deterministic, blast-radius-aware answer in one tool call.

## Three concrete failure modes

<Card title="1. Missed dependencies" icon="warning">
  Agent edits a function. Its callers in three other packages break at
  runtime because Grep missed the imports re-exported via barrel files.
</Card>

<Card title="2. Broken call chains" icon="warning">
  Agent renames a method. Two stale references in dynamic dispatch sites
  ship to production unchanged because regex rename does not understand
  inheritance.
</Card>

<Card title="3. Blind edits" icon="warning">
  Agent touches a hot path with no idea this function sits on every
  request the API serves. No risk tier, no review escalation, merged.
</Card>

`impact`, `rename --dry-run`, and `verdict` close all three.

## What changes after `codehub init`

The agent gets 29 MCP tools at the next session start, grouped into
four families:

- **Exploration** — `query`, `context`, `impact`, `detect_changes`,
  `rename`, `sql`, `list_repos`. Concept-to-code search; per-symbol
  callers, callees, and processes; blast-radius depth-N.
- **Cross-repo groups** — `group_list`, `group_query`, `group_status`,
  `group_contracts`, `group_cross_repo_links`, `group_sync`. Federate
  the same questions across a named set of repos.
- **Findings and verdicts** — `scan`, `list_findings`,
  `list_findings_delta`, `list_dead_code`, `remove_dead_code`,
  `license_audit`, `verdict`, `risk_trends`. Scanner output, PR
  decisions, license tiers, dead code.
- **HTTP and routing** — `route_map`, `api_impact`, `shape_check`,
  `tool_map`. HTTP routes and handlers; structural drift in payloads;
  CLI/MCP tool surfaces.
- **Meta** — `project_profile`, `dependencies`, `owners`,
  `pack_codebase`. Repo overview, external deps, top contributors,
  deterministic code-pack for context windows.

Every per-repo response includes a `next_steps` array and a
`_meta.codehub/staleness` hint when the index might be behind HEAD.

<LinkCard
  title="Tool decision matrix"
  href="/opencodehub/agents/tool-decision-matrix/"
  description="Pick the right tool for the intent at hand."
/>
