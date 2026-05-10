---
title: Codex
description: Wire OpenCodeHub into the OpenAI Codex CLI and IDE extensions.
sidebar:
  order: 3
---

import { LinkCard, Tabs, TabItem } from "@astrojs/starlight/components";

The OpenAI Codex CLI and the Codex IDE extensions share the same
TOML config. Pick user scope (default) or project scope. Codex is
stdio-only for MCP servers as of mid-2026.

## Config file

- **User:** `~/.codex/config.toml`
- **Project (trusted projects only):** `.codex/config.toml`

## Add via CLI helper

```bash title="adds the entry under [mcp_servers.codehub]"
codex mcp add codehub -- codehub mcp
```

This is the recommended path — the helper writes the right TOML shape
and validates the entry.

## Or edit TOML directly

```toml title="~/.codex/config.toml"
[mcp_servers.codehub]
command = "codehub"
args = ["mcp"]
# enabled = true     # default true
# required = false   # set true to fail Codex startup if the server can't init
# env = { LOG_LEVEL = "info" }
```

`mcp_servers` is a table — each server is `[mcp_servers.<name>]`.
`required = true` makes the server load a hard dependency: useful in
CI, dangerous in interactive use.

## Verification

```bash title="list registered servers"
codex mcp list
```

Look for `codehub` in the output. Then in a Codex session, ask the
agent which OpenCodeHub tools it sees — expect 29.

## Caveats

- **stdio only.** The Codex CLI does not support remote (HTTP / SSE)
  MCP servers as of May 2026. OpenCodeHub is stdio, so this matches.
- The Codex CLI and IDE extensions read the same `config.toml` — wire
  it once, both pick it up.
- `.codex/config.toml` only loads from projects on the trusted-projects
  list. Add the project with `codex trust add .` if needed.

<LinkCard
  title="Idiomatic prompts"
  href="/opencodehub/agents/idiomatic-prompts/"
  description="Five copy-paste prompts to test the wiring."
/>
