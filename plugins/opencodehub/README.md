# OpenCodeHub — Claude Code plugin

Apache-2.0 code intelligence for coding agents. This plugin wires graph-aware slash commands (`/probe`, `/verdict`, `/owners`, `/audit-deps`, `/rename`), a `code-analyst` subagent, the **artifact-generation skill family** (`codehub-document`, `codehub-pr-description`, `codehub-onboarding`, `codehub-contract-map`) with six `doc-*` subagents, and two `PostToolUse` hooks (auto-reindex on git mutations + non-blocking docs-staleness hint) — all backed by the `codehub` MCP server.

## Install

### Recommended: `codehub init` (project scope)

From inside any repo you want to bootstrap:

```bash
codehub init
```

This copies every plugin asset into `<repo>/.claude/`, writes `<repo>/.mcp.json` so Claude Code launches the `codehub` MCP server, appends `.codehub/` to `.gitignore`, and seeds an `opencodehub.policy.yaml` starter. Check `.claude/` into git and every teammate gets the plugin automatically on clone.

Then analyze the repo and restart Claude Code:

```bash
codehub analyze .
# restart Claude Code so it picks up .claude/ and .mcp.json
```

See the [`codehub init` docs](https://theagenticguy.github.io/opencodehub/start-here/codehub-init/) for flags (`--force`, `--skip-mcp`, `--skip-policy`) and idempotence guarantees.

### Alternative: user scope (global)

If you want the plugin on every repo automatically, without checking `.claude/` into individual repos:

```bash
codehub setup                # writes MCP config for every supported editor
codehub setup --plugin       # copies this plugin to ~/.claude/plugins/opencodehub/
```

Restart Claude Code so it picks up the new commands, agent, skills, and hooks. The auto-reindex hook is a no-op until `codehub analyze` has run at least once in each repo.

## What ships

- **10 skills** — 4 artifact-factory (`codehub-document`, `codehub-pr-description`, `codehub-onboarding`, `codehub-contract-map`) + 6 analysis (`opencodehub-guide`, `opencodehub-exploring`, `opencodehub-impact-analysis`, `opencodehub-debugging`, `opencodehub-refactoring`, `opencodehub-pr-review`).
- **7 agents** — `code-analyst` for analysis, six `doc-*` subagents dispatched by `codehub-document`.
- **5 slash commands** — `/probe`, `/verdict`, `/owners`, `/audit-deps`, `/rename`.
- **2 hooks** — PreToolUse graph-context augmentation; PostToolUse auto-reindex + docs-staleness hint.

See [ADR 0007](https://theagenticguy.github.io/opencodehub/architecture/adrs/) for scope rationale and the durable exclusions (no hosted tier, no HTTP MCP, no agent SDK).
