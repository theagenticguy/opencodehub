# OpenCodeHub — Claude Code plugin

Apache-2.0 code intelligence for coding agents. This plugin wires five graph-aware slash commands (`/probe`, `/verdict`, `/owners`, `/audit-deps`, `/rename`), a `code-analyst` subagent, and a `PostToolUse` hook that auto-reindexes on `git commit|merge|rebase|pull` — all backed by the `codehub` MCP server (27 tools).

## Install

Install the `codehub` CLI first (`npm i -g @opencodehub/cli` or build from source), run `codehub setup` once to register the MCP server with Claude Code, then run `codehub setup --plugin` to copy this plugin into `~/.claude/plugins/opencodehub/`. Restart Claude Code so it picks up the new commands, agent, and hook. The hook is a no-op until `codehub analyze` has run at least once in the repo.
