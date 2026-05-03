---
title: MCP overview
description: Server name, transport, capabilities, and ambient conventions for the OpenCodeHub MCP server.
sidebar:
  order: 10
---

OpenCodeHub ships an MCP server that any Model-Context-Protocol client
can connect to over stdio.

## Connection

- **Server name:** `opencodehub`
- **Transport:** stdio (JSON-RPC over stdin/stdout)
- **Launch command:** `codehub mcp`
- **Capabilities:** `tools`, `resources`
- **Tool count:** 28 (registered in `packages/mcp/src/server.ts`)

Clients spawn the `codehub mcp` process and exchange JSON-RPC frames
over its stdio pipes. Signals map to clean exits: `SIGINT` → 130,
`SIGTERM` → 143, stdin close → 0.

## Client setup

Every supported editor has a one-command setup path:

- [Claude Code](/opencodehub/guides/using-with-claude-code/)
- [Cursor](/opencodehub/guides/using-with-cursor/)
- [Codex](/opencodehub/guides/using-with-codex/)
- [Windsurf](/opencodehub/guides/using-with-windsurf/)
- [OpenCode](/opencodehub/guides/using-with-opencode/)

All five use `codehub setup --editors <id>` and write into the
editor's native MCP config location.

## Ambient conventions

The server follows two conventions every client should know.

### Optional `repo` argument

Per-repo tools accept an optional `repo` string. Resolution rules:

- **Exactly one repo in the registry:** `repo` is optional; the server
  infers it.
- **Two or more repos and `repo` omitted:** the tool returns
  `AMBIGUOUS_REPO` in the error envelope with a list of registered
  repos in `hint`.
- **`repo` provided:** the server uses it directly.

### Response envelope

Every successful tool result carries two ambient fields alongside the
tool-specific payload:

- **`next_steps: string[]`** — one-line agent-targeted hints ("call
  `context` on the top result" / "stage edits then call
  `detect_changes`"). Helper: `packages/mcp/src/next-step-hints.ts`.
- **`_meta["codehub/staleness"]`** — populated only when the index
  lags `HEAD`. Carries the staleness envelope so the agent can decide
  whether to trust the result or ask the user to re-run `codehub
  analyze`. Constant: `STALENESS_META_KEY = "codehub/staleness"`.

Error responses instead carry `isError: true`,
`structuredContent.error`, and no payload. See
[error codes](/opencodehub/reference/error-codes/).

## What the server exposes

- **28 tools** — search, navigation, change analysis, findings,
  verdict, routes, cross-repo groups, and metadata. See
  [tools](/opencodehub/mcp/tools/).
- **7 resources** — structured views over repos, clusters, and
  processes. See [resources](/opencodehub/mcp/resources/).
