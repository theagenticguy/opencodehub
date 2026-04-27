# OpenCodeHub as Agent Grounding Plane — Lifecycle PRD

**Owner:** Laith Al-Saadoon (AGS Tech AI Engineering NAMER)
**Status:** Draft v1 — 2026-04-27
**Scope:** OpenCodeHub repositioned as a grounding + guardrail plane for autonomous coding agents running off-laptop at PR-scale. This PRD supersedes the single-repo artifact framing of `002-opencodehub-artifact-skills-prd.md` at the *lifecycle* level; the artifact-skill work remains in-scope and becomes one of the tools the plane exposes.

---

## Problem

Three concrete failure modes orgs hit today once agent-authored PRs cross ~100/week per repo fleet.

- **Agent writes blind.** The agent's prompt never sees the call graph. It refactors `normalizeInvoiceId` in `billing-core`, unaware that four sibling repos import it. CI 10 minutes later screams across three pipelines, humans context-switch to triage, and the agent has already moved to the next task. The graph existed; it just wasn't in the prompt.
- **Review collapse.** A mid-size platform org fields 600 agent-authored PRs per week. Human reviewers rubber-stamp the ones that "look fine," the occasional subtle bug ships, and blast radius goes unchecked because no reviewer traces five hops of downstream impact by hand. The review budget is a fixed human-hour line; agent output is elastic.
- **No provenance.** Post-incident, the security lead asks: which agent made this commit, what did it read first, was its graph view stale, did the policy gate actually run? Today that question is unanswerable — git blame points at `agent-bot@example.com`, CI logs rolled off, and no signed manifest exists.

The gap: OpenCodeHub has the graph and the tools — `verdict`, `impact`, `detect_changes`, `list_findings_delta`, `group_contracts`, `license_audit`, `owners`, plus 20+ more — but the surface is stdio-MCP + laptop CLI only. No HTTP endpoint, no CI action, no policy-as-code, no provenance manifest, no graph-storage service. The assets exist; the *plane* doesn't. Off-laptop agents cannot reach us, cannot gate on us, and cannot be audited through us.

---

## Agent lifecycle — 5 stages

Every agent interaction with code flows through these stages. For each we name the status quo and what OpenCodeHub should offer.

### 1. Task intake

The agent is handed "fix bug in billing" or "add endpoint X" via a GitHub issue, a Slack message, or a PR-bot webhook. **Today:** agents route tasks on natural-language matching; no repo-aware triage. **OpenCodeHub offers:** `list_repos` + `project_profile` + `owners` resolve the task to a target repo and a responsible owner set before the agent claims the task. A `task_route({description})` helper wraps the triage call.

### 2. Pre-write grounding

Before editing, the agent should pull a graph slice: relevant symbols, blast radius for the likely target, owners, prior findings, group-level contracts it must respect, arch invariants. **Today:** rarely happens; agents rely on in-prompt file reads and training-data recall. **OpenCodeHub offers:** a new `grounding_pack({repo, task_description, target_files?})` MCP tool that returns one bundle — top-ranked symbols (via existing `query`), first- and second-order `impact`, `owners` table, recent `list_findings` for the area, relevant `group_contracts`, the policy file digest, and a `graph_hash` for the manifest.

### 3. Write

Agent edits files. Can consult MCP tools mid-write for spot-check questions (`context(symbol)`, `impact(target)`). **Today:** some agents wire a handful of tools; many don't. **OpenCodeHub offers:** the existing 28 tools, unchanged, now reachable over HTTP. The Agent SDK exposes them as a typed client so framework authors don't hand-roll JSON-RPC.

### 4. Pre-PR gate

Before opening the PR, the agent should run policy evaluation locally: blast-radius budget, license allowlist, arch invariants, required-owner coverage, findings-delta severity. **Today:** policy runs post-open, in CI, wasting a round trip. **OpenCodeHub offers:** `policy_evaluate({repo, pr_ref, policy_path?})` as an MCP tool the agent calls before `gh pr create`. Same evaluator runs identically in CI (stage 5). Deterministic: same inputs, same verdict.

### 5. PR review + merge gate

The PR is open. CI must produce a deterministic verdict driven by graph policy, not LLM vibes. **Today:** `verdict`, `impact`, `detect_changes`, `list_findings_delta` exist as separate tools with no integrated gate. **OpenCodeHub offers:** `opencodehub/verdict-action@v1` posts a GitHub Check with per-rule pass/fail, auto-applies an `opencodehub:auto-approve` label when all rules pass, and uploads the signed provenance manifest. Humans review only the PRs the policy flagged.

### 6. Post-merge

The graph must re-index; downstream agents must pick up the new state before their next grounding call. **Today:** `codehub analyze` runs per-laptop on PostToolUse. **OpenCodeHub offers:** `opencodehub/analyze-action@v1` runs on `push` to main, writes the graph to the configured object store keyed by `(repo, commit_sha)`, and emits a webhook that group-member repos can subscribe to for cross-repo freshness.

---

## Users — 4 archetypes

### Agent framework author

*Builds an autonomous coding agent on Claude Agent SDK, LangGraph, or Strands.*

- **When I** build an autonomous coding agent that edits code in repos I don't own,
- **I want** a grounding SDK that injects graph context, blast radius, and owners into every prompt via one call,
- **so that** my agent writes code aware of cross-repo effects without me re-implementing code-graph retrieval.
- **Bad outcome to avoid:** shipping an agent that ignores blast radius, then getting banned from an org's merge automation after one bad refactor cascade.

### Platform engineer / DevEx lead

*Owns CI and merge automation for an org with 500 repos and a growing fleet of agent-authored PRs.*

- **When I** turn on agent-authored PRs across my repo fleet,
- **I want** deterministic merge gates driven by graph policy, not LLM review,
- **so that** safe PRs auto-approve and human reviewers focus on the ~15% the policy flags.
- **Bad outcome to avoid:** human reviewers rubber-stamping 600 PRs/week, a real blast-radius-5 refactor ships, and I'm the one rolling it back Sunday night.

### Security / governance lead

*Accountable for SBOM, license compliance, arch invariants, and post-incident audit.*

- **When I** let agents ship PRs across production repos,
- **I want** a signed grounding manifest attached to every agent PR,
- **so that** I can audit what the agent knew, prove the policy ran, and enforce invariants at merge time.
- **Bad outcome to avoid:** an incident where I cannot reconstruct which agent changed what, what it read first, or whether our arch invariants were checked.

### Individual repo owner

*Library maintainer on the receiving end of cross-repo agent PRs.*

- **When I** get an agent PR that touches my library,
- **I want** the agent to have already consumed my `group_contracts`, owners file, and invariants,
- **so that** I'm not spending review cycles re-teaching the agent context it could have fetched.
- **Bad outcome to avoid:** approving a PR that breaks three downstream consumers because the agent never saw my contract surface.

---

## Solution surface — the grounding plane

| Surface | What it does |
|---|---|
| `packages/mcp-http/` | MCP-over-HTTP server using the Model Context Protocol streamable-HTTP transport on `/mcp`. Exposes all 28 existing tools plus three new ones below. Single endpoint, `Mcp-Session-Id` header for stateful sessions, `Origin` validation for DNS-rebinding safety. *Assumption: streamable-HTTP remains the current MCP transport per the March 2025 spec revision; SSE is the deprecated fallback we do not ship.* |
| `grounding_pack(tool)` | New MCP tool. Input: `{repo, task_description, target_files?}`. Output: bundle of ranked symbols, first- and second-order impact, owners, recent findings, relevant group contracts, policy digest, `graph_hash`. This is the single call a pre-write agent makes. |
| `policy_evaluate(tool)` | New MCP tool. Input: `{repo, pr_ref, policy_path?}`. Output: structured verdict per rule (pass/fail/skip) with citations back into the graph. Deterministic — same inputs, same verdict. Runs identically locally (agent pre-PR) and in CI (merge gate). |
| `provenance_record(tool)` | New MCP tool. Input: `{repo, pr_ref, tools_called, graph_hash}`. Writes `.opencodehub/grounding.json` to the PR branch. |
| `opencodehub/analyze-action@v1` | GitHub Action. Runs `codehub analyze`, uploads the graph DB to the configured backend (S3, R2, GitHub Artifact), keyed by `(repo, commit_sha)`. |
| `opencodehub/verdict-action@v1` | GitHub Action. Fetches the cached graph, runs `policy_evaluate`, posts a GitHub Check, applies auto-approve label on full pass. |
| `opencodehub/ground-action@v1` (P1) | GitHub Action. Runs `grounding_pack` on an open PR, posts a human-readable summary as a PR comment so reviewers see what the agent saw. |
| GitLab CI templates (P1) | `.opencodehub/gitlab/analyze.yml`, `verdict.yml`, `ground.yml`. Same semantics, mirror of the GH actions. |
| `opencodehub.policy.yaml` | Policy-as-code schema at repo or group root. v1 rule types: `blast_radius_max`, `license_allowlist`, `ownership_required`, `arch_invariants` (constrained YAML that compiles to cypher against the graph), `finding_severity_blocking`. JSON-Schema validated; invalid policies fail fast. |
| `@opencodehub/agent-sdk` | Thin typed wrapper over MCP-over-HTTP. Python (`opencodehub_agent_sdk`) and TypeScript. Three primary calls: `ground(task)`, `verdict(pr)`, `provenance(pr, grounding_result)`. Plus framework adapters for Claude Agent SDK (Python), Vercel AI SDK (TS), LangGraph, Strands, and a generic OpenAI/Anthropic tool-use loop. |
| `.opencodehub/grounding.json` | Provenance manifest the agent commits to the PR branch. Schema: `graph_hash`, `tools_called[]` each with `{tool, args_hash, response_hash, ts}`, `policy_evaluated`, `findings_received`, `agent_identity`. Rendered as a human-readable summary by `ground-action`. |
| Graph storage service | Object-store-backed (S3 / R2 / GitHub Artifact adapter). Keyed by `(repo, commit_sha)`. TTL-ed. Local file (`.codehub/graph.duckdb`) remains the laptop fallback. Paired with a short-lived signed-URL fetch so actions never see bucket creds directly. |
| `conflict_forecast(tool)` (P2) | Fleet-coherence primitive. Input: `{pr_ref, open_sibling_prs[]}`. Projects merge conflicts across multiple open agent PRs on the same graph. |

---

## Job stories in detail

### JS-1 Agent framework author wires grounding into a Claude Agent SDK loop

**Trigger:** framework author is building `billing-refactor-agent`, a Claude Agent SDK agent that takes a Jira ticket and opens a PR.

**Steps:** (1) install `@opencodehub/agent-sdk` in the agent project; (2) set `OPENCODEHUB_URL` and a short-lived token scoped to a GitHub App install; (3) on every task, call `sdk.ground(task)` before the first model turn and feed the returned bundle into the system prompt as the "codebase context" section; (4) expose the full MCP tool set to the model via the SDK's tool adapter so the agent can mid-write call `context(symbol)` or `impact(target)`; (5) before the agent opens the PR, call `sdk.verdict(pr_ref)` and abort if verdict is `blocked`; (6) on successful open, call `sdk.provenance(pr_ref, grounding_result)`.

**Surfaces touched:** `packages/mcp-http/`, `grounding_pack`, `policy_evaluate`, `provenance_record`, `@opencodehub/agent-sdk`, `.opencodehub/grounding.json`.

**Outcome:** agent prompts are reproducibly grounded, PRs arrive with a signed manifest, and the framework author did not hand-roll retrieval.

**Failure modes and detection:** (a) grounding_pack timeout on a fresh repo — SDK logs `grounding_stale=true`, agent falls back to empty context and the manifest records the failure. (b) policy_evaluate diverges between local and CI — both runs record `policy_hash`; a mismatch is a P0 bug. (c) expired token — 401 at SDK boundary; the SDK's retry wrapper refreshes from the configured OIDC source.

### JS-2 Platform engineer turns on deterministic merge gates for a 500-repo fleet

**Trigger:** platform lead rolls out agent-authored PRs to a second tier of repos and needs the human-review line to hold.

**Steps:** (1) drop `.github/workflows/opencodehub.yml` referencing `analyze-action@v1` on push-to-main and `verdict-action@v1` on pull_request; (2) author `opencodehub.policy.yaml` at the org's shared-config repo and reference it from member repos; (3) configure auto-approve rule: `verdict == pass && label == opencodehub:auto-approve` merges via the existing branch-protection bot; (4) wire the Checks API output to a Slack digest.

**Surfaces touched:** `analyze-action`, `verdict-action`, `opencodehub.policy.yaml`, graph storage service.

**Outcome:** the review queue drops from 600/week to roughly the ~15% of PRs the policy flags. Mean-time-to-merge for safe PRs falls to minutes; human attention concentrates on real blast radius.

**Failure modes and detection:** (a) graph cache miss in CI — `analyze-action` re-runs analysis on the fly with a visible latency hit; alert fires after 3 consecutive misses. (b) a policy rule has a false-positive pattern — per-rule pass/fail is itemized, so the platform lead can silence one rule without disabling the gate. (c) agent bypasses the label — branch protection requires the Check, not the label; bypass requires explicit human override logged in audit.

### JS-3 Security lead audits an incident traced to an agent PR

**Trigger:** Sev-2 incident, rollback points to commit `abc123` authored by an agent.

**Steps:** (1) fetch `.opencodehub/grounding.json` from the PR branch (or its archived copy in the audit bucket); (2) verify the manifest signature against the agent-identity key; (3) read `tools_called[]` to reconstruct the agent's view; (4) compare `graph_hash` to the graph at commit time — was the grounding fresh? (5) replay `policy_evaluate` with the captured inputs to confirm the gate ran as advertised.

**Surfaces touched:** provenance manifest, graph storage (historical `(repo, commit_sha)` entries), `policy_evaluate`, signed-URL fetch.

**Outcome:** incident post-mortem names a specific grounding gap or policy gap, not "the agent." Remediation is a new rule or a richer grounding bundle, not a blanket rollback of agent-authored PRs.

**Failure modes and detection:** (a) graph for the incident commit aged out of the cache — TTL policy tunable per repo criticality; audit-tier repos pin forever. (b) missing manifest — CI fails closed if `provenance_record` did not run, so missing manifests are a pre-merge signal, not a post-incident surprise.

### JS-4 Repo owner receives an agent PR on a shared library

**Trigger:** `platform-sdk` maintainer sees an agent PR on their library from a downstream product repo.

**Steps:** (1) the PR comment from `ground-action` already summarizes which contracts the agent consumed and which owners were notified; (2) maintainer scans the blast-radius section (two downstream repos); (3) reviews the one file the agent touched against the contract the agent cited; (4) merges or requests changes; no context re-teaching.

**Surfaces touched:** `ground-action`, `grounding_pack`, `group_contracts`, PR comment renderer.

**Outcome:** review time per agent PR drops to minutes because the agent's context is visible in-thread.

**Failure modes and detection:** (a) agent cited an outdated contract — `group_contracts` staleness flag is rendered in the comment; maintainer sees it immediately and requests a re-ground. (b) agent touched a file with no contract — the comment flags `ungoverned_surface=true` and routes the PR to the `arch` team.

---

## Acceptance criteria (EARS)

1. When an agent sends a request to `POST /mcp` with a valid session header, the HTTP server **shall** respond using the Model Context Protocol streamable-HTTP transport and **shall** reject requests with an invalid `Origin` header.
2. When `grounding_pack` is called with `{repo, task_description}`, the system **shall** return JSON conforming to the `grounding_pack.schema.json` and **shall** include a non-empty `graph_hash`.
3. When `policy_evaluate` is called against a `pr_ref` with an `opencodehub.policy.yaml` present, the system **shall** return a structured verdict with a per-rule pass/fail/skip entry for every rule declared in the policy.
4. When `policy_evaluate` runs twice on unchanged inputs (same `graph_hash`, same `pr_ref`, same policy file), the two verdicts **shall** be byte-identical.
5. When `analyze-action@v1` runs on push-to-main for a repo up to 500k LOC, it **shall** upload the graph to the configured backend within 10 minutes and **shall** emit the `(repo, commit_sha)` cache key in the action output.
6. When `verdict-action@v1` runs on a PR and all policy rules pass, it **shall** post a GitHub Check named `OpenCodeHub / verdict` with conclusion `success` and **shall** apply the `opencodehub:auto-approve` label.
7. When an agent commits via the SDK, the PR branch **shall** contain `.opencodehub/grounding.json` validating against the provenance schema before the PR is marked ready-for-review.
8. When `sdk.ground(task)` is invoked against a repo up to 100k LOC with a warm graph cache, it **shall** return within 5 seconds at p50 and 15 seconds at p95.
9. When `opencodehub.policy.yaml` fails JSON-Schema validation, `policy_evaluate` **shall** exit with a non-zero code and **shall not** return a pass verdict.
10. When `provenance_record` completes, the written manifest **shall** be signed with the agent-identity key (P1 requirement; v1 accepts unsigned with a `signed=false` flag).
11. When the graph storage service receives a request for a `(repo, commit_sha)` already in cache, it **shall** serve the cached artifact without re-running analysis and **shall** emit a `cache_hit=true` metric.
12. When two or more open PRs against the same repo are passed to `conflict_forecast`, the system **shall** return a list of files predicted to conflict with at least the precision of a three-way `git merge --no-commit` dry-run (P2).
13. When the agent calls any tool over MCP-HTTP without a valid short-lived token, the server **shall** return 401 and **shall** log the attempt to the audit sink.
14. When the policy file at the group root and the repo root both exist, the repo root **shall** take precedence and the merged effective policy **shall** be recorded in the manifest.
15. When `ground-action@v1` posts a PR comment, the rendered comment **shall** include the `graph_hash`, the list of tools called, the blast-radius tier, and the owner set — in ≤150 lines.

---

## Scope — v1 / P1 / P2

### v1 (this quarter)

- `packages/mcp-http/` with streamable-HTTP `/mcp` endpoint and all 28 existing tools.
- `grounding_pack` MCP tool (new) with JSON-Schema output contract.
- `analyze-action@v1` and `verdict-action@v1` GitHub Actions, published to the GitHub Marketplace under `opencodehub/`.
- `@opencodehub/agent-sdk` Python client first; TS client P1.
- `opencodehub.policy.yaml` skeleton with three v1 rule types: `blast_radius_max`, `license_allowlist`, `ownership_required`.
- Graph storage service — S3/R2 adapter, `(repo, commit_sha)` keying, 30-day TTL default.
- Short-lived-token auth keyed to a GitHub App install.

### P1 (next quarter)

- `provenance_record` + `.opencodehub/grounding.json` schema + signing.
- `ground-action@v1` PR-comment renderer.
- GitLab CI templates mirroring the three actions.
- TypeScript SDK (`@opencodehub/agent-sdk` npm package).
- Two additional policy rule types: `arch_invariants` (constrained YAML → cypher) and `finding_severity_blocking`.
- Framework adapters: Claude Agent SDK, Vercel AI SDK, LangGraph, Strands, generic OpenAI tool-use.

### P2

- `conflict_forecast` fleet-coherence primitive.
- GitHub App (not just Action) with native Checks + auto-merge surface.
- Hosted graph storage (OpenCodeHub-operated tier for teams that don't want to run S3 themselves).
- Signed/tamper-evident provenance with Sigstore-compatible cosign signatures.
- Cross-org policy federation.

---

## Risks and open questions

- **Transport choice.** MCP streamable-HTTP on `/mcp` is the current spec default (March 2025 revision, superseding SSE). v1 ships streamable-HTTP only. Websockets ruled out — not in the spec. *Assumption: the Anthropic streamable-HTTP spec holds through the next 12 months; re-check before GA.*
- **Graph privacy.** We never upload source. We do upload the graph DB — nodes, relations, symbol names, file paths, LOC ranges. For some orgs the graph itself is sensitive (internal service topology). v1: BYO bucket with CMK support. P1: per-repo encryption-key binding so the plane never sees plaintext.
- **Policy-DSL vs raw cypher.** Raw cypher is maximally expressive and maximally dangerous — a bad query on a large graph burns minutes. v1 ships a constrained YAML schema that compiles to a curated cypher subset. Raw cypher is explicitly out of scope for v1; platform teams who need it can run `sql` tool directly.
- **Agent authentication.** Short-lived OIDC tokens keyed to a GitHub App install. TTL 15 minutes. *Assumption: the consuming orgs already run GitHub App auth for their agents; the Cursor / Devin / Jules vendors each have their own identity model and we expose the GitHub App path first.*
- **Cost scaling for graph storage on monorepos.** A 5M-LOC monorepo graph is ~1-3 GB. At 30-day TTL and commit-level keying, retained footprint is ~(commits/day × 30 × GB). Mitigation: commit-sha dedup on unchanged subgraphs (content-addressed graph blocks) lands in P1; v1 accepts the naive footprint and surfaces a `graph_bytes` metric so platform leads can set per-repo TTL.
- **Framework breadth vs depth.** Claude Agent SDK is the first-class client. Being framework-agnostic at the wire protocol (MCP-over-HTTP) keeps every other agent framework unblocked at the cost of shipping N framework adapters in P1. My call: ship Claude first; let community PRs fill the rest.
- **Fleet coherence's real cost.** `conflict_forecast` on N open PRs is O(N²) in the naive implementation. P2 is the right timing to research an incremental projection model rather than ship the quadratic version.

