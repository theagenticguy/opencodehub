---
name: codehub-document
description: "Use when the user asks to generate, regenerate, or refresh long-form codebase documentation, an architecture book, a module map, or a per-repo reference — especially after `codehub analyze` finishes or after a large merge. Examples: \"document this repo\", \"regenerate the architecture docs\", \"write a module map for the monorepo\", \"produce a group-wide portfolio doc\". DO NOT use if the repo is not indexed — run `codehub analyze` first and confirm `mcp__opencodehub__list_repos` returns the repo. DO NOT use for PR descriptions (use `codehub-pr-description`), onboarding docs (use `codehub-onboarding`), or cross-repo contract maps alone (use `codehub-contract-map`)."
allowed-tools: "Read, Write, Edit, Glob, Grep, Bash(codehub:*), mcp__opencodehub__list_repos, mcp__opencodehub__project_profile, mcp__opencodehub__query, mcp__opencodehub__context, mcp__opencodehub__impact, mcp__opencodehub__dependencies, mcp__opencodehub__owners, mcp__opencodehub__risk_trends, mcp__opencodehub__route_map, mcp__opencodehub__tool_map, mcp__opencodehub__list_dead_code, mcp__opencodehub__list_findings, mcp__opencodehub__verdict, mcp__opencodehub__group_list, mcp__opencodehub__group_query, mcp__opencodehub__group_status, mcp__opencodehub__group_contracts, mcp__opencodehub__sql, Task"
argument-hint: "[output-dir] [--group <name>] [--committed] [--refresh] [--section <name>]"
color: indigo
model: sonnet
---

# codehub-document

Primary artifact generator. Produces a tree of cross-linked Markdown under `.codehub/docs/` (single-repo) or `.codehub/groups/<name>/docs/` (group mode) using the codeprobe-pattern four-phase orchestration.

**Model policy.** This skill runs on Sonnet by default. Switch to Opus only when `--refresh --group` is combined — the refresh pruning + partial subagent fan-out needs the extra judgment. Full-scan single-repo generation does not.

## Preconditions (check before Phase 0)

1. `mcp__opencodehub__list_repos` returns the target. If not, emit `Run codehub analyze first — repo <name> is not indexed.` and stop.
2. `codehub status` reports fresh. If stale, emit `Run 'codehub analyze' first — index is stale` and stop.
3. Group mode only: `mcp__opencodehub__group_status({group})` must return `fresh: true` for every member. If any member is stale, abort and name each stale repo.

## Arguments

- `[output-dir]` (optional positional) — where to write. Default is `.codehub/docs/` (gitignored). With `--committed`, default flips to `docs/codehub/` and the skill does not add a `.gitignore` entry.
- `--group <name>` — enable group mode. Phase 0 calls `group_list` + `group_status` + `group_contracts` + `group_query`. Phase CD dispatches `doc-cross-repo`.
- `--committed` — write under `docs/codehub/` (or user-supplied path) instead of `.codehub/docs/`. Does not touch `.gitignore`.
- `--refresh` — consult `.docmeta.json`, regenerate only stale sections. Phase E always re-runs.
- `--section <name>` — regenerate a single named section (e.g., `architecture/system-overview`) and re-run Phase E. Useful for targeted updates.

## Four-phase orchestration

### Phase 0 — Precompute shared context (inline, no subagent)

Write two files. Subagents read them instead of re-calling tools.

**`<docs-root>/.context.md` (hard 200-line cap)** — see `references/data-source-map.md` for the full layout. Sections:

- Repo profile (from `project_profile`)
- Top communities (from `sql` over `nodes WHERE kind='Community' ORDER BY cohesion DESC LIMIT 10`)
- Top processes (from `sql` over `nodes WHERE kind='Process' ORDER BY step_count DESC LIMIT 10`)
- Routes (from `route_map`, truncated to 25 rows)
- MCP tools (from `tool_map`, truncated to 25 rows)
- Owners summary (from `owners` on top 5 folders)
- Staleness envelope (from `list_repos._meta.codehub/staleness`)
- In group mode: group manifest + `group_contracts` consumer/producer matrix + `group_status` freshness table

**`<docs-root>/.prefetch.md`** — newline-delimited JSON, one record per tool call with `{tool, args, sha256, keys, cached_at}`. Example line:

```json
{"tool":"project_profile","args":{"repo":"opencodehub"},"sha256":"…","keys":["languages","stacks","entryPoints"],"cached_at":"2026-04-27T18:04:11Z"}
```

Per-subsection truncation records a `truncated: true` flag per section so subagents know they see a cap, not the firehose.

### Phase AB — Content subagents in parallel

Dispatch four subagents in a single message with four `Agent` tool calls:

1. `doc-architecture`
2. `doc-reference`
3. `doc-behavior`
4. `doc-analysis`

Each reads `.context.md` + `.prefetch.md` first.

In group mode, fan-out multiplies by the member count (4 × N subagents). Claude Code's concurrent-Agent ceiling is ~10 per message — for groups of 3+ repos, batch by role: all `doc-architecture` calls in message 1, all `doc-behavior` in message 2, etc.

### Phase CD — Diagrams + specialty in parallel

Dispatch two subagents:

1. `doc-diagrams`
2. `doc-cross-repo` — **group mode only**. Skipped silently in single-repo mode.

### Phase E — Cross-reference assembler (inline, deterministic)

No LLM call. Pure regex + join. See `references/cross-reference-spec.md` for the full algorithm. Summary:

1. Extract every backtick `<path>:<LOC>` (or `<repo>:<path>:<LOC>`) citation from every generated Markdown file.
2. Build a co-occurrence index: `source_file → [docs_citing_it]`.
3. For any two docs sharing ≥ 2 common sources, append `## See also` (3–5 links) to both.
4. In group mode, any `cross-repo/*.md` additionally gets `## See also (other repos in group)` linking into sibling repos' generated docs.
5. Write `<docs-root>/README.md` (landing page with the structure-is-deterministic disclaimer) and `<docs-root>/.docmeta.json`.

## `--refresh` algorithm

See `references/cross-reference-spec.md § --refresh algorithm` for the full procedure. One-line summary: compare `max(mtime(section.sources[]))` against `section.mtime`, regenerate only stale sections, always re-run Phase E.

## Progressive disclosure — references/

| Reference                          | When to consult                                          |
| ---------------------------------- | -------------------------------------------------------- |
| `references/document-templates.md` | Per-file structural templates (what goes in each section)|
| `references/data-source-map.md`    | Which MCP tools feed which subagent                      |
| `references/cross-reference-spec.md` | Phase E algorithm + `.docmeta.json` schema + `--refresh` |
| `references/mermaid-patterns.md`   | Mermaid idioms for each diagram type                     |

## Quality checklist

- [ ] Phase 0 wrote both files; `.context.md` is ≤ 200 lines.
- [ ] Phase AB dispatched in a single message (or role-batched if > 10 agents in group mode).
- [ ] Every generated file has H1 = identifier, no YAML frontmatter.
- [ ] Every factual claim has a backtick citation (`path:LOC` or `repo:path:LOC`).
- [ ] Phase E wrote `.docmeta.json` validating against the schema in `references/cross-reference-spec.md`.
- [ ] `See also` footers appear on every doc with ≥ 2 shared citations.
- [ ] Group mode: `cross-repo/*.md` files use `repo:path:LOC` citations exclusively.
- [ ] `codehub status` is fresh before this skill starts; otherwise the preconditions caught the stale state.
