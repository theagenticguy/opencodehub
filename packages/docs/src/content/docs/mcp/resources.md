---
title: MCP resources
description: The seven MCP resources the opencodehub server publishes.
sidebar:
  order: 30
---

The `opencodehub` MCP server publishes seven resources alongside its
tools. Clients that honour MCP resources (Claude Code, Cursor) can
read them directly; clients that do not can usually reach the same
data via the corresponding tool.

| URI | Purpose |
|---|---|
| `codehub://repos` | All repos registered on this machine. |
| `codehub://repo-context` | High-level profile for one repo: language mix, entry points, top processes. |
| `codehub://repo-schema` | The graph schema (node kinds, edge kinds) for one repo. |
| `codehub://repo-clusters` | All clusters (communities) detected for one repo. |
| `codehub://repo-cluster` | One cluster with its members and connecting edges. |
| `codehub://repo-processes` | All execution-flow processes detected for one repo. |
| `codehub://repo-process` | One process with its ordered steps, files, and participating symbols. |

Each resource returns JSON. Implementations live under
`packages/mcp/src/resources/`.
