---
title: codehub init — bootstrap a repo
description: One command that wires .claude/, .mcp.json, .gitignore, and a policy starter.
sidebar:
  order: 35
---

`codehub init` is the one-command on-ramp. Run it inside any repo you
want OpenCodeHub to cover. It installs a project-scope Claude Code
plugin, writes the `.mcp.json` entry, appends `.codehub/` to
`.gitignore`, and seeds a policy starter.

**Project scope on purpose.** Everything lands under the repo root
(not `~/.claude/`). Check `.claude/`, `.mcp.json`, and
`opencodehub.policy.yaml` into git and every teammate who clones gets
the plugin automatically.

## What it does

```bash title="codehub init (from a clean repo)"
$ codehub init
codehub init: installed 28 file(s) under .claude/
codehub init: wrote hooks to /path/to/repo/.claude/settings.json
codehub setup (claude-code): wrote MCP entry to /path/to/repo/.mcp.json
codehub init: appended ".codehub/" to .gitignore
codehub init: seeded opencodehub.policy.yaml (all rules commented out)
codehub init: 28 file(s) into .claude/ · .mcp.json (wrote) · .gitignore updated · opencodehub.policy.yaml seeded
Next: run 'codehub analyze' to build the graph, then restart Claude Code.
```

## What ships in `.claude/`

```
.claude/
├── agents/                        # 7 agents
│   ├── code-analyst.md            # pre-existing analysis subagent
│   ├── doc-architecture.md        # artifact-factory subagents …
│   ├── doc-reference.md
│   ├── doc-behavior.md
│   ├── doc-analysis.md
│   ├── doc-diagrams.md
│   └── doc-cross-repo.md          # … group mode only
├── commands/                      # 5 slash commands
│   ├── probe.md
│   ├── verdict.md
│   ├── owners.md
│   ├── audit-deps.md
│   └── rename.md
├── hooks/                         # PostToolUse scripts
│   ├── augment.sh                 # enriches Bash/Grep/Glob with graph context
│   └── docs-staleness.sh          # non-blocking "/codehub-document --refresh" hint
├── settings.json                  # hooks config (project-scope equivalent of user-plugin hooks.json)
└── skills/                        # 10 skills
    ├── codehub-document/          # artifact factory skills …
    ├── codehub-pr-description/
    ├── codehub-onboarding/
    ├── codehub-contract-map/
    ├── opencodehub-guide/         # … analysis skills
    ├── opencodehub-exploring/
    ├── opencodehub-impact-analysis/
    ├── opencodehub-debugging/
    ├── opencodehub-refactoring/
    └── opencodehub-pr-review/
```

:::note[Why `settings.json` and not `hooks.json`?]
The user-scope plugin at `~/.claude/plugins/opencodehub/` uses
`hooks.json` with the `${CLAUDE_PLUGIN_ROOT}` token. Project-scope
hooks live in `.claude/settings.json`, and the token becomes
`${CLAUDE_PROJECT_DIR}/.claude`. `init` does the rewrite for you.
:::

## Other files seeded

- `.mcp.json` — `mcpServers.codehub` entry so Claude Code launches the
  MCP server automatically.
- `.gitignore` — `.codehub/` appended (local graph state stays out of
  git by default).
- `opencodehub.policy.yaml` — starter file with every rule commented
  out. Uncomment when the CI verdict actions ship (spec 002 P1).

## Options

| Flag | Default | Purpose |
|---|---|---|
| `--force` | off | Overwrite conflicting files under `.claude/`. Without it, a re-run with any existing `.claude/` contents refuses and lists every conflict. |
| `--skip-mcp` | off | Skip the `.mcp.json` write. Useful when MCP config is managed at user scope (`~/.claude.json`). |
| `--skip-policy` | off | Skip the `opencodehub.policy.yaml` seed. |
| `[path]` | `process.cwd()` | Positional target directory. |

## Idempotence

Re-running with the same args produces byte-identical output for
`settings.json`, `.mcp.json`, `.gitignore`, and the policy file. The
policy file is **not** re-seeded if it already exists — `init` only
creates it, never overwrites it, even under `--force`.

Conflicts under `.claude/` (e.g., a skill file you've locally modified)
abort the run without `--force`. The error names every conflict so you
can decide file-by-file.

## Next step

Run `codehub analyze` to build the graph, then restart Claude Code so
it picks up the new project-scope plugin.

```bash
codehub analyze .
```

See [Your first query](/opencodehub/start-here/first-query/) for what
to do once the graph is built.
