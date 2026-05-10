---
title: MCP overview
description: Server name, transport, capabilities, the four tool families, and the ambient envelope conventions for the OpenCodeHub MCP server.
sidebar:
  order: 10
---

OpenCodeHub ships an MCP server that any Model-Context-Protocol client
can connect to over stdio.

## Connection

- **Server name:** `opencodehub`
- **Transport:** stdio (JSON-RPC over stdin/stdout)
- **Launch command:** `codehub mcp`
- **Capabilities:** `tools` and `resources`. The server does not
  advertise `prompts` — the canned-prompts surface was removed in v1
  in favour of the Claude Code plugin's skills.
- **Tool count:** 29 (registered in `packages/mcp/src/server.ts`)

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

## The four tool families

The 29 tools fall into four functional clusters plus a meta cluster.
The full per-tool catalog is in [MCP tools](/opencodehub/mcp/tools/).

| Family | Tools | Count |
|---|---|---|
| Exploration | `list_repos`, `query`, `context`, `impact`, `detect_changes`, `rename`, `sql` | 7 |
| Group / federation | `group_list`, `group_query`, `group_status`, `group_contracts`, `group_cross_repo_links`, `group_sync` | 6 |
| Scan / findings / verdict | `scan`, `list_findings`, `list_findings_delta`, `list_dead_code`, `remove_dead_code`, `license_audit`, `verdict`, `risk_trends` | 8 |
| HTTP / routing | `route_map`, `api_impact`, `shape_check`, `tool_map` | 4 |
| Meta | `project_profile`, `dependencies`, `owners`, `pack_codebase` | 4 |

## Ambient conventions

The server follows two conventions every client should know.

### Optional `repo` argument and `repo_uri` alias

Per-repo tools accept an optional `repo` (registry name) or `repo_uri`
(Sourcegraph-style URI such as `github.com/org/repo`, or
`local:<hash>` for unpublished repos). When both are supplied,
`repo_uri` wins. Resolution rules:

- **Exactly one repo in the registry:** both arguments are optional;
  the server infers the target.
- **Two or more repos and neither argument supplied:** the tool returns
  the structured `AMBIGUOUS_REPO` envelope under
  `structuredContent.error` with a `choices[]` array (capped at 10)
  carrying `{repo_uri, default_branch, group}` plus `total_matches`,
  so a caller can retry deterministically.
- **One of the two arguments provided:** the server uses it directly.

See [error codes](/opencodehub/reference/error-codes/) for the exact
envelope shape.

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
`structuredContent.error`, and no payload.

## What the server exposes

- **29 tools** — exploration, federation, scan/findings, HTTP routing,
  and metadata. See [tools](/opencodehub/mcp/tools/).
- **7 resources** — structured views over repos, clusters, and
  processes. See [resources](/opencodehub/mcp/resources/).
- **0 prompts** — the v1 surface is intentionally empty. The
  pre-baked playbooks formerly served from `prompts/` now live as
  Claude Code [skills](/opencodehub/skills/) shipped by
  `plugins/opencodehub/`. See [prompts](/opencodehub/mcp/prompts/) for
  the rationale.
