# Spec 001 — Claude Code Artifact Surface

*EARS form. Feeds `/erpaval` Act phase. Source memo: `.erpaval/brainstorms/006-synthesis-whats-next.md`. Cycle references: 001 strategy, 002 PRD, 003-005 design.*

## Scope

Ship an artifact-generation skill family inside `plugins/opencodehub/` that applies the four-phase `/document` choreography to OpenCodeHub's graph + supply-chain surface, with first-class group (multi-repo) support. v1 covers `codehub-document` (single + group), `codehub-pr-description`, `codehub-onboarding`, **`codehub-contract-map`** (standalone group-only skill, promoted from P1 on 2026-04-27), plus the shared-context precompute, `.docmeta.json` sidecar, cross-reference assembler, and PostToolUse staleness hook.

## Out of scope for v1

- `codehub-adr` (deferred P1 — ADR template market is crowded, revisit after the P0 family has adoption)
- Auto-regeneration on merge-to-main
- `group_wiki` / `group_synthesize` MCP tools (Phase 0 precompute + existing `group_*` tools cover the data path)
- SVG/PNG diagram generation
- Starlight auto-publish of generated docs

## Acceptance criteria (EARS)

### Ubiquitous

- **AC-1-1** The system shall ship four new skill directories under `plugins/opencodehub/skills/`: `codehub-document/`, `codehub-pr-description/`, `codehub-onboarding/`, `codehub-contract-map/`. The existing `opencodehub-guide/`, `opencodehub-exploring/`, `opencodehub-impact-analysis/`, `opencodehub-debugging/`, `opencodehub-refactoring/`, `opencodehub-pr-review/` skills remain unchanged. [P]
- **AC-1-2** The system shall ship six subagent files under `plugins/opencodehub/agents/`: `doc-architecture.md`, `doc-reference.md`, `doc-behavior.md`, `doc-analysis.md`, `doc-diagrams.md`, `doc-cross-repo.md`. [P] Dependencies: AC-1-1
- **AC-1-3** Every generated Markdown artifact shall have H1 identifier, no YAML frontmatter, and at least one backtick citation of form `` `<path>:<LOC>` `` or `` `<repo>:<path>:<LOC>` ``. [P]

### Event-driven

- **AC-2-1** When the user invokes `/codehub-document` and `codehub status` reports a fresh index, the system shall execute Phase 0 (precompute) then Phase AB (four subagents parallel) then Phase CD (two subagents parallel, `doc-cross-repo` skipped in single-repo mode) then Phase E (assembler) and write at least 10 Markdown files under the output directory plus a valid `.docmeta.json`. Dependencies: AC-1-1, AC-1-2, AC-3-1
- **AC-2-2** When the user invokes `/codehub-document --group <name>`, Phase 0 shall call `group_list` + `group_status` + `group_contracts` + `group_query`, and Phase CD shall dispatch `doc-cross-repo` with the group manifest. Dependencies: AC-2-1
- **AC-2-3** When the user invokes `/codehub-document --refresh`, the system shall compare each `sections[].sources[].mtime` against `sections[].mtime` and regenerate only stale sections; Phase E shall always re-run. Dependencies: AC-2-1, AC-4-2
- **AC-2-4** When the user invokes `/codehub-document --committed`, the system shall write under `docs/codehub/` (or user-supplied path) and shall not add any entry to `.gitignore`. Dependencies: AC-2-1
- **AC-2-5** When the user invokes `/codehub-pr-description` inside a branch with changes, the system shall call `detect_changes` + `verdict` + `owners` + `list_findings_delta` and write Markdown citing verdict tier, affected symbols, owner-reviewers, and findings-delta summary. Dependencies: AC-1-1
- **AC-2-6** When the user invokes `/codehub-onboarding`, the system shall dispatch one subagent that reads `project_profile` + `query` + `owners` + `route_map` + `tool_map` and writes `.codehub/ONBOARDING.md` with a ranked reading order section. Dependencies: AC-1-1
- **AC-2-7** When the user invokes `/codehub-contract-map <group-name>`, the system shall call `group_list` (to validate the group exists) + `group_status` (to validate freshness) + `group_contracts` + `group_query` + `route_map`, and shall write a Markdown artifact containing a contracts matrix table, at least one Mermaid diagram of consumer→producer flows, and a `See also` footer linking to each member repo's generated docs when present. Output defaults to `.codehub/groups/<name>/contracts.md`. Dependencies: AC-1-1, AC-3-4
- **AC-2-8** When the `PostToolUse` hook observes `git commit|merge|rebase|pull` and `.codehub/docs/.docmeta.json` exists whose `codehub_graph_hash` disagrees with the live hash, the hook shall emit a `systemMessage` suggesting `/codehub-document --refresh` without auto-regenerating. Dependencies: AC-2-1

### State-driven

- **AC-3-1** While the index is stale (per `codehub status`), `codehub-document`, `codehub-onboarding`, and `codehub-contract-map` shall refuse to run and shall emit a single-line remediation hint naming the stale repo. Dependencies: AC-1-1
- **AC-3-2** While `codehub-document --group <name>` is invoked and any member repo is stale, the skill shall abort and name each stale repo in the error. Dependencies: AC-2-2, AC-3-1
- **AC-3-3** While Bedrock is unreachable from the skill host, any skill that would summarize via `@opencodehub/summarizer` shall degrade to raw graph output and shall not block. Dependencies: AC-1-1
- **AC-3-4** While `/codehub-contract-map` is invoked without a `<group-name>` argument or against a group `group_list` does not return, the skill shall refuse to run with `Contract map requires a named group — run 'codehub group list' to see registered groups.` and shall not consume any additional tool budget. Dependencies: AC-2-7

### Optional feature

- **AC-4-1** Where Phase E detects ≥2 shared source citations between two sibling documents, the assembler shall append a `## See also` footer listing 3–5 sibling links to both documents. [P] Dependencies: AC-2-1
- **AC-4-2** Where group mode is active and a per-repo `.codehub/docs/` tree exists under `.codehub/groups/<name>/<repo>/`, Phase E shall emit a `## See also (other repos in group)` section in every `cross-repo/*.md` file linking into the sibling repo's equivalent section. Dependencies: AC-2-2, AC-4-1
- **AC-4-3** Where `codehub-document` exits successfully, `.docmeta.json` shall include `generated_at`, `codehub_graph_hash`, `mode`, `sections[]` with `path`/`agent`/`sources[]`/`mtime`/`citation_count`/`mermaid_count`, and in group mode also `cross_repo_refs[]`. [P] Dependencies: AC-2-1

### Unwanted behavior

- **AC-5-1** If Phase AB dispatches more than 10 subagents in a single message, the orchestrator shall batch by subagent role (all `doc-architecture` first, then `doc-behavior`, etc.) and shall not exceed 10 concurrent `Agent` tool calls per message. Dependencies: AC-2-1, AC-2-2
- **AC-5-2** If a subagent attempts to call an MCP tool whose response digest is already present in `.prefetch.md`, the subagent prompt shall instruct it to reuse the cached result; compliance shall be enforced by prompt text and verified by the `Quality Checklist` block in each agent file. Dependencies: AC-1-2, AC-6-1
- **AC-5-3** If any generated document contains a YAML frontmatter block, Phase E shall strip it and log a `frontmatter_removed` entry in `.docmeta.json`. Dependencies: AC-2-1
- **AC-5-4** If `codehub-pr-description` is invoked on a clean working tree with no diff, the skill shall refuse to run and emit `No diff detected — resolve base/head or stage changes.` Dependencies: AC-2-5
- **AC-5-5** If `codehub-contract-map` finds zero inter-repo contracts in `group_contracts` output, the skill shall still write the artifact file with a `No inter-repo contracts detected` banner and the empty matrix, rather than erroring. Dependencies: AC-2-7

### Precompute

- **AC-6-1** The Phase 0 writer shall emit `.codehub/.context.md` (hard-capped at 200 lines, with truncation indicators per subsection) and `.codehub/.prefetch.md` (newline-delimited JSON ledger: one record per tool call with `tool`, `args`, `sha256`, `keys`, `cached_at`). [P] Dependencies: AC-1-1
- **AC-6-2** Where group mode is active, Phase 0 shall write precompute files under `.codehub/groups/<name>/` instead of `.codehub/`. Dependencies: AC-6-1, AC-2-2

### Discoverability

- **AC-7-1** The `opencodehub-guide` skill shall include a Skills table with one row per artifact skill (name, trigger example, one-line purpose). [P] Dependencies: AC-1-1
- **AC-7-2** After `codehub analyze` completes, `packages/cli/src/commands/analyze.ts` shall print `Try: /codehub-document  ·  /codehub-onboarding  ·  /codehub-contract-map <group>` as the last status line (the third hint only appears if the analyzed repo is a member of at least one group). [P] Dependencies: AC-1-1
- **AC-7-3** The `verdict` and `detect_changes` MCP tools' `next_steps[]` arrays shall include `{suggest: "codehub-pr-description"}` when the call was executed on a branch with a non-empty diff. [P] Dependencies: AC-1-1
- **AC-7-4** The Starlight docs site shall include a `/skills/` index page rendering each skill's frontmatter as a card with trigger examples. [P] Dependencies: AC-1-1

## Validation

- **Static layer**: `tsc --noEmit` over `packages/mcp`, `packages/cli`, `packages/analysis` must pass. Every new file typed.
- **Plugin layer**: invoke `plugin-dev:plugin-validator` against `plugins/opencodehub/`. Must report zero errors on frontmatter, tool allowlists, and manifest.
- **Behavioral layer**: self-test inside the repo root — run `/codehub-document` against this repo, assert `.codehub/docs/` contains ≥10 files, assert `.docmeta.json` validates, assert every `See also` link resolves. Spot-check three citations resolve to real files.
- **Regression layer**: existing `/probe`, `/verdict`, `/audit-deps`, `/rename`, `/owners` must still work. Run each once post-change.

## Risks (see synthesis §Risks)

1. Parallel subagent ceiling — verify current release
2. Subagent tool sprawl context bloat
3. Bedrock credential gating
4. Precompute size explosion on large repos

## References

- `/.erpaval/brainstorms/001-opencodehub-next-strategy.md` — Rumelt kernel
- `/.erpaval/brainstorms/002-opencodehub-artifact-skills-prd.md` — PRD
- `/.erpaval/brainstorms/003-opencodehub-skill-interface-design.md` — SKILL.md frontmatter
- `/.erpaval/brainstorms/004-opencodehub-subagent-prompts.md` — doc-* agent prompts
- `/.erpaval/brainstorms/005-opencodehub-output-conventions.md` — output contract
- `/.erpaval/brainstorms/006-synthesis-whats-next.md` — synthesis + tension resolutions
