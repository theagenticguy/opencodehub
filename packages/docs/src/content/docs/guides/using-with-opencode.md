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

The writer merges a `codehub` entry into the existing `mcp` object.

**Prerequisite:** `codehub` must be on your `PATH` — run
`mise run cli:link` from a checkout, or `mise run cli:install-global`
to install the packed tarball. See
[Install](/opencodehub/start-here/install/).

The entry looks like:

```json title="opencode.json"
{
  "mcp": {
    "codehub": {
      "type": "local",
      "command": ["codehub", "mcp"],
      "enabled": true
    }
  }
}
```

Reload OpenCode after the first write. The server runs over stdio for
the session.

:::note[Fallback for unlinked checkouts]
If you cannot put `codehub` on `PATH`, point OpenCode at the CLI's
`dist/` entrypoint instead — same behaviour, longer path:

```json title="opencode.json (fallback)"
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
:::

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
