# OpenCodeHub Artifact-Generation Skills — PRD

**Owner:** Laith Al-Saadoon (AGS Tech AI Engineering NAMER)
**Status:** Draft v1 — 2026-04-27
**Surface:** `plugins/opencodehub/` (Claude Code plugin)

---

## Problem

OpenCodeHub ships 28 MCP tools and a Claude Code plugin that covers five *analytical* commands (`/probe`, `/verdict`, `/audit-deps`, `/rename`, `/owners`) plus six exploration skills. Every current surface answers questions at the speed of chat. None of them produce a committed Markdown artifact — the durable unit of output that Principal engineers actually ship: ADRs, architecture maps, onboarding guides, PR descriptions, release notes, cross-repo contract matrices.

Two concrete gaps for Claude-Code-as-artifact-producer:

1. **Artifacts are invisible.** `codehub wiki --llm` already exists inside the CLI (Bedrock + `@opencodehub/summarizer`) and emits Markdown, but it is not wrapped as an MCP tool, not reachable from Claude Code, and not composed with the graph queries an agent has just run. The committed-file workflow lives only in the terminal, behind a flag nobody invokes.
2. **The multi-repo lever is idle.** The `group_list` / `group_query` / `group_status` / `group_contracts` / `group_sync` tools are the single feature no other code-graph tool has (the base pattern is single-repo, GitNexus is single-repo, SCIP graphs are per-package). Yet there is zero plugin surface that synthesizes a cross-repo artifact. Platform architects still hand-draw the same contract-drift diagrams every quarter.

The the four-phase `/document` skill proved the pattern works: single skill, 8 parallel subagents, 33 cross-linked Markdown files, `.docmeta.json` sidecar, source citations with LOC, Mermaid instead of PNG. We port it, adapt it to OpenCodeHub's graph + supply-chain tools, and extend it with group mode.

---

## Users and job stories

**Repo onboarder** (new contributor or an LLM inheriting the repo).
*When* I clone a repo or get assigned a group, *I want* auto-generated onboarding docs tied to the current graph, *so that* I navigate the system without the 3-day ramp. **Bad outcome to avoid:** a stale handwritten `ONBOARDING.md` that cites deleted files and teaches me the wrong entry points.

**Platform architect** (owns a cross-repo group — e.g., `gts-platform`).
*When* a contract changes across repos, *I want* a cross-repo architecture artifact regenerated from `group_contracts` + `group_query`, *so that* my design reviews don't drift off the true consumer/producer topology. **Bad outcome to avoid:** approving a breaking change because my mental model of who calls `/v1/verdict` was six months out of date.

**Release manager / PR author**.
*When* I cut a PR or a release, *I want* draft-quality Markdown generated from `detect_changes` + `verdict` + `owners` + `list_findings_delta`, *so that* I stop re-explaining what shipped. **Bad outcome to avoid:** a PR description that says "refactor" while `impact` shows tier-2 blast radius on three services.

---

## Solution shape

One primary skill — **`/codehub-map`** — plus a cluster of four specialized skills. I chose `map` over `document` for three reasons: (1) `/document` collides with verbatim, which risks confusion across tools; (2) "map" foregrounds the graph-origin of the artifacts (this is a *map of the code graph*, not prose description); (3) it scales cleanly to group mode ("map this group").

| Skill | Invocation | Argument hint | Precondition | Output path(s) | Primary MCP tools | Shared-context phases reused |
|---|---|---|---|---|---|---|
| **`/codehub-map`** (P0) | `/codehub-map` | `[output-dir] [--group <name>] [--section <name>] [--since <rev>] [--committed] [--refresh]` | `codehub status` is fresh; in group mode, every repo in the group is fresh | `.codehub/docs/` (repo) or `.codehub/groups/<name>/docs/` (group) | `list_repos`, `project_profile`, `query`, `context`, `impact`, `owners`, `route_map`, `tool_map`, `risk_trends`, `group_contracts`, `group_query`, `group_status`, `list_findings`, `license_audit`, `verdict` | Phases 0 / AB / CD / E — full |
| **`/codehub-pr-description`** (P0) | `/codehub-pr-description` | `[--base <rev>] [--out <path>]` | Repo has uncommitted or PR-range changes | `.codehub/pr/PR-<branch>.md` (default) or user-supplied | `detect_changes`, `verdict`, `owners`, `list_findings_delta`, `api_impact`, `shape_check` | Phase 0 only (lightweight precompute) |
| **`/codehub-onboarding`** (P0) | `/codehub-onboarding` | `[--committed] [--group <name>]` | Index is fresh | `.codehub/ONBOARDING.md` or `docs/ONBOARDING.md` with `--committed` | `project_profile`, `route_map`, `tool_map`, `owners`, `query`, `group_status` | Phase 0 + a single specialized subagent |
| **`/codehub-contract-map`** (P1) | `/codehub-contract-map <group>` | `<group> [--out <path>]` | `group_status` reports all repos fresh | `.codehub/groups/<name>/contracts.md` | `group_list`, `group_contracts`, `group_query`, `route_map`, `shape_check` | Phase 0 + Phase CD specialty (Mermaid) |
| **`/codehub-adr`** (P1) | `/codehub-adr "<problem>"` | `"<problem-statement>" [--target <symbol>]` | Repo index fresh | `docs/adr/NNNN-<slug>.md` (committed by default — ADRs are durable) | `impact`, `context`, `risk_trends`, `owners` | Phase 0 lightweight precompute |

**P0 = `/codehub-map`, `/codehub-pr-description`, `/codehub-onboarding`.** Justification: `/codehub-map` is the flagship analogue of the four-phase `/document` and unlocks the entire 4-phase pattern; `/codehub-pr-description` has the highest frequency of use (every PR) and the shortest agent path; `/codehub-onboarding` is the lowest-effort v1 output that immediately showcases the graph. `/codehub-contract-map` is P1 because it depends on having two or more indexed repos in a group — the install base on day one is small. `/codehub-adr` is P1 because the template market is crowded; we ship once the core pattern is landed.

---

## Architecture — the four-phase pattern, adapted

**Phase 0 — precompute shared context to disk.** Replace the base pattern's `<sibling>/summary.json` requirement with `codehub status` + a Phase-0 writer. The skill writes two files:

- `.codehub/.context.md` — project name, `project_profile` output, top-level dirs, stack detection, and (in group mode) the member-repo list from `group_list`. Under 200 lines.
- `.codehub/.prefetch.md` — graph pre-fetch, three strategic blocks:
  1. `query` top-20 symbols by score (grouped by process), for breadth.
  2. `risk_trends` last-30-days summary (per-community trend lines).
  3. `owners` table for the top-30 hotspot files (resolved from `risk_trends` + `sql`).
  4. `route_map` full HTTP surface if any Route nodes exist.
  5. `tool_map` full MCP-tool surface if any Tool nodes exist.
  6. Group mode only: `group_contracts` consumer-producer matrix + `group_status` staleness table.

**Phase AB — content generation, 4 subagents in parallel** (the base pattern runs 6; OpenCodeHub's surface is narrower because supply-chain tools already pre-digest). Dispatched in a single message with 4 `Agent` tool calls:

| Subagent | Output files |
|---|---|
| `doc-architecture` | `project-overview.md`, `architecture/system-overview.md`, `architecture/components.md`, `architecture/dependencies.md` |
| `doc-behavior` | `behavior/processes.md`, `behavior/routes.md`, `behavior/tools.md` |
| `doc-supply-chain` | `supply-chain/findings.md`, `supply-chain/licenses.md`, `supply-chain/dead-code.md` |
| `doc-hotspots` | `hotspots/risk-trends.md`, `hotspots/owners.md`, `hotspots/co-changes.md` |

Each subagent reads `.context.md` + `.prefetch.md` first. Tool access: `Read`, `Grep`, `Glob`, plus the `mcp__opencodehub__*` tools named in its row; no Bash except to run `sql` queries via the MCP tool.

**Phase CD — diagrams + specialty, 2 subagents in parallel.**

| Subagent | Output files | Mode |
|---|---|---|
| `doc-diagrams` | `diagrams/architecture.md`, `diagrams/data-flow.md`, `diagrams/process-map.md` | Both |
| `doc-cross-repo` | `cross-repo/portfolio-map.md`, `cross-repo/contracts.md`, `cross-repo/dependency-flow.md` | Group mode only |

Mermaid is sourced from `sql` queries over `relations` (CONTAINS, CALLS, HANDLES_ROUTE, FETCHES). Never rendered to PNG/SVG.

**Phase E — cross-reference assembler (inline, no subagent).** Preserve the base pattern's Phase E algorithm: extract H1 + backtick `<path>[:<LOC>]` references, build co-occurrence (≥2 shared refs), append `See also` footers (3-5 links, bidirectional override), write `README.md` + `.docmeta.json`. **Novel element:** when two or more repos are mapped together, Phase E builds a **cross-repo link graph** — for every `docs/` tree it finds under `.codehub/groups/<name>/<repo>/`, it links per-repo documents to the sibling repo's equivalent section (e.g., `repo-a/behavior/routes.md` ↔ `repo-b/behavior/routes.md` when `group_contracts` shows `repo-a` FETCHES a route produced by `repo-b`). This is the payoff: navigating one repo's docs jumps you to the consumer/producer on the other side, something no single-repo generator can do.

---

## Multi-repo strategy — the wedge

**Single-repo mode** (default, no `--group`). Phase 0 reads one repo; Phases AB/CD/E behave exactly like the single-repo analogue. Output at `.codehub/docs/`.

**Group mode** (`--group <name>` OR the cwd matches a registered group root — autodetected via `group_list`). Phase 0 calls `group_contracts`, `group_query`, `group_status`; Phase AB fans out 4 × N subagents (4 per repo). Claude Code's parallel-agent ceiling is ~10 concurrent tool calls per message, so for groups of 3+ repos we batch: all `doc-architecture` agents in message 1, all `doc-behavior` in message 2, etc. Phase CD's `doc-cross-repo` synthesizes the portfolio-level artifacts. Output at `.codehub/groups/<name>/docs/` with per-repo subtrees + one `cross-repo/` root.

**Incremental mode** (`--since <rev>`). Reads `.docmeta.json`, compares each section's `generated_at` to the mtime of its declared `data_sources` resolved to `.codehub/` artifacts + git blame range since `<rev>`. Regenerates only the dirty sections. Always re-runs Phase E because cross-links shift.

---

## Freshness + hooks

Extend `plugins/opencodehub/hooks.json`:

- After the existing PostToolUse auto-reindex on `git commit|merge|rebase|pull`, if `.codehub/docs/.docmeta.json` exists, emit a `systemMessage`: *"Docs at `.codehub/docs/` may be stale (graph hash changed). Run `/codehub-map --refresh` when convenient."* **Non-blocking.** We never auto-regenerate — regeneration spends Bedrock credits and takes 30-90 s, both of which the user must consent to.
- Precondition gate inside every artifact skill: call `codehub status` first. If staleness > 0 commits, the skill refuses and prints `Run 'codehub analyze' first.` The frontmatter `description` advertises this gate.
- Group-mode freshness: `group_status` must return `fresh: true` for every member. One stale member fails loudly with the repo name — no silent partial regeneration.

---

## Output contracts

- **Default location:** `.codehub/docs/` (gitignored, colocated with every other codehub artifact). Flag `--committed` writes to `docs/codehub/` instead and omits the `.gitignore` entry. ADRs are the single exception — they default to committed, because an ADR that isn't in git isn't an ADR.
- **Citations:** backtick `<path>:<LOC>` inline, exactly like the base pattern. Phase E's regex extends to accept the `:LOC` suffix.
- **No YAML frontmatter** on output docs. H1 is the identifier.
- **`.docmeta.json` schema** (extended):
  ```json
  {
    "generated_at": "ISO-8601",
    "codehub_graph_hash": "sha256:…",
    "mode": "single|group",
    "group": "<name or null>",
    "sections": { "<name>": { "agent": "…", "generated_at": "…", "data_sources": [...], "files_produced": [...] } },
    "cross_repo_refs": [ { "from": "repo-a/behavior/routes.md", "to": "repo-b/behavior/routes.md", "reason": "FETCHES->HANDLES_ROUTE" } ]
  }
  ```
- **Mermaid code blocks allowed, SVG/PNG never generated.**

---

## Acceptance criteria (EARS)

1. When the user invokes `/codehub-map` and the index is fresh, the system shall write at least 10 Markdown files under the output directory and a valid `.docmeta.json`.
2. When `codehub status` reports staleness, the system shall refuse to run `/codehub-map`, `/codehub-onboarding`, `/codehub-contract-map`, or `/codehub-adr` and shall print a single-line remediation hint.
3. When `/codehub-map --group <name>` is invoked and any member repo is stale, the system shall abort and shall name the stale repo(s) in the error.
4. When Phase E completes, every non-diagram document shall end with a `See also:` footer containing between 3 and 5 links and every link shall resolve to a file that exists.
5. When group mode is active, the system shall produce a `cross-repo/portfolio-map.md` that includes one Mermaid block sourced from `group_contracts`.
6. When `/codehub-map --refresh` is invoked, the system shall regenerate only sections whose declared `data_sources` have an mtime newer than the section's `generated_at`, and shall always re-run Phase E.
7. When `/codehub-map --committed` is invoked, the system shall write under `docs/codehub/` rather than `.codehub/docs/` and shall not add any entry to `.gitignore`.
8. When `/codehub-pr-description` is invoked inside a branch with changes, the system shall write a Markdown file whose body cites `verdict` tier, `detect_changes` affected symbols, and the `owners` reviewers for every touched file.

---

## Open questions / risks

- **Precompute size vs Bedrock cost.** Phase 0 `.prefetch.md` can balloon on large repos. Cap each section at ~500 lines and emit a truncation notice. Decide: does Phase 0 call the summarizer MCP tool (wrap `codehub wiki --llm` at last) or keep it as raw graph output? Leaning raw + let Phase AB agents summarize inline.
- **Parallel subagent ceiling.** Claude Code's practical ceiling is around 10 concurrent Agent tool calls per message. Groups larger than 2 repos must batch by subagent role, not by repo. Need to verify against current Claude Code release.
- **Naming collision.** `/document` is taken by the base pattern. `/codehub-map` avoids it. Consider prefixing all five skills with `codehub-` consistently for namespace hygiene.
- **Starlight site duplication.** The repo already has an Astro Starlight docs site with `llms.txt`. Generated artifacts should stay per-repo (under `.codehub/` or `docs/codehub/`) — the site stays meta and curated. We do not auto-publish generated docs into Starlight; that would couple generation to the site build and invalidate `--committed` semantics.
- **Bedrock credentials for the summarizer.** Any skill that invokes the summarizer needs AWS credentials on the host. Document the failure mode: if Bedrock is unreachable, skills degrade to raw graph output, never block.

---

## Scope — v1

**IN:** `/codehub-map` (single + group), `/codehub-pr-description`, `/codehub-onboarding`, the Phase 0 / AB / CD / E pipeline, shared-context precompute to disk, `.docmeta.json` schema with `cross_repo_refs`, the post-reindex systemMessage hook extension, `--refresh` + `--committed` + `--since` flags.

**OUT:** hosted web UI, SVG/PNG diagram generation, non-Claude-Code LLM support, custom/fine-tuned summarizer models, Starlight auto-publish, `/codehub-adr` (moved to P1), `/codehub-contract-map` as a standalone skill (folded into `/codehub-map --group` for v1).
