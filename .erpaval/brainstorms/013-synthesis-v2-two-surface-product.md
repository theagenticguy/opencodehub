# 013 — Synthesis v2: OpenCodeHub as a Two-Surface Product

*Rewritten 2026-04-27 to reflect locked scope. Supersedes the earlier draft that included HTTP MCP + agent SDK + `grounding_pack`. Inputs carried forward: 001 Strategy, 002 PRD (artifact skills), 003–005 Design, 006 Synthesis v1, 007 Strategy v2 (diagnosis retained, transport rejected), 008 PRD v2 (lifecycle retained, SDK dropped), 009–011 Design v2 (HTTP/SDK rescinded, CI workflows retained), 012 Competitive Landscape. This memo is the current unified recommendation and the handoff to the Act phase.*

## Locked scope decisions (2026-04-27)

Three product-scope decisions constrain this synthesis and every follow-on:

1. **Self-hosted OSS only.** No hosted service, no managed tier, no OpenCodeHub-operated infrastructure. Ever. (Memory: `project_opencodehub_no_saas.md`.)
2. **No remote / HTTP MCP server.** MCP stays stdio-only, for the Claude Code plugin on the developer's laptop. (Memory: `project_opencodehub_no_http_mcp_no_sdk.md`.)
3. **No agent SDK.** No `@opencodehub/agent-sdk` (Python or TypeScript), no `@opencodehub/claude-hooks`, no framework adapters. Agents that want OpenCodeHub grounding either use the Claude Code plugin on a laptop or shell out to the `codehub` CLI inside CI. (Same memory.)

These decisions are load-bearing. Every item below is derivable from them.

## The thesis in one paragraph

**OpenCodeHub is a self-hosted OSS product with two surfaces, unified by a single offline-safe cross-repo graph.**

- **Surface one — Laptop artifact factory.** A Claude Code plugin that turns the graph into committed Markdown. `codehub-document`, `codehub-pr-description`, `codehub-onboarding`, `codehub-contract-map` all ship in the P0 family. Stdio MCP, Claude Code plugin, local filesystem output. This is the visible, immediate wedge.

- **Surface two — CI action surface (CLI-wrapping, deferred).** OSS GitHub Actions (and GitLab templates) that shell out to the `codehub` CLI inside the customer's own runner. `analyze-action`, `verdict-action`, a `codehub verdict` CLI subcommand, `opencodehub.policy.yaml` schema. No HTTP server, no SDK install, no OpenCodeHub-operated infrastructure. This is the structural, slower wedge.

The two surfaces share the graph, the CLI, and the codebase. They are two skins on one primitive. Spec 001 ships first; spec 002 follows after adoption signal.

## Why drop HTTP MCP + the agent SDK

The earlier draft argued the HTTP + SDK combo as the fastest way to reach runner-resident agents. Three reasons to unwind that bet:

1. **CLI-wrapping actions cover the same ground at a fraction of the surface area.** A GitHub Action that shells `codehub verdict --policy file.yaml` gives the customer the same deterministic merge gate as an HTTP-MCP-backed `policy_evaluate` tool. No authentication flow, no presigned URLs pinging a server, no SDK version compatibility — just a CLI call inside the customer's runner against a graph blob cached in Actions Cache.

2. **HTTP MCP forces operational commitments that don't compose with self-hosted OSS.** A remote MCP server implies an OAuth issuer, a JWKS endpoint, a JWT issuer the customer operates, graph access from a networked service. Each of those is a customer-run component we'd have to document, support, and stabilize — while offering no capability the CLI doesn't already deliver inside a runner.

3. **An SDK without HTTP is an SDK over stdio — which is what the Claude Code plugin already is.** The SDK was only valuable if it sat in front of a server. Without the server, the SDK either duplicates the plugin or shells the CLI — in both cases we prefer direct consumption.

The competitive reframe from 012 still holds: agents are running in ephemeral cloud runners. The reframe does **not** dictate HTTP as the transport. A CI action that runs `codehub analyze` + `codehub verdict` inside that same ephemeral runner is a cleaner fit than an HTTP server the runner dials out to.

## What ships · P0 (spec 001 — laptop artifact factory)

The complete P0 family. Ships first. Ships together. Not blocked by spec 002.

1. **`codehub-document`** — primary skill. Single-repo and group mode. 4-phase orchestration (Phase 0 precompute → AB parallel → CD parallel → E assembler).
2. **Six `doc-*` subagents** — `doc-architecture`, `doc-reference`, `doc-behavior`, `doc-analysis`, `doc-diagrams`, `doc-cross-repo` (group-only).
3. **Phase 0 precompute** — writes `.codehub/.context.md` (200-line cap) and `.codehub/.prefetch.md` (JSON tool-call ledger). Shared across every subagent.
4. **`.docmeta.json` + Phase E assembler** — deterministic citation regex, See-also footers, `--refresh` algorithm, cross-repo link graph in group mode.
5. **`codehub-pr-description`** — linear skill, no subagents. Markdown PR body from `detect_changes` + `verdict` + `owners` + `list_findings_delta`.
6. **`codehub-onboarding`** — one specialty subagent. `ONBOARDING.md` with ranked reading order from graph centrality.
7. **`codehub-contract-map`** — promoted from P1 on 2026-04-27. Group-only standalone skill. Renders `group_contracts` + `group_query` + `route_map` into Markdown + Mermaid. Fires on "map the contracts" / "contract matrix" invocations without needing the full `codehub-document` orchestration.
8. **PostToolUse staleness hook** — non-blocking `systemMessage` after `git commit|merge|rebase|pull` when `graph_hash` drifts and `.docmeta.json` exists.
9. **Discoverability patches** — guide-skill Skills table, `codehub analyze` completion hint, `next_steps[]` suggestions on `verdict` / `detect_changes`, Starlight `/skills/` index page.

Spec: `.erpaval/specs/001-claude-code-artifact-surface/spec.md`. Updated this session with `codehub-contract-map` promoted and three new ACs (AC-2-7, AC-3-4, AC-5-5).

## What ships · P1 (spec 002 — CI action surface, deferred)

Only after spec 001 has traction. All CLI-wrapping; zero HTTP server; zero SDK.

1. **`opencodehub/analyze-action@v1`** — shells `codehub analyze`, uploads graph to configured storage backend.
2. **`opencodehub/verdict-action@v1`** — shells `codehub verdict --policy ...`, posts GitHub Check with per-rule annotations, applies `opencodehub:auto-approve` label on full pass.
3. **`opencodehub/token-action@v1`** — OIDC → JWT for the customer's own storage-backend presign flow (only relevant when the customer opts into bucket-backed storage).
4. **`codehub verdict` CLI subcommand** — new subcommand; consumes `opencodehub.policy.yaml`, emits structured verdict JSON. Byte-identical on unchanged inputs.
5. **`opencodehub.policy.yaml` schema v1** — four rule types: `blast_radius_max`, `license_allowlist`, `ownership_required`, `arch_invariants` (scaffolded, feature-flagged).
6. **Graph storage · Tier 0 (Actions Cache)** — default backend via `actions/cache@v4`. Zero customer infrastructure.
7. **`codehub-adr` skill** — pushed from spec 001 P1 into the laptop family's P1 backlog. Ships when there's appetite.

Spec: `.erpaval/specs/002-agent-grounding-plane/spec.md` (rewritten this session — directory name retained for history; contents are now CI-action-surface, CLI-wrapping).

## What ships · P2 (later)

- `arch_invariants` flag flipped default-on (after field data from design partners)
- GitLab CI templates (after GitHub Actions prove the shape)
- Customer-self-hosted GitHub App (not an OpenCodeHub-operated App — a container the customer deploys themselves)
- Graph storage · Tier 1 (customer S3/R2/MinIO) — presign done inside the customer's CI, not via an OpenCodeHub endpoint
- `codehub provenance record` CLI + `.opencodehub/grounding.json` sidecar
- Sigstore-signed provenance with agent-identity as attestation subject
- Cross-org policy federation (git-based, no central registry)
- `codehub-document --group --auto` on merge-to-main

## What we are NOT doing (consolidated, no exceptions)

- **No hosted / managed / SaaS / OpenCodeHub-operated tier.** Ever.
- **No remote / HTTP MCP server.** Stdio MCP on the laptop only.
- **No agent SDK** (Python, TS, `claude-hooks`, or framework adapters).
- **No `grounding_pack` MCP compositor tool.** Its value was SDK consumption.
- **No OpenCodeHub-branded coding agent.** We don't compete with Devin, Claude-for-GitHub, Copilot, Cursor, Q Developer, Jules.
- **No LLM-based PR review.** CodeRabbit/Greptile/Diamond territory. We compete on deterministic verdict, not LLM verdict.
- **No hosted review UI.** GitHub Checks + PR comments are the review surface.
- **No IDE plugin or LSP.**
- **No model fine-tuning.**

## Three tensions and how they resolved under the new scope

### Tension 1 — Auth and graph-URL plumbing

Before: OIDC → JWT minted once per workflow, consumed by `analyze-action`, `verdict-action`, and an HTTP MCP server via presigned URLs.

Under locked scope: OIDC → JWT is still fine, but its only consumer is the customer's own storage backend (when they pick Tier 1). Default Tier 0 (Actions Cache) doesn't need a JWT at all — `actions/cache@v4` handles credentials natively. The token story collapses to "use OIDC if and only if you run bucket-backed storage."

### Tension 2 — Graph storage scope in v1

Before: argued about whether to ship S3/R2 in v1 vs P1.

Under locked scope: Tier 0 (Actions Cache) is the only default. Tier 1 (customer bucket via presigned URLs minted in the customer's own workflow) is P2. There is no Tier 2 (hosted) — ruled out permanently.

### Tension 3 — Policy rules in v1

Unchanged. Three evaluated rule types in v1 (`blast_radius_max`, `license_allowlist`, `ownership_required`); `arch_invariants` scaffolded, feature-flagged. v1 reserves the schema slot; flag flips in P2.

## Competitive posture (unchanged in substance, sharpened in framing)

From 012 §3, the seams that survive the scope decision:

- **Blast-radius-as-a-Check.** First-party GitHub Check from `verdict-action` with deterministic `graph_hash`-backed verdict. Still wide open.
- **Cross-repo contract gate.** `group_contracts` + `group_query` surface through the CLI and through the `codehub-contract-map` laptop skill. Still uniquely ours.
- **Policy-as-code over a code graph.** `opencodehub.policy.yaml` evaluated by the CLI. Still wide open; we ship without the OPA-style runtime weight.
- **Staleness-aware grounding.** Every CLI response carries the existing `_meta.codehub/staleness` envelope.
- **Deterministic cross-run verdict.** Audit guarantee from `graphHash` invariant. Buyers can prove two runs on identical inputs returned identical verdicts.

Seams we explicitly forfeit (scope decision):

- ~~Agent-scoped grounding server for CI runners~~ — forfeited by dropping HTTP MCP.
- ~~Claude Agent SDK hook pack~~ — forfeited by dropping the SDK.
- ~~Agent-attributable provenance via SDK~~ — the CLI can still record provenance (`codehub provenance record` P2), just without an SDK in front of it.

The forfeits are real. Counter: being first with the HTTP + SDK shape would have meant operating server code for our customers, or shipping SDK versions that break every time Claude Agent SDK moves, or both. The CLI + Actions posture is cheaper to maintain, and the laptop surface still reaches every Claude Code user directly.

## Risks carried forward

From 012 §4, filtered against the new scope:

1. **GitHub ships a first-party "Code Intelligence Check."** Countermove: be license-open (Apache-2.0), self-hostable, cross-SCM, deterministic. Spec 002 is the countermove; ship it in P1.
2. **Sourcegraph doubles down on Cody review agents.** Countermove: one-tenth the weight (DuckDB + CLI, all self-hosted). Stay downstream-compatible with SCIP.
3. **Anthropic ships a first-party repo-understanding tool in Claude Agent SDK.** This risk *increases* under the scope decision (we don't own the SDK surface). Countermove: the Claude Code plugin on laptops + artifact factory reach gives us an engineer-facing foothold that an Anthropic tool would complement, not replace.
4. **Greptile/CodeRabbit reposition as "graph PR review."** Their graph stays closed, SaaS-only. Ours is Apache-2.0 and self-hostable. Compete on auditability and license.

## Timeline

- **Weeks 1–8: Spec 001 ships.** Artifact factory end-to-end on this repo, then released in the plugin. Four skills (doc, pr-description, onboarding, contract-map), six subagents, Phase 0–E, `.docmeta.json`, staleness hook, discoverability.
- **Weeks 9–?: Adoption signal.** At least one external user running the plugin on a group with ≥ 2 repos. No spec 002 work until signal exists.
- **Spec 002: P1.** CI actions + CLI verdict subcommand. Begin only after spec 001 is proven.

## Open questions for you

These are the remaining judgment calls in spec 001 — the places the current spec made a call I want you to sign off on before Act phase:

1. **`codehub-contract-map` output path.** `.codehub/groups/<name>/contracts.md` by default; `--committed` writes to `docs/<group>/contracts.md`. Consistent with the other skills. OK to lock?
2. **Orchestrator model for `codehub-document`.** Sonnet default; Opus only when `--refresh --group` is passed. PRD tension #3 from synthesis v1. OK to lock?
3. **Gitignored vs committed default.** `.codehub/docs/` gitignored by default; `--committed` opts in. ADRs would have been the one exception (ADR must be in git to be an ADR), but `codehub-adr` moved to P1 backlog so this is moot for v1. OK to lock?

## Handoff

Two specs live and consistent with the locked scope:

- `.erpaval/specs/001-claude-code-artifact-surface/spec.md` — **9 P0 items, ready for Act phase.**
- `.erpaval/specs/002-agent-grounding-plane/spec.md` — **rewritten 2026-04-27, deferred to P1, waits on spec 001.**

Roadmap SPA live at `.erpaval/roadmap/index.html` — 31 items across both specs and the Never column, all views (Overview / Timeline / Board / Dependencies / Pillars) reflecting the locked scope.

Project memory updated at `.erpaval/memory/` with the three scope decisions. Future sessions start with these constraints already in context.

Say the word and `/erpaval` Act phase kicks off against spec 001.
