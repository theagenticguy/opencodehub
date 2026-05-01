# OpenCodeHub — Claude Code plugin

Apache-2.0 code intelligence for coding agents. This plugin wires graph-aware slash commands (`/probe`, `/verdict`, `/owners`, `/audit-deps`, `/rename`), a `code-analyst` subagent, the **artifact-generation skill family** (`codehub-document`, `codehub-pr-description`, `codehub-onboarding`, `codehub-contract-map`) with up to 17 `doc-*` subagents (dispatched as 10 always-on + 4 conditional + 3 cross-repo), and a `PreToolUse` graph-context hook plus two `PostToolUse` hooks (auto-reindex on git mutations + non-blocking docs-staleness hint) — all backed by the `codehub` MCP server.

> Targets Claude Code ≥ the version shipping the plugin/MCP settings format used by `codehub init`. Tested against the current `main` branch; regenerate `.mcp.json` via `codehub init` if incompatibilities appear.

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
- **18 agents** — `code-analyst` for analysis, plus 17 `doc-*` subagents dispatched by `codehub-document`, grouped into six families:
  - **analysis** (3) — `doc-analysis-dead-code`, `doc-analysis-ownership`, `doc-analysis-risk-hotspots`.
  - **architecture** (3) — `doc-architecture-data-flow`, `doc-architecture-module-map`, `doc-architecture-system-overview`.
  - **behavior** (2) — `doc-behavior-processes`, `doc-behavior-state-machines`.
  - **cross-repo** (3, group mode) — `doc-cross-repo-contracts-matrix`, `doc-cross-repo-dependency-flow`, `doc-cross-repo-portfolio-map`.
  - **diagrams** (3) — `doc-diagrams-components`, `doc-diagrams-dependency-graph`, `doc-diagrams-sequences`.
  - **reference** (3) — `doc-reference-cli`, `doc-reference-mcp-tools`, `doc-reference-public-api`.
- **5 slash commands** — `/probe`, `/verdict`, `/owners`, `/audit-deps`, `/rename`.
- **3 hooks** — PreToolUse graph-context augmentation (`Bash|Grep|Glob`); PostToolUse auto-reindex on git mutations; PostToolUse docs-staleness hint.

See [ADR 0007](https://theagenticguy.github.io/opencodehub/architecture/adrs/) for scope rationale and the durable exclusions (no hosted tier, no HTTP MCP, no agent SDK).
