---
title: Using with Cursor
description: Wire the codehub MCP server into Cursor via codehub setup.
sidebar:
  order: 30
---

Cursor reads MCP servers from `~/.cursor/mcp.json` (global scope, shared
across all Cursor projects). `codehub setup` writes the entry for you.

## Wire the MCP server

```bash title="write ~/.cursor/mcp.json"
codehub setup --editors cursor
```

The writer merges a `codehub` entry into the existing `mcpServers`
object without touching any other servers you may already have wired.

**Prerequisite:** `codehub` must be on your `PATH` — run
`mise run cli:link` from a checkout, or `mise run cli:install-global`
to install the packed tarball. See
[Install](/opencodehub/start-here/install/).

The entry has the same shape as Claude Code's:

```json title="~/.cursor/mcp.json"
{
  "mcpServers": {
    "codehub": {
      "command": "codehub",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

Restart Cursor (or reload the window) after the first write so it picks
up the new server. Cursor spawns the server over stdio and keeps it
alive for the session.

:::note[Fallback for unlinked checkouts]
If you cannot put `codehub` on `PATH`, point Cursor at the CLI's
`dist/` entrypoint instead — same behaviour, longer path:

```json title="~/.cursor/mcp.json (fallback)"
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
:::

## Using the tools

Open Cursor's chat, select a model that supports tool use, and ask
questions like "What is the blast radius of `validateUser`?" or "Find
me everything related to the auth token refresh flow." Cursor will
call the codehub MCP tools directly and return structured results.

See [MCP tools](/opencodehub/mcp/tools/) for the full catalogue of 28
tools.

## Multi-editor setup

`--editors` accepts any comma-separated subset of
`claude-code,cursor,codex,windsurf,opencode`. The default is all five.

```bash title="wire Cursor alongside Claude Code"
codehub setup --editors cursor,claude-code
```

## Reverting

```bash title="remove only the codehub entry"
codehub setup --editors cursor --undo
```

`--undo` removes only the `codehub` entry from `~/.cursor/mcp.json`.
Other MCP servers are left alone.
