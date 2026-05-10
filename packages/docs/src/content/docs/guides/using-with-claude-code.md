---
title: Using with Claude Code
description: Wire the codehub MCP server into Claude Code via the plugin or an MCP-only config.
sidebar:
  order: 20
---

There are two ways to connect OpenCodeHub to Claude Code. The **plugin** path
adds a PreToolUse hook that auto-augments rename-class edits with `impact` and
`detect_changes`. The **MCP-only** path wires the server without the hook.

## Plugin (preferred)

```bash title="install the Claude Code plugin"
codehub setup --plugin
```

`--plugin` installs the OpenCodeHub plugin into Claude Code. The plugin
registers a PreToolUse hook that runs before any edit that looks like a
rename or a cross-file refactor. The hook calls `impact` and
`detect_changes`, then feeds the results back to Claude Code as inline
context so the agent can adjust its plan before writing a diff.

The plugin bundles the MCP server wiring too, so you do not need to
also run `setup --editors claude-code`.

## MCP-only

If you prefer the raw MCP connection without the hook:

```bash title="write .mcp.json for the current project"
codehub setup --editors claude-code
```

The writer targets `<project>/.mcp.json` (Claude Code's project scope).

**Prerequisite:** `codehub` must be on your `PATH` — run
`mise run cli:link` from a checkout, or `mise run cli:install-global`
to install the packed tarball. See
[Install](/opencodehub/start-here/install/).

The resulting entry looks like:

```json title=".mcp.json"
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

The server runs over stdio. Claude Code spawns it on demand, sends
JSON-RPC over stdin/stdout, and keeps it alive for the session.

:::note[Fallback for unlinked checkouts]
If you cannot put `codehub` on `PATH`, point the MCP config at the
CLI's `dist/` entrypoint instead — same behaviour, longer path:

```json title=".mcp.json (fallback)"
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

```bash title="wire Claude Code and Cursor together"
codehub setup --editors claude-code,cursor
```

## Reverting

```bash title="remove the codehub entry the last setup wrote"
codehub setup --editors claude-code --undo
```

`--undo` removes only the `codehub` entry; any other `mcpServers`
entries in `.mcp.json` are preserved.

## Next

- [MCP tools](/opencodehub/mcp/tools/) — the full catalogue of 28 tools
  Claude Code will see.
- [MCP overview](/opencodehub/mcp/overview/) — server name, transport,
  envelope conventions.
