---
title: Windsurf
description: Wire OpenCodeHub into Windsurf's Cascade agent.
sidebar:
  order: 4
---

import { LinkCard } from "@astrojs/starlight/components";

Windsurf's Cascade agent reads MCP servers from a single user-scope
JSON file.

## Config file

- **User:** `~/.codeium/windsurf/mcp_config.json`

There is no project-scope file for Windsurf — all MCP servers are
user-global.

## Snippet

```json title="~/.codeium/windsurf/mcp_config.json"
{
  "mcpServers": {
    "codehub": {
      "command": "codehub",
      "args": ["mcp"]
    }
  }
}
```

If the file does not exist, create it. If it already lists other MCP
servers, add `codehub` as a sibling key under `mcpServers`.

## Verification

1. Fully restart Windsurf — Cascade only loads MCP servers at boot.
2. Open Cascade in any project.
3. Ask: `which OpenCodeHub tools do you see?`
4. Expect 29 tools under `mcp__opencodehub__*`.

If Cascade reports zero tools, check the MCP server status pane in
Cascade's settings — failed servers list their stderr there. The
common cause is `codehub` not being resolvable from Windsurf's
process; use an absolute path:

```json
{
  "mcpServers": {
    "codehub": {
      "command": "/usr/local/bin/codehub",
      "args": ["mcp"]
    }
  }
}
```

## Caveats

- User-scope only — every project Cascade opens sees `codehub`.
- Restart required after editing the config.
- Windsurf supports stdio MCP servers; OpenCodeHub is stdio, so this
  matches.

<LinkCard
  title="Tool decision matrix"
  href="/opencodehub/agents/tool-decision-matrix/"
  description="Pick the right tool for the intent at hand."
/>
