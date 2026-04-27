# OpenCodeHub — What's Next: A Strategy Thesis

*Author: CSO pass, 2026-04-27. Audience: Laith (owner). Frame: Rumelt kernel (diagnosis → guiding policy → coherent actions).*

## 1. Diagnosis

OpenCodeHub has shipped a remarkable retrieval surface: 28 MCP tools across six families, five prompts, a six-skill Claude Code plugin with PreToolUse context injection and PostToolUse reindex hooks, an Astro Starlight doc site with llms.txt and per-page Copy-as-Markdown / Open-in-Claude affordances, and — crucially — a working LLM-assisted wiki generator (`codehub wiki --llm`) that already routes through `@opencodehub/summarizer` and Bedrock Converse to emit Markdown. The single-repo version of "produce good docs from the graph" is *already solved* in this repo, buried one layer below the agent.

And yet: Claude Code users do not spontaneously produce artifacts from OpenCodeHub. The plugin's six skills are all analysis-flavored (guide, exploring, impact-analysis, debugging, refactoring, pr-review). None of them emit a document. The five slash commands (`/probe`, `/verdict`, `/audit-deps`, `/rename`, `/owners`) are investigative, not generative. The `generate-map` MCP prompt sketches an ARCHITECTURE.md but no command or skill invokes it. The wiki generator is CLI-only and therefore invisible to an agent session. The cross-repo `group_*` tools retrieve but do not synthesize.

The symptom is "low artifact throughput." The root cause is a **missing artifact layer**: OpenCodeHub has retrieval primitives and a group abstraction, and it has a synthesis engine (`summarizer` + wiki generator), but nothing in the Claude Code surface area connects them. Users would have to know the CLI, know the summarizer exists, know the group tools exist, and hand-compose the orchestration themselves.

**The crux is (a) no artifact-producing skill exists in the plugin — and specifically, no skill that operates at the *group* level.** Candidates (b) and (c) are downstream of (a): exposing the wiki generator as MCP only matters if something drives it; group synthesis only matters if a skill calls for it. (d) and (e) are framing issues that dissolve once a concrete artifact skill ships. Solve (a) at the group level and the rest become execution. *Assumption: codeprobe's `/document` pattern generalizes — the same 4-phase orchestration (precompute → parallel doc-* subagents → cross-ref assembler) holds at the group level because the shared-context file pattern is topology-agnostic.*

## 2. Guiding policy

**Ship the codeprobe `/document` pattern at the group level — an artifact-producing skill family backed by a group-synthesis MCP surface, with the existing wiki generator as the per-repo building block.**

This is the wedge. codeprobe owns single-repo documentation; OpenCodeHub owns *multi-repo* documentation by inheriting codeprobe's orchestration and adding the only thing codeprobe structurally cannot do — cross-repo synthesis over the group graph. The group_* tools become the retrieval substrate; the wiki generator becomes the per-repo leaf; a new group-synthesis MCP tool becomes the cross-repo join; a new skill family becomes the user-facing driver.

**What this policy rules out:**

- **No new retrieval tools until the artifact layer ships.** The surface is already large. Adding more retrieval without synthesis deepens the gap between capability and workflow.
- **No web UI, no hosted service, no non-Claude-Code clients.** Every surface ships as MCP tool, slash command, or skill. If Claude Code cannot drive it, it does not exist this quarter.
- **No analysis-flavored skills.** The next six skills must all emit artifacts to disk.
- **No head-on competition with Copilot / Cursor.** Those tools do not do multi-repo artifact synthesis from a cross-repo graph. That is the defensible seam.

## 3. Coherent actions

All actions mutually reinforce the policy: each produces an artifact or exposes the synthesis path Claude Code needs to generate one. Priority tiers: **P0** = this quarter, **P1** = next, **P2** = later.

**A. [P0, single-track] Ship `/document-group` skill at `plugins/opencodehub/skills/opencodehub-document-group/`.** The flagship. Mirrors codeprobe's `/document` 4-phase orchestration (Phase 0 precompute → AB parallel doc-* subagents → CD round-two → E inline cross-ref assembler), but the unit of work is a *group* not a repo. Emits an `.opencodehub/docs/` tree rooted at the group: `00-group-overview.md`, `10-<repo>/*.md` per member repo, `90-contracts.md` for inter-repo contracts, `99-glossary.md`. Uses `references/*.md` for progressive disclosure (document-templates, group-data-source-map, cross-repo-reference-spec, mermaid-patterns). Reads shared-context files `.context.md` and `.opencodehub-prefetch.md` written by Phase 0. Depends on action B.

**B. [P0, single-track, unblocks A] Expose group synthesis as MCP: `group_wiki` and `group_synthesize`.** `group_wiki` lifts the existing `generateWiki` from the CLI into an MCP tool that fans out across group members and returns a manifest of per-repo Markdown paths; `group_synthesize` consumes `group_contracts` + `group_query` output and emits the cross-repo join sections (shared types, boundary contracts, call graphs that cross repo lines). Both tools live in `packages/mcp-server/`. *Assumption: `@opencodehub/summarizer` is stateless enough to be invoked from an MCP worker — the CLI path proves the Bedrock wiring.*

**C. [P0, parallel-track with A] `.opencodehub-prefetch.md` precompute contract.** A typed, deterministic prefetch file written by Phase 0 of `/document-group`. Contains: group manifest, per-repo symbol counts, cross-repo edges, owners map, top modules by in-degree. Every doc-* subagent reads it — prompt dedup via filesystem, same pattern codeprobe validated. Schema and writer live in `packages/analysis/src/prefetch.ts`.

**D. [P0, parallel-track with A] `.docmeta.json` sidecar + `--refresh` semantics.** Compare source-artifact mtimes (graph hash, prefetch hash, member repo HEADs) to section mtimes; regenerate only stale sections. Reuses codeprobe's sidecar shape verbatim. Drives freshness.

**E. [P1, deferred-blocked-by A, B] PostToolUse hook: auto-refresh group docs on `git commit`/`merge`.** Extend `plugins/opencodehub/hooks.json`. On commit-to-main in any group member, enqueue `/document-group --refresh` for that group. Makes freshness free. Compete on *documentation freshness* as the second-order moat.

**F. [P1, parallel-tracks] Three satellite artifact skills.** `/document-repo` (single-repo, wraps the existing wiki generator — proves the pattern before committing to group scope at scale), `/document-contracts` (API/type boundaries only — the thinnest useful slice of group synthesis), `/document-onboarding` (new-engineer "read these N files in this order" walkthrough generated from graph centrality). Each under 300 lines of skill prose; all reuse the prefetch contract from C.

**G. [P1, single-track] Discoverability: rewrite `plugins/opencodehub/README.md` around artifacts-first.** Lead with "OpenCodeHub produces docs for Claude Code, it doesn't just retrieve them." Update `/probe` help text to surface `/document-group` as the next step. Update the Starlight doc site landing page. *Assumption: llms.txt should also list the artifact commands, not just retrieval tools — mirror the wedge in the LLM-consumable index.*

## 4. What we are not doing

- **No web UI or hosted dashboard.** Claude Code is the client. Every feature ships as MCP / slash command / skill or it doesn't ship.
- **No more retrieval tools this quarter.** 28 is enough. Stop expanding the surface until the artifact layer catches up.
- **No indexer rewrite in Rust or Go.** Commit f8454b5 (cross-node batching + worker pool) bought the perf headroom; further performance work is premature.
- **No non-Claude-Code LLM integrations.** No Cursor plugin, no Continue.dev adapter, no OpenAI Assistants flavor. The wedge is Claude Code + cross-repo; splitting focus across clients forfeits it.
- **No direct competition with Copilot / Cursor on inline autocomplete or chat.** Those tools are agentic editors; OpenCodeHub is an artifact factory. Staying out of their lane is the point.
- **No generative-UX experiments (diagrams-as-a-service, custom viewers, embedded iframes).** Mermaid in Markdown is sufficient. Markdown is the format Claude Code already writes best.

## 5. One-sentence strategy thesis

**OpenCodeHub's wedge is becoming the artifact factory for Claude Code at the group level: ship a `/document-group` skill backed by `group_wiki` + `group_synthesize` MCP tools that lift codeprobe's single-repo documentation pattern into multi-repo cross-repo synthesis, and compete on documentation freshness via commit-driven auto-refresh.**
