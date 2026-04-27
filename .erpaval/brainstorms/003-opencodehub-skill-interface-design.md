# 003 — OpenCodeHub Skill Interface Design

VP-of-Design pass on the five artifact-generation skills shipping in the `opencodehub` plugin. Each entry gives the full SKILL.md frontmatter, natural-language + slash invocation examples, and what the user sees in the transcript.

*Scope: user-facing surface only. Subagent prompts live in `004`, output contract in `005`.*

## Skill 1 — `codehub-document`

Primary artifact generator. Ports the codeprobe `/document` choreography to OpenCodeHub's graph.

```yaml
---
name: codehub-document
description: "Use when the user asks to generate, regenerate, or refresh long-form codebase documentation, an architecture book, a module map, or a per-repo reference — especially after `codehub analyze` finishes or after a large merge. Examples: \"document this repo\", \"regenerate the architecture docs\", \"write a module map for the monorepo\", \"produce a group-wide portfolio doc\". DO NOT use if the repo is not indexed — run `codehub analyze` first and confirm `mcp__opencodehub__list_repos` returns the repo. DO NOT use for PR descriptions (use `codehub-pr-description`) or ADRs (use `codehub-adr`)."
allowed-tools: "Read, Write, Edit, Glob, Grep, Bash(codehub:*), mcp__opencodehub__list_repos, mcp__opencodehub__project_profile, mcp__opencodehub__query, mcp__opencodehub__context, mcp__opencodehub__impact, mcp__opencodehub__dependencies, mcp__opencodehub__owners, mcp__opencodehub__risk_trends, mcp__opencodehub__route_map, mcp__opencodehub__tool_map, mcp__opencodehub__list_dead_code, mcp__opencodehub__group_list, mcp__opencodehub__group_query, mcp__opencodehub__group_status, mcp__opencodehub__group_contracts, mcp__opencodehub__sql, Task"
argument-hint: "[output-dir] [--group <name>] [--committed] [--refresh] [--section <name>]"
color: indigo
model: opus
---
```

*Rationale: `opus` for the orchestrator because it routes to six subagents and must reason about which artifacts are still fresh; subagents themselves run on `sonnet` to stay cheap. The negative rule forces a `list_repos` pre-check — our single biggest support failure today is running against an unindexed repo.*

**Invocation examples**
- Natural: "regenerate the OpenCodeHub docs" / "document the `platform` group"
- Slash: `/codehub-document docs/` or `/codehub-document docs/ --group platform --refresh`

**Transcript shape**
- *Phase 0 (precompute):* single status line — `Prefetching graph context for opencodehub… 18 KB → .codehub/.context.md`.
- *Phase AB (fan-out 4):* `Dispatching doc-architecture, doc-reference, doc-behavior, doc-analysis in parallel…`. Each subagent emits a one-line summary on completion; the orchestrator does not echo their tool calls.
- *Phase CD (fan-out 2):* `Dispatching doc-diagrams, doc-cross-repo…` (cross-repo skipped silently in single-repo mode).
- *Phase E (assembler):* `Linking 33 docs · 241 citations · 18 See-also blocks · wrote .docmeta.json`.

## Skill 2 — `codehub-pr-description`

```yaml
---
name: codehub-pr-description
description: "Use when the user asks for a PR description, a pull request summary, a merge write-up, or a release note for a branch or diff. Examples: \"write the PR description\", \"summarize this branch for review\", \"draft release notes for HEAD\". Runs `mcp__opencodehub__detect_changes` + `verdict` + `owners` and writes Markdown. DO NOT use for open-ended architecture docs (use `codehub-document`). DO NOT use when no diff exists — the skill refuses on a clean tree."
allowed-tools: "Read, Write, Bash(git diff:*), Bash(git log:*), Bash(git rev-parse:*), mcp__opencodehub__detect_changes, mcp__opencodehub__verdict, mcp__opencodehub__owners, mcp__opencodehub__impact, mcp__opencodehub__signature, mcp__opencodehub__list_findings_delta"
argument-hint: "[--base <rev>] [--head <rev>]"
color: teal
model: sonnet
---
```

*Rationale: `sonnet` is enough because the skill is linear — one `detect_changes` call threads into a fixed template. The negative rule "refuses on a clean tree" prevents the annoying failure mode where a user fires it at `main` by mistake.*

- Natural: "write the PR description" / "summarize this branch"
- Slash: `/codehub-pr-description --base main --head HEAD`
- Transcript: one-shot; user sees `detect_changes → 7 symbols · verdict: review_recommended · owners: 2` then the rendered Markdown.

## Skill 3 — `codehub-onboarding`

```yaml
---
name: codehub-onboarding
description: "Use when the user asks for an ONBOARDING, getting-started, or new-engineer guide for the current repo or group. Examples: \"write ONBOARDING.md\", \"generate an onboarding doc for new hires\", \"what should a new engineer read first\". Produces a ranked reading order from `project_profile` + top processes + entry points. DO NOT use for full architecture books (use `codehub-document`)."
allowed-tools: "Read, Write, Glob, mcp__opencodehub__project_profile, mcp__opencodehub__query, mcp__opencodehub__route_map, mcp__opencodehub__tool_map, mcp__opencodehub__owners, mcp__opencodehub__sql"
argument-hint: "[output-path]"
color: green
model: sonnet
---
```

*Rationale: scoped to a single file so we can keep it tight. The ranked reading order is the deliverable — it is the wedge over a generic README scaffold.*

- Natural: "write an onboarding guide" — slash: `/codehub-onboarding ONBOARDING.md`.

## Skill 4 — `codehub-contract-map`

```yaml
---
name: codehub-contract-map
description: "Use when the user asks for a cross-repo contract map, an API-consumer matrix, or a service-interaction diagram across a repo group. Examples: \"map the HTTP contracts between services\", \"which services call the billing API\", \"show the contract matrix for the platform group\". GROUP MODE ONLY — requires a named group. DO NOT use on a single repo (use `codehub-document` with `reference/public-api.md`). DO NOT use if `mcp__opencodehub__group_list` does not include the group."
allowed-tools: "Read, Write, mcp__opencodehub__group_list, mcp__opencodehub__group_status, mcp__opencodehub__group_contracts, mcp__opencodehub__group_query, mcp__opencodehub__route_map"
argument-hint: "<group-name> [--output <path>]"
color: purple
model: sonnet
---
```

*Rationale: this is the skill that advertises the group wedge — the negative rule gates it to groups only so users do not waste a turn on it in single-repo mode.*

- Natural: "map the contracts across the platform group" — slash: `/codehub-contract-map platform --output .codehub/groups/platform/contract-map.md`.

## Skill 5 — `codehub-adr`

```yaml
---
name: codehub-adr
description: "Use when the user asks to draft an Architecture Decision Record, ADR, or design decision document for a concrete code change or refactor. Examples: \"draft an ADR for splitting the ingestion pipeline\", \"write a decision record for deprecating the legacy handler\". Takes a problem statement, grounds consequences in `mcp__opencodehub__impact` on the target symbol. DO NOT use without a problem statement argument. DO NOT use for retrospective docs of shipped work (use `codehub-document`)."
allowed-tools: "Read, Write, mcp__opencodehub__query, mcp__opencodehub__context, mcp__opencodehub__impact, mcp__opencodehub__owners, mcp__opencodehub__risk_trends, mcp__opencodehub__signature"
argument-hint: "\"<problem-statement>\" [--target <symbol>] [--adr-number <N>]"
color: amber
model: sonnet
---
```

*Rationale: forcing the problem statement as a positional arg dodges the empty-ADR failure mode. Impact query seeds the "Consequences" section with real blast-radius data instead of LLM speculation.*

- Natural: "draft an ADR for removing the v1 auth middleware" — slash: `/codehub-adr "Remove v1 auth middleware" --target legacyAuth`.

## Discoverability design

Four reinforcing paths, ranked by hit-rate:

1. **`opencodehub-guide` adds a Skills table** — the guide is already the on-ramp; add a row per artifact skill with trigger examples. *Zero-cost, highest reach.*
2. **`codehub analyze` completion hint (PostToolUse hook)** — after analyze finishes, the hook prints `Indexed opencodehub (1,248 symbols). Try: /codehub-document docs/  ·  /codehub-onboarding`. *Catches the moment the user is most likely to want docs.*
3. **`verdict` / `detect_changes` next-step hints** — existing `next_steps` arrays on these responses already flow through `packages/mcp/src/next-step-hints.ts`; append `{suggest: "codehub-pr-description"}` when a diff is present. *Reuses infrastructure we already ship.*
4. **Starlight docs site `/skills/` page** — one page per skill with the frontmatter rendered as a card, trigger examples, and a 10-second demo asciicast. *Backstop for Googling users.*

*Design bet: the PostToolUse hook is the decisive surface. Users who just ran `codehub analyze` are in exactly the mental state that predicts a documentation request — meet them there.*
