---
title: MCP prompts
description: The MCP prompts surface is intentionally empty — playbooks live as Claude Code skills instead.
sidebar:
  order: 40
---

The `opencodehub` MCP server advertises **0 prompts**. The server
capability block declares `tools` and `resources` only — `prompts` is
not registered, and clients that probe for it get an empty list.

## Why

Two reasons playbook material lives as Claude Code skills rather than
as MCP prompts:

- **Prompts are static.** A canned prompt template can name a
  sequence of tool calls but cannot adapt to repo state, group
  membership, or staleness. The skills system in Claude Code
  (`plugins/opencodehub/skills/`) does adapt — it inspects the graph,
  the diff, and the registry before composing its instructions.
- **MCP-prompt support is uneven across clients.** The Claude Code
  plugin runs everywhere the server runs, and a skill compiled into
  the plugin reaches every supported editor that loads the plugin —
  not just the few clients with a working prompts UI.

## Where the playbooks live

The [skills](/opencodehub/skills/) family in `plugins/opencodehub/`
covers the playbook surface:

| Playbook | Lives at |
|---|---|
| Impact / blast-radius analysis | `codehub-impact-analysis` skill + `verdict` MCP tool |
| PR review | `codehub-pr-review` skill + `codehub-pr-description` skill |
| Codebase exploration | `codehub-exploring` skill + `codehub-onboarding` skill |
| Dependency audit | `dependencies` MCP tool + `license_audit` MCP tool |
| Route / tool map generation | `codehub-document` skill + `route_map` / `tool_map` MCP tools |

Each skill is richer than a static template because it inspects graph
state and dispatches tools dynamically.

If you are on a non-Claude-Code editor and want similar guidance,
follow the [MCP tools](/opencodehub/mcp/tools/) catalog — every skill
boils down to a sequence of tool calls a capable model can run on its
own.
