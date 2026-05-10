---
title: Agents
description: "Wire your coding agent to OpenCodeHub: install, discover tools, use them well."
sidebar:
  order: 0
---

import { Card, CardGrid, LinkCard } from "@astrojs/starlight/components";

OpenCodeHub gives an AI coding agent a code graph it can query: callers,
callees, processes, blast radius, owners, scanner findings, and a 5-tier
PR verdict — all behind 29 MCP tools served by one local binary. The
graph is built deterministically from your repo and stored next to it.

Other docs sections answer "what is OCH" and "how is it built." This
section answers "how does my agent talk to it."

## Who this is for

- An AI coding agent (Claude Code, Cursor, Codex, Windsurf, OpenCode,
  or anything else that speaks MCP) that needs to ground its answers in
  the structure of a codebase.
- The engineer wiring that agent up.

If you are reading this with an LLM in the loop, the rest of this
section is paste-ready. Headings are scannable. Code is first-class.

## 90-second setup

```bash title="install OpenCodeHub once, per-machine"
git clone https://github.com/theagenticguy/opencodehub
cd opencodehub
pnpm install --frozen-lockfile
mise run cli:link        # puts `codehub` on PATH
```

```bash title="wire it into a target repo"
cd /path/to/your/repo
codehub init             # writes .mcp.json + links the Claude Code plugin
codehub analyze          # first index — 30s to a few minutes
```

Restart your editor. Your agent now has 29 MCP tools, all prefixed
`mcp__opencodehub__*`. See [Install](/opencodehub/agents/install/) for
the full path or jump to the per-editor card below.

## Pick your editor

<CardGrid>
  <LinkCard
    title="Claude Code"
    href="/opencodehub/agents/editors/claude-code/"
    description="Plugin + 5 slash commands + code-analyst subagent + 11 skills."
  />
  <LinkCard
    title="Cursor"
    href="/opencodehub/agents/editors/cursor/"
    description="Per-project .cursor/mcp.json — MCP only, no plugin."
  />
  <LinkCard
    title="Codex"
    href="/opencodehub/agents/editors/codex/"
    description="codex.toml MCP entry — paste once, works in CLI and IDE."
  />
  <LinkCard
    title="Windsurf"
    href="/opencodehub/agents/editors/windsurf/"
    description="mcp_config.json — Cascade can call all 29 tools after restart."
  />
  <LinkCard
    title="OpenCode"
    href="/opencodehub/agents/editors/opencode/"
    description="opencode.json — local stdio, zero auth."
  />
</CardGrid>

## What's in this section

<CardGrid>
  <LinkCard
    title="Why MCP"
    href="/opencodehub/agents/why-mcp/"
    description="What an agent cannot see without a code graph."
  />
  <LinkCard
    title="Install"
    href="/opencodehub/agents/install/"
    description="Generic install path that works for any MCP-speaking agent."
  />
  <LinkCard
    title="Tool decision matrix"
    href="/opencodehub/agents/tool-decision-matrix/"
    description="Intent in, tool out. Anti-patterns called out."
  />
  <LinkCard
    title="Idiomatic prompts"
    href="/opencodehub/agents/idiomatic-prompts/"
    description="Five copy-paste prompts that get great use out of OCH."
  />
  <LinkCard
    title="Discovery and resources"
    href="/opencodehub/agents/discovery-and-resources/"
    description="Where agents and operators find OCH on the open web."
  />
  <LinkCard
    title="MCP registries"
    href="/opencodehub/agents/registries/"
    description="One-click install paths via Smithery and friends."
  />
  <LinkCard
    title="llms.txt cheatsheet"
    href="/opencodehub/agents/llms-txt-cheatsheet/"
    description="Which crawlable bundle to feed an agent in which scenario."
  />
</CardGrid>
