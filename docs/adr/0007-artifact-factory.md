# ADR 0007 — Artifact Factory: Claude Code plugin turns the graph into committed Markdown

- Status: accepted
- Date: 2026-04-27
- Authors: Laith Al-Saadoon + Claude
- Branch: `feat/artifact-factory`

## Context

The OpenCodeHub plugin ships six analytical skills (`opencodehub-guide`,
`opencodehub-exploring`, `opencodehub-impact-analysis`,
`opencodehub-debugging`, `opencodehub-refactoring`,
`opencodehub-pr-review`) and five slash commands (`/probe`, `/verdict`,
`/audit-deps`, `/rename`, `/owners`). Every current surface answers
questions. None of them emit a committed Markdown artifact — the
durable unit of output Principal engineers actually ship.

The CLI already has `codehub wiki --llm` wired to `@opencodehub/summarizer`
and Bedrock, and the MCP server has a `generate-map` prompt that sketches
an `ARCHITECTURE.md`. Both are invisible to a Claude Code session. The
group primitives (`group_contracts`, `group_query`, `group_status`,
`group_sync`) are the single feature no other code-graph tool has and
they have no artifact-producing skill on top.

codeprobe (`/Users/lalsaado/Projects/codeprobe`) has validated the
pattern at single-repo scope: one `/document` skill with Phase 0–E
orchestration produces ~33 Markdown files in `.codeprobe/docs/` via 8
parallel subagents with a shared-context precompute on disk. That
pattern is portable and compositional.

The broader "grounding plane for runner-resident agents" design (an
MCP-over-HTTP server + `@opencodehub/agent-sdk` + `@opencodehub/claude-hooks`)
was explored across brainstorms 007–013 and **rejected as scope** in
favor of the simpler shape below.

## Decision

Ship an **artifact factory** inside the existing `plugins/opencodehub/`
Claude Code plugin that ports codeprobe's pattern to OpenCodeHub's graph
and extends it with first-class **group mode**.

### What ships in v1

Nine components, tracked in `.erpaval/specs/001-claude-code-artifact-surface/spec.md`:

1. **`codehub-document`** — primary skill (single + group mode, 4-phase orchestration)
2. **Six `doc-*` subagents** — `doc-architecture`, `doc-reference`, `doc-behavior`, `doc-analysis`, `doc-diagrams`, `doc-cross-repo`
3. **Phase 0 shared-context precompute** — writes `.codehub/.context.md` (200-line cap) and `.codehub/.prefetch.md` (JSON tool-call ledger)
4. **`.docmeta.json` + Phase E deterministic assembler** — citation regex → co-occurrence join → See-also footers → cross-repo link graph
5. **`codehub-pr-description`** — linear skill (no subagents)
6. **`codehub-onboarding`** — one specialty subagent
7. **`codehub-contract-map`** — group-only standalone skill (promoted from P1)
8. **PostToolUse staleness hook** — non-blocking `systemMessage` after git mutations
9. **Discoverability patches** — guide-skill Skills table, `codehub analyze` completion hint, `next_steps[]` suggestions, Starlight `/skills/` index

### Scope exclusions (durable)

| Excluded surface | Reason |
|---|---|
| Hosted / managed / SaaS / OpenCodeHub-operated tier | Self-hosted OSS only. Product-distribution decision, not a timeline call. |
| Remote / HTTP MCP server | Stdio MCP on the laptop only. No `packages/mcp-http/`, no Streamable HTTP, no remote transport. |
| Agent SDK (Python or TS) | No `@opencodehub/agent-sdk`, no `@opencodehub/claude-hooks`, no framework adapters. Agents consume OpenCodeHub via the Claude Code plugin or the `codehub` CLI. |
| `grounding_pack` MCP compositor tool | Its value was SDK consumption. Individual tools remain accessible. |
| OpenCodeHub-branded coding agent | We don't compete with Devin / Copilot / Cursor / Amazon Q / Claude-for-GitHub. |
| LLM-based PR review | CodeRabbit / Greptile / Diamond territory. We compete on deterministic verdict. |
| IDE plugin / LSP | Out. |
| Model fine-tuning | Out. |

### Three locked defaults (from synthesis 013 §Open questions)

1. **`codehub-contract-map` output path**: `.codehub/groups/<name>/contracts.md` gitignored default; `--committed` writes to `docs/<group>/contracts.md`.
2. **Orchestrator model**: Sonnet default; Opus only when `--refresh --group` is passed (refresh logic that prunes by mtime + fans out partial subagent set needs judgment; first-run single-repo does not).
3. **Output default**: `.codehub/docs/` gitignored; `--committed` opt-in to `docs/codehub/`. See ADR 0009 for the full output contract.

### Install model — project scope via `codehub init`

The default install path for a repo that wants OpenCodeHub is now `codehub init`, which does the full project-scope bootstrap in one command:

1. Copies the plugin (`skills/`, `agents/`, `commands/`, `hooks/`) from the CLI's bundled assets into `<repo>/.claude/`.
2. Rewrites `hooks.json`'s `${CLAUDE_PLUGIN_ROOT}` token to `${CLAUDE_PROJECT_DIR}/.claude` and writes the result to `<repo>/.claude/settings.json` (the project-scope equivalent).
3. Writes `<repo>/.mcp.json` with the `mcpServers.codehub` entry via the existing `runSetup` pipeline.
4. Appends `.codehub/` to `.gitignore` (idempotent).
5. Seeds `opencodehub.policy.yaml` (every rule commented out) for the CI verdict actions in spec 002 P1.

**Project scope over user scope.** Once `.claude/` is in git, every teammate who clones the repo gets the plugin automatically. The legacy user-scope install (`codehub setup --plugin` → `~/.claude/plugins/opencodehub/`) remains supported for users who want a single global install across every repo.

**Idempotent.** Re-running `codehub init` against an existing `.claude/` refuses with a conflict list unless `--force` is passed. With `--force`, outputs are byte-identical on unchanged inputs. The policy starter is never overwritten once it exists, even under `--force`.

## Consequences

### Positive

- **Composability over consolidation.** Being the neutral graph substrate that Claude Code (and later, any CLI consumer) calls beats shipping a competing agent runtime.
- **Self-hosted posture is a moat in regulated orgs.** No customer contract lists "OpenCodeHub Cloud" as a dependency.
- **The `group_*` primitives finally have a Claude Code surface.** `codehub-contract-map` alone demonstrates the uniquely-ours cross-repo artifact — nobody else does this.
- **Low operational commitment.** No server to run, no SDK versions to support, no OAuth issuer, no JWKS endpoint.
- **Deterministic artifacts with a machine-readable `.docmeta.json`.** `--refresh` works on mtime comparison; audit-tier guarantees drop out of `graph_hash` invariance.

### Negative

- **We forfeit two competitive seams from brainstorm 012 §3**:
  - Agent-scoped grounding server for CI runners (would have required HTTP MCP)
  - Claude Agent SDK hook pack as reference implementation (would have required the SDK)
- **Distribution reach is narrower.** Without the SDK, agent frameworks outside Claude Code must shell out to the CLI or skip us.
- **Anthropic ships a first-party repo-understanding tool in the Claude Agent SDK at some point.** We complement rather than compete, which means less share of that audience.

Counter: both forfeits would have meant operating server code for our
customers or shipping SDK versions that break every time Claude Agent
SDK moves. The CLI + plugin posture is cheaper to maintain, and the
laptop surface still reaches every Claude Code user directly.

### Neutral

- The CI action surface (spec 002, now rewritten as CLI-wrapping) is
  deferred to P1 and only begins after spec 001 has adoption signal.

## References

- `.erpaval/specs/001-claude-code-artifact-surface/spec.md` — the EARS spec driving this work
- `.erpaval/brainstorms/006-synthesis-whats-next.md` — earlier synthesis (artifact factory only)
- `.erpaval/brainstorms/013-synthesis-v2-two-surface-product.md` — current unified recommendation
- `docs/adr/0008-codeprobe-pattern-port.md` — records the pattern we are porting
- `docs/adr/0009-artifact-output-conventions.md` — output contract for every generated artifact
- `/Users/lalsaado/Projects/codeprobe/src/codeprobe/bootstrap/templates/claude-plugin/skills/document/SKILL.md` — pattern source
