---
title: Using with Codex
description: Wire the codehub MCP server into OpenAI Codex via codehub setup.
sidebar:
  order: 40
---

Codex reads its MCP config from `~/.codex/config.toml`. It is the only
one of the five supported editors that uses TOML instead of JSON.
`codehub setup` writes the correct TOML block for you.

## Wire the MCP server

```bash title="write ~/.codex/config.toml"
codehub setup --editors codex
```

The writer merges a `[mcp_servers.codehub]` table into the existing
TOML without touching other tables.

**Prerequisite:** `codehub` must be on your `PATH` — run
`mise run cli:link` from a checkout, or `mise run cli:install-global`
to install the packed tarball. See
[Install](/opencodehub/start-here/install/).

The resulting block looks like:

```toml title="~/.codex/config.toml"
[mcp_servers.codehub]
command = "codehub"
args = ["mcp"]
```

Restart Codex after the first write so it picks up the new server.
Codex spawns the server over stdio and keeps it alive for the session.

:::note[Fallback for unlinked checkouts]
If you cannot put `codehub` on `PATH`, point Codex at the CLI's
`dist/` entrypoint instead — same behaviour, longer path:

```toml title="~/.codex/config.toml (fallback)"
[mcp_servers.codehub]
command = "node"
args = ["/abs/path/to/opencodehub/packages/cli/dist/index.js", "mcp"]
```
:::

## Multi-editor setup

`--editors` accepts any comma-separated subset of
`claude-code,cursor,codex,windsurf,opencode`. The default is all five.

```bash title="wire Codex alongside Claude Code"
codehub setup --editors codex,claude-code
```

## Reverting

```bash title="remove only the codehub entry"
codehub setup --editors codex --undo
```

`--undo` removes only the `[mcp_servers.codehub]` table. Other Codex
MCP servers are left alone.

## Next

- [MCP tools](/opencodehub/mcp/tools/) — the catalogue of 28 tools
  Codex will see.
