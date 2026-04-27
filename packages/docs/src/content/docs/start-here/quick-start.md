---
title: Quick start
description: Five steps from clone to an agent calling impact over MCP.
sidebar:
  order: 30
---

Five steps from zero to an agent asking the graph for blast radius.

## 1. Clone

```bash title="clone the repo"
git clone https://github.com/theagenticguy/opencodehub
cd opencodehub
```

## 2. Install toolchain and build

```bash title="install toolchain, deps, and build"
mise install
pnpm install --frozen-lockfile
pnpm -r build
```

See [Install](/opencodehub/start-here/install/) for the non-mise path.

## 3. Wire the MCP server into your editor

```bash title="wire Claude Code's .mcp.json to the codehub MCP server"
node packages/cli/dist/index.js setup --editors claude-code
```

`setup` writes an `mcpServers.codehub` entry into `<project>/.mcp.json`
for Claude Code. Pass a comma-separated list to `--editors` for
multiple editors at once (`claude-code,cursor,codex,windsurf,opencode`).
The default is all supported editors.

## 4. Analyze the current repo

```bash title="run the full indexing pipeline"
node packages/cli/dist/index.js analyze
```

`analyze` writes the graph to `.codehub/` under the repo root and
registers the repo in `~/.codehub/registry.json`. Add `--embeddings` to
compute semantic vectors for hybrid search, or `--offline` to guarantee
zero network sockets.

## 5. Ask the agent

Point your agent at the MCP server (Claude Code picks up `.mcp.json`
automatically on the next session). Then ask:

> "Run `impact` on `validateUser` and tell me the blast radius."

The MCP `impact` tool returns a structured response shaped like:

```json title="impact response shape"
{
  "target": "validateUser",
  "direct_callers": 14,
  "affected_processes": 3,
  "risk": "HIGH",
  "next_steps": [
    "call context(validateUser) for caller sites",
    "call detect_changes after staging edits"
  ]
}
```

You can also invoke the same analysis directly from the CLI:

```bash title="CLI equivalent"
node packages/cli/dist/index.js impact validateUser --depth 2
```

## Where to next

- [Your first query](/opencodehub/start-here/first-query/) walks through
  `query`, `context`, and `impact` with sample output.
- [MCP tools](/opencodehub/mcp/tools/) lists all 28 tools the server
  exposes.
- [Using with Claude Code](/opencodehub/guides/using-with-claude-code/)
  covers the plugin path (PreToolUse hooks) and the MCP-only path.
