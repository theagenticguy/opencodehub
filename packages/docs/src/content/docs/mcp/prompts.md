---
title: MCP prompts
description: The five pre-baked prompts the opencodehub server ships.
sidebar:
  order: 40
---

The `opencodehub` MCP server registers five prompts. Each one is a
pre-baked playbook the agent can invoke to drive a multi-step task
with the right tool-call sequence and the right framing.

| Prompt | Purpose |
|---|---|
| `detect-impact` | Walk a staged or compared diff through `detect_changes` → `impact` → `verdict`, then summarise risk. |
| `review-pr` | Structured PR review: findings, risk, route and contract diffs, and a recommended verdict tier. |
| `explore-area` | Onboard the agent to an unfamiliar part of the repo via `query` and `context`, grouped by process. |
| `audit-dependencies` | Inventory dependencies with `dependencies` and `license_audit`, flag license outliers, list high-risk packages. |
| `generate-map` | Emit a Markdown map of the repo (modules, routes, MCP tools) using `route_map`, `tool_map`, and clusters. |

Implementations live under `packages/mcp/src/prompts/`.
