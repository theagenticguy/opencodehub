---
title: Seed docs-authoring subagents with a single ground-truth YAML
tags: [erpaval, docs, subagents, explore, grounding]
first_applied: 2026-04-27
repos: [open-code-hub]
---

## The pattern

When parallelizing doc-authoring across multiple subagents, write
ONE ground-truth YAML from the Explore phase and make every agent
read it first. The YAML is authoritative; the repo's own README /
CONTRIBUTING may be stale. Tell the agents that explicitly.

## Why it works

Subagents start with empty context. Absent a pointer, they will
search the codebase and often surface stale prose. In this repo,
three separate numbers exist for "MCP tool count" (README=27,
server.ts=28, smoke-mcp.sh=19), and three separate license
allowlists (mise.toml, ci.yml, acceptance.sh). Every agent that
uses the README as ground truth will write "27 tools". Every agent
that reads explore.yaml (which captured the server.ts live count)
will write "28 tools" consistently.

## Recipe

1. **Explore phase** writes `explore.yaml` with a `top_gotchas`
   section at the top that calls out source-of-truth conflicts
   before any other content.
2. **Each Act subagent prompt** opens with:
   > Ground truth: `.erpaval/sessions/<id>/explore.yaml`.
   > If the repo's README disagrees, explore.yaml wins.
3. **Non-negotiable facts section** in the subagent prompt repeats
   the 4-6 things that MUST be right (canonical CLI name, counts,
   versions, banned strings). Agents skim long prompts; repeated
   facts survive skimming.
4. **Banned-strings list** goes in every Act prompt. The repo's
   `scripts/check-banned-strings.sh` will reject the whole PR if
   any agent leaks a banned literal. Cheap insurance.

## Example frontmatter for a writing subagent

```text
## Non-negotiable facts

- CLI binary: `codehub` (NOT opencodehub).
- MCP tool count: 28 (README says 27 — stale. server.ts is authoritative).
- License allowlist: Apache-2.0;MIT;BSD-2-Clause;...
- Node 22, pnpm 10.33.2.

## Banned strings (hard CI fail)

Never write: <list>.
```

Three multi-agent runs in this session all produced consistent
"28 tools" prose without a single correction round. Without the
YAML+prompt-frontmatter pattern, the first two got it wrong on
their first attempt in prior sessions.

## When this pattern is wrong

- The task is small enough for one agent. Don't parallelize
  three-page docs.
- The repo has NO stale artifacts. Then subagents reading the
  README directly is fine.
- The ground truth is rapidly changing during the session (e.g.
  you're editing server.ts and documenting it in the same turn).
  Regenerate explore.yaml between rounds or tell agents to re-read
  the source.
