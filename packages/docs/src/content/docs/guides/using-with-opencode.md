---
title: Using with OpenCode
description: Wire the codehub MCP server into OpenCode via codehub setup.
sidebar:
  order: 60
---

OpenCode reads MCP servers from `<project>/opencode.json`. The OpenCode
schema nests servers under a top-level `mcp` key with a `type: "local"`
discriminator. `codehub setup` writes the correct shape for you.

## Wire the MCP server

```bash title="write opencode.json in the current project"
codehub setup --editors opencode
```

The writer merges a `codehub` entry into the existing `mcp` object. The
entry looks like:

```json title="opencode.json"
{
  "mcp": {
    "codehub": {
      "type": "local",
      "command": ["node", "/abs/path/to/opencodehub/packages/cli/dist/index.js", "mcp"],
      "enabled": true
    }
  }
}
```

Reload OpenCode after the first write. The server runs over stdio for
the session.

## Multi-editor setup

`--editors` accepts any comma-separated subset of
`claude-code,cursor,codex,windsurf,opencode`. The default is all five.

```bash title="wire OpenCode alongside Claude Code"
codehub setup --editors opencode,claude-code
```

## Reverting

```bash title="remove only the codehub entry"
codehub setup --editors opencode --undo
```

`--undo` removes only the `codehub` entry from `opencode.json`. Other
MCP servers configured there are left alone.

## Next

- [MCP tools](/opencodehub/mcp/tools/) — the catalogue of 28 tools
  OpenCode will see.
