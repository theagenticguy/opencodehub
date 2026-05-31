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
object without touching other servers.

**Prerequisite:** `codehub` must be on your `PATH` — run
`mise run cli:link` from a checkout, or `mise run cli:install-global`
to install the packed tarball. See
[Install](/opencodehub/start-here/install/).

The entry uses the same shape as Claude Code and Cursor:

```json title="~/.codeium/windsurf/mcp_config.json"
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

Reload Windsurf after the first write so it picks up the new server.
The server runs over stdio for the lifetime of the session.

:::note[Fallback for unlinked checkouts]
If you cannot put `codehub` on `PATH`, point Windsurf at the CLI's
`dist/` entrypoint instead — same behaviour, longer path:

```json title="~/.codeium/windsurf/mcp_config.json (fallback)"
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
