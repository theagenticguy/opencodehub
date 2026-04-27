---
title: Using with Windsurf
description: Wire the codehub MCP server into Windsurf via codehub setup.
sidebar:
  order: 50
---

Windsurf reads MCP servers from `~/.codeium/windsurf/mcp_config.json`.
`codehub setup` writes the entry for you.

## Wire the MCP server

```bash title="write Windsurf's MCP config"
codehub setup --editors windsurf
```

The writer merges a `codehub` entry into the existing `mcpServers`
object without touching other servers. The entry uses the same shape
as Claude Code and Cursor:

```json title="~/.codeium/windsurf/mcp_config.json"
{
  "mcpServers": {
    "codehub": {
      "command": "node",
      "args": ["/abs/path/to/opencodehub/packages/cli/dist/index.js", "mcp"],
      "env": {}
    }
  }
}
```

Reload Windsurf after the first write so it picks up the new server.
The server runs over stdio for the lifetime of the session.

## Multi-editor setup

`--editors` accepts any comma-separated subset of
`claude-code,cursor,codex,windsurf,opencode`. The default is all five.

```bash title="wire Windsurf alongside Cursor"
codehub setup --editors windsurf,cursor
```

## Reverting

```bash title="remove only the codehub entry"
codehub setup --editors windsurf --undo
```

`--undo` removes only the `codehub` entry. Other Windsurf MCP servers
are left alone.

## Next

- [MCP tools](/opencodehub/mcp/tools/) — the catalogue of 28 tools
  Windsurf will see.
