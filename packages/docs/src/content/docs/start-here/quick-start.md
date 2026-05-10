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

## 2. Install toolchain, build, and link the CLI

```bash title="install toolchain, deps, build, and link `codehub`"
mise install
pnpm install --frozen-lockfile
pnpm -r build
mise run cli:link          # puts `codehub` on your PATH
```

See [Install](/opencodehub/start-here/install/) for the non-mise path
and for the `cli:install-global` tarball alternative.

:::note[Haven't linked the CLI?]
Every `codehub <subcommand>` example below assumes `mise run cli:link`
has run (or the packed tarball is installed via `mise run cli:install-global`).
If you prefer not to link, replace `codehub` with
`node packages/cli/dist/index.js` in every command — same arguments,
same behaviour.
:::

## 3. Bootstrap a repo in one command

The simplest on-ramp is `codehub init`. Run it inside any repository
you want to index:

```bash title="one-command bootstrap — project-scope plugin + .mcp.json + .gitignore + policy starter"
codehub init
```

`init` does four things atomically:

1. Copies the OpenCodeHub plugin assets into `<repo>/.claude/` —
   `skills/`, `agents/`, `commands/`, `hooks/`, and a project-scope
   `settings.json` with the hook tokens rewritten from
   `${CLAUDE_PLUGIN_ROOT}` to `${CLAUDE_PROJECT_DIR}/.claude`.
2. Writes `<repo>/.mcp.json` with an `mcpServers.codehub` entry
   (reuses the same logic as `codehub setup --editors claude-code`).
3. Appends `.codehub/` to `.gitignore` if not already present.
4. Seeds `opencodehub.policy.yaml` (a starter file with every rule
   commented out — uncomment when spec 002 ships the CI verdict
   actions).

Re-running `init` against a repo with conflicts refuses and names each
file; pass `--force` to overwrite. `--skip-mcp` and `--skip-policy`
disable those steps for teams that manage those surfaces elsewhere.

**Team benefit:** once `init` has run and `.claude/` is checked into
git, every teammate who clones the repo gets the plugin automatically.
No per-machine install step.

If you prefer the manual path — just the MCP config, no project-scope
plugin — use the legacy `setup` flow:

```bash title="manual: MCP config only"
codehub setup --editors claude-code
```

## 4. Analyze the current repo

```bash title="run the full indexing pipeline"
codehub analyze
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
codehub impact validateUser --depth 2
```

## Where to next

- [Your first query](/opencodehub/start-here/first-query/) walks through
  `query`, `context`, and `impact` with sample output.
- [MCP tools](/opencodehub/mcp/tools/) lists all 28 tools the server
  exposes.
- [Using with Claude Code](/opencodehub/guides/using-with-claude-code/)
  covers the plugin path (PreToolUse hooks) and the MCP-only path.
