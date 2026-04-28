# 006 — What's Next for OpenCodeHub: Synthesis

*Draft: 2026-04-27. Inputs: 001 Strategy (Rumelt kernel), 002 PRD (product discovery), 003–005 Design (interfaces, subagent prompts, output conventions). Run via erpaval with product + strategy + design cycles in parallel.*

This memo is the single-source recommendation. All three cycles agree on the wedge and the pattern. They disagreed on three things — naming, P0 scope, and orchestrator model. I resolve each below, then hand off to an EARS spec at `.erpaval/specs/001-claude-code-artifact-surface/spec.md` that a later `/act` pass can compile into tasks.

## The thesis (refined)

**OpenCodeHub becomes the artifact factory for Claude Code at the group level.** We port the four-phase `/document` choreography — Phase 0 precompute → parallel `doc-*` subagents → deterministic cross-reference assembler → `.docmeta.json` sidecar — into a plugin skill family that treats a *group of repos* as a first-class scope. Every other code-graph tool is single-repo. We are the only retrieval surface with cross-repo graph primitives (`group_contracts`, `group_query`, `group_status`, `group_sync`), and we have a latent wiki/summarizer engine in the CLI already. The wedge writes itself.

Two reinforcing moats:

1. **Group-level synthesis** — artifacts that cite across repos with a `See also (other repos in group)` footer. Nobody else can do this.
2. **Freshness** — PostToolUse hook notices a `.docmeta.json` and flags staleness after `git commit|merge|pull|rebase`. Users feel the docs track the code.

## The crux

No artifact-producing skill exists in the plugin. All 6 current skills are analytical (guide, exploring, impact, debugging, refactoring, pr-review). The `codehub wiki --llm` generator and Bedrock summarizer exist in the CLI but are invisible to Claude Code. The `generate-map` MCP prompt sketches an ARCHITECTURE.md template but no command invokes it. Users literally have no way to ask Claude Code "document this" and get a committed Markdown tree back.

Remove the crux by shipping the skill. Everything else is downstream.

## Three tensions resolved

### Tension 1 — Naming

| Cycle | Name |
|---|---|
| Strategy (001) | `/document-group` |
| PRD (002) | `/codehub-map` |
| Design (003) | `/codehub-document` |

**Resolution: `/codehub-document`.** Reasons: (a) users who already know the base pattern expect "document" verbs; (b) prefix `codehub-` sidesteps the literal collision the base pattern owns at `/document`; (c) "map" foregrounds graph-origin but misframes the output — the artifact is a *document set*, not a map; (d) this also aligns with the agent naming convention in 004 (`doc-architecture`, `doc-reference`, `doc-cross-repo`). Group mode is a flag, not a separate skill. The full family becomes `codehub-document`, `codehub-pr-description`, `codehub-onboarding`, `codehub-adr`, `codehub-contract-map`.

### Tension 2 — P0 scope

| Cycle | P0 skills |
|---|---|
| Strategy (001) | `/document-group` only |
| PRD (002) | `/codehub-map` + `/codehub-pr-description` + `/codehub-onboarding` |
| Design (003) | Designs all 5 |

**Resolution: PRD's P0 shape, with `codehub-document` doing single- and group-mode from day one.** Justification:

- `codehub-document` alone doesn't demonstrate the pattern's reach. Users need to see the skill family to understand what OpenCodeHub-as-artifact-factory means.
- `codehub-pr-description` has the highest invocation frequency (every PR) and the shortest agent path. It proves the MCP→Markdown pipeline in 10 seconds, not 90.
- `codehub-onboarding` is the lowest-effort v1 output that shows the graph doing something prose can't — ranked reading order from centrality, owners table, entry point trace.
- `codehub-contract-map` folds into `codehub-document --group` for v1. If standalone demand emerges, split later.
- `codehub-adr` is P1 — the template market is crowded, and the group wedge matters more first.

### Tension 3 — Orchestrator model

Design flagged `codehub-document` running on **Opus** while every sibling runs on Sonnet. Cost posture inversion.

**Resolution: Sonnet as default; Opus only when `--refresh` with `--group` is passed.** Rationale: the Opus routing argument is real but narrow — refresh logic that prunes sections by mtime comparison and fans out a partial subagent set requires judgment. Full-scan single-repo generation does not. Cost-but-lazy tenet (global CLAUDE.md) says spend when it matters; `--refresh --group` is where it matters. Single-repo first-run does not need Opus.

## What ships this quarter (P0)

Ordered by critical path.

### 1. `codehub-document` skill — `plugins/opencodehub/skills/codehub-document/`

Single- and group-mode from v1. 4-phase orchestration per the base pattern: Phase 0 precompute → Phase AB four subagents parallel → Phase CD two subagents parallel → Phase E inline assembler. `references/` for progressive disclosure: `document-templates.md`, `data-source-map.md`, `cross-reference-spec.md`, `mermaid-patterns.md`. Frontmatter per 003. Precondition: `list_repos` contains the target and `codehub status` is fresh. Argument-hint: `[output-dir] [--group <name>] [--committed] [--refresh] [--section <name>]`.

### 2. Six `doc-*` subagents — `plugins/opencodehub/agents/doc-*.md`

`doc-architecture`, `doc-reference`, `doc-behavior`, `doc-analysis`, `doc-diagrams`, `doc-cross-repo`. 8-section scaffold per 004. All Sonnet. All read `.codehub/.context.md` + `.codehub/.prefetch.md` first. `doc-cross-repo` is group-mode-only and is skipped silently in single-repo mode.

### 3. Shared-context precompute — `packages/analysis/src/prefetch.ts` (or equivalent location)

Phase 0 writer. Emits `.codehub/.context.md` (200-line cap, human-readable project digest) and `.codehub/.prefetch.md` (newline-delimited JSON ledger of tool calls with response digests — the dedup substrate). Per-subsection truncation with `truncated: true` flag. Group mode writes to `.codehub/groups/<name>/`.

### 4. `.docmeta.json` schema + Phase E assembler

Schema per 005: `generated_at`, `codehub_graph_hash`, `mode`, `sections[]` with `agent`/`sources[]`/`mtime`/`citation_count`, `cross_repo_refs[]` for group mode, `staleness_at` lifted from the MCP `_meta.codehub/staleness` envelope. Phase E is a single regex pass over citations followed by a co-occurrence join — 40 lines of deterministic code, no LLM call.

### 5. `codehub-pr-description` skill — `plugins/opencodehub/skills/codehub-pr-description/`

Sonnet, linear (no subagents). Reads `detect_changes` + `verdict` + `owners` + `list_findings_delta`. Outputs `.codehub/pr/PR-<branch>.md` by default or user path. Refuses on a clean tree.

### 6. `codehub-onboarding` skill — `plugins/opencodehub/skills/codehub-onboarding/`

Sonnet, one specialty subagent (`doc-onboarding`) that walks `project_profile` + `query` on entry-point concepts + `owners` + `route_map`/`tool_map`. Output: `.codehub/ONBOARDING.md` or `docs/ONBOARDING.md` with `--committed`.

### 7. PostToolUse hook extension — `plugins/opencodehub/hooks.json`

After the existing auto-reindex on `git commit|merge|rebase|pull`, if `.codehub/docs/.docmeta.json` exists and its `codehub_graph_hash` disagrees with the live hash, emit a non-blocking `systemMessage` suggesting `/codehub-document --refresh`. No auto-regeneration — regeneration spends Bedrock credits, user must consent.

### 8. Discoverability patches

- `opencodehub-guide` skill gains a Skills table listing the five artifact skills with trigger examples.
- `packages/cli/src/commands/analyze.ts` completion message appends `Try: /codehub-document · /codehub-onboarding`.
- `packages/mcp/src/next-step-hints.ts` — `verdict` and `detect_changes` responses append `{suggest: "codehub-pr-description"}` when a diff is present.
- Starlight site gains `/skills/` page rendered from each skill's frontmatter.

## What moves to P1

- `codehub-contract-map` as a standalone skill (folded into `--group` for v1)
- `codehub-adr`
- `codehub-document --group --auto` mode inside the PostToolUse hook (auto-regenerate on merge-to-main)
- `group_wiki` + `group_synthesize` MCP tools (Strategy action B). Deferred because the Phase 0 precompute + existing `group_*` tools + `codehub wiki --llm` already cover the data path; promote to MCP if v1 proves the pattern

## What we are NOT doing (explicit exclusions)

Copy forward from 001 verbatim so they are reviewable:

- **No web UI or hosted dashboard.** Claude Code is the client.
- **No new retrieval tools this quarter.** 28 is enough.
- **No indexer rewrite in Rust/Go.** Commit f8454b5 bought the headroom.
- **No non-Claude-Code LLM integrations.** No Cursor plugin, no Continue, no OpenAI Assistants.
- **No head-to-head with Copilot/Cursor.** They are agentic editors; we are an artifact factory.
- **No SVG/PNG diagrams.** Mermaid in Markdown is sufficient.
- **No Starlight auto-publish of generated docs.** Per-repo artifacts live under `.codehub/` or `docs/codehub/`; the site stays meta.

## Risks (escalate if they block)

1. **Parallel subagent ceiling** — Claude Code caps concurrent `Agent` calls at ~10 per message. Groups of 3+ repos require batching by role (all `doc-architecture` agents in message 1, all `doc-behavior` in message 2, …). Design 004 codified this; verify against the current Claude Code release before committing the group fan-out shape. If the ceiling is lower than 10, consider a `doc-supervisor` meta-agent per repo instead of per-role fan-out.
2. **Subagent tool sprawl** — each `doc-*` carries 6–10 `mcp__opencodehub__*` tools plus Read/Write/Grep/Glob. Tool-metadata context bloat is the realistic failure mode. Mitigation is already baked into 004: every agent opens with "do not re-call tools whose digest is in `.prefetch.md`" plus a Tool Usage Guide table.
3. **Bedrock credential gating** — the summarizer path requires AWS credentials on the host. Any skill that invokes it must degrade gracefully to raw graph output when Bedrock is unreachable. Document the failure mode in each SKILL.md.
4. **Precompute size** — `.prefetch.md` can balloon on large repos. Per-section caps (500 lines per block, hard) in the Phase 0 writer prevent the ledger from crowding out the context window.

## Follow-on work once v1 lands

1. `codehub-document --since <rev>` for git-range-scoped regeneration.
2. CI workflow that runs `--refresh` on push-to-main and opens a PR when section mtimes move.
3. `group_wiki` + `group_synthesize` MCP tools if usage data shows Phase 0 precompute is the bottleneck.
4. `codehub-adr` with `impact`-sourced Consequences section.
5. A `codehub-release-notes` skill that consumes `list_findings_delta` across a range.

## Open questions for you to decide

These are the places where I made a call but could be wrong:

- **Is "codehub-document" the right name?** Short enough, no collision, keeps the verb from the base pattern. Alternatives I rejected: `codehub-map`, `codehub-wiki`, `codehub-book`. If you hate the verb, flag it before we ship the frontmatter.
- **Gitignored default vs committed default.** I kept the PRD's call: `.codehub/docs/` gitignored by default, `--committed` writes to `docs/codehub/`. The one exception is `codehub-adr` — ADRs default to committed because an ADR that isn't in git isn't an ADR.
- **Does `codehub-onboarding` warrant its own skill or should it be a `--section onboarding` flag on `codehub-document`?** I kept it as its own skill to get the invocation phrase "write onboarding" directly. If you'd rather ship only one skill in v1 and fold onboarding + pr-description into flags, that's smaller but erodes the "artifact family" framing. My bet is the family signals the wedge better.

## Ready for implementation

Spec at `.erpaval/specs/001-claude-code-artifact-surface/spec.md` (EARS). When you want to start, invoke `/erpaval` (Act phase) against that spec — the task derivation and subagent packets follow the standard orchestrator runbook. If you want `/codehub-document` as a proof of concept first (single-repo, no group, no `--refresh`), skip the spec and say "do the POC" — I'll scaffold just Phase 0/AB/E plus the `doc-architecture` subagent as a 500-line demo.
