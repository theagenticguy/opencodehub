---
title: MCP prompts
description: The MCP prompts surface is intentionally empty in v1 — the canned-prompt playbooks moved to skills.
sidebar:
  order: 40
---

The `opencodehub` MCP server v1 advertises **0 prompts**. The server
capability block declares `tools` and `resources` only — `prompts` is
not registered, and clients that probe for it get an empty list.

## Why

Earlier prereleases of OpenCodeHub shipped five canned prompts
(`detect-impact`, `review-pr`, `explore-area`, `audit-dependencies`,
`generate-map`). Each was a multi-step playbook the agent could invoke
to drive a structured task. Two problems shaped the v1 decision to
remove them:

- **Prompts are static.** A canned prompt template can name a
  sequence of tool calls but cannot adapt to repo state, group
  membership, or staleness. The skills system in Claude Code
  (`plugins/opencodehub/skills/`) does adapt — it inspects the graph,
  the diff, and the registry before composing its instructions.
- **MCP-prompt support is uneven across clients.** The Claude Code
  plugin runs everywhere the server runs, and a skill compiled into
  the plugin reaches every supported editor that loads the plugin —
  not just the few clients with a working prompts UI.

## What replaced them

The prompts surface from prereleases is now the
[skills](/opencodehub/skills/) family in `plugins/opencodehub/`:

| Old prompt | Now lives at |
|---|---|
| `detect-impact` | `opencodehub-impact-analysis` skill + `verdict` MCP tool |
| `review-pr` | `opencodehub-pr-review` skill + `codehub-pr-description` skill |
| `explore-area` | `opencodehub-exploring` skill + `codehub-onboarding` skill |
| `audit-dependencies` | `audit-deps` slash command + `license_audit` MCP tool |
| `generate-map` | `codehub-document` skill + `route_map` / `tool_map` MCP tools |

All five replacements are richer than the originals because they
inspect graph state and dispatch tools dynamically.

If you are on a non-Claude-Code editor and want similar guidance,
follow the [MCP tools](/opencodehub/mcp/tools/) catalog — every skill
boils down to a sequence of tool calls a capable model can run on its
own.
