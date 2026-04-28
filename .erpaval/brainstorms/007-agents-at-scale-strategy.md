# 007 — OpenCodeHub at Agent Scale: Strategy Thesis

*CSO pass, 2026-04-27. Audience: Laith (owner). Frame: Rumelt kernel, scoped to the autonomous-coding-agents-at-scale regime. Extends, does not replace, `.erpaval/brainstorms/001-opencodehub-next-strategy.md` and `.erpaval/brainstorms/006-synthesis-whats-next.md`.*

The developer-laptop artifact factory — `/codehub-document`, `/codehub-pr-description`, `/codehub-onboarding`, and the PostToolUse freshness hook locked down in 006 — remains the wedge. This memo opens the second surface: OpenCodeHub as the grounding and guardrail substrate for coding agents that run off-laptop, at volume, on somebody else's infrastructure.

## 1. Diagnosis

The bounding challenge for an org that moves from "Claude Code at the engineer's terminal" to "thousands of agent-authored PRs per week across a repo fleet" is a fused pathology: **agents write uninformed and reviewers cannot catch the consequences deterministically, because grounding and guardrails are not services**. I pick the grounding gap and the review collapse as a single crux. They are not independent problems; they are the two ends of the same broken pipe.

The grounding-gap half. A GitHub Action runner, a Claude-for-GitHub session, a Devin sandbox, an Amazon Q Developer job — each spins up, reads the files the task description pointed at, and writes. None of them consult a cross-repo symbol graph before the first token, because consulting one requires a graph to exist and a service to return it. The existing OpenCodeHub design assumes `.codehub/graph.duckdb` is sitting on the developer's disk from a prior `codehub analyze` run. That assumption dies the moment the writer is ephemeral. *Assumption: the median agent invocation today reads 3–10 open files and inlines their contents as context; a graph slice would replace most of that lookup with a one-shot structured payload, but only if the slice is one RPC away.* The consequence is that agents trip on the exact class of bug the graph would surface: a function signature changed, a consumer in a sibling repo broken, an invariant declared in an ADR violated, a license transitively pulled in.

The review-collapse half. At 1000s of agent-authored PRs per week per org, humans cannot gate each merge with the attention budget they spent on the 10–50 human PRs per week they used to see. "LGTM" becomes a reflex; the signal-to-noise of CI checks drops because the checks in place (unit tests, typecheck, lint) do not catch cross-repo semantic regressions. OpenCodeHub has `verdict`, `impact`, blast-radius, owners, and license scanners (see `packages/analysis/src/verdict.ts`, `impact.ts`, `risk.ts`, `risk-snapshot.ts`), but they are invoked manually from `/verdict` on a laptop, not wired into a merge gate anyone's CI system enforces. The graph can answer "is this PR safe to auto-approve?" deterministically — nobody is asking it that question in the merge path.

The review-collapse half feeds the grounding-gap half. If agents had been grounded pre-write, fewer of the 1000 PRs would carry latent cross-repo regressions, and the gate would have less to catch. Conversely, if the gate were deterministic and graph-backed, agents would learn (via fast red builds and structured findings) what grounding they should have pulled. Fixing either alone is half the win. Fixing both is OpenCodeHub's unique position — we already own the graph and the verdict primitives; we do not own the pre-write and pre-merge surfaces through which agents meet them.

Secondary framings (provenance vacuum, fleet incoherence, policy enforcement gap) are real but downstream. Provenance without grounding is theater. Fleet coherence without a graph is impossible. Policy-as-code without a graph to evaluate against is a linter. The graph is the primitive; the missing layer is the service shape around it.

## 2. Guiding policy

**OpenCodeHub ships as the grounding plane for coding agents: a stateless/stateful service that every agent platform — Claude, Cursor, Copilot, Devin, Amazon Q, Cody, Greptile, CodeRabbit, Diamond — calls to get pre-write context, mid-write invariants, and pre-merge deterministic gates. We do not build an agent. We ground everyone else's.**

The policy follows from the diagnosis. If the pathology is uninformed writes plus non-deterministic reviews, the intervention is a graph-backed service that sits on both sides of the write. Pre-write: a grounding pack delivered as MCP-over-HTTP to whichever agent runtime made the call. Pre-merge: a GitHub Action (and GitLab CI template) that runs `codehub analyze` on the PR head, consults the policy file, emits a Checks verdict with auto-approve/block/route signals. Post-merge: a provenance manifest every agent PR carries, so an audit trail exists.

Three things this policy rules out, each a real option I am rejecting:

- **We do not build our own coding agent.** No OpenCodeHub-branded autonomous PR author. Every cycle we spend competing with Devin or Claude-for-GitHub is a cycle we do not spend being the grounding surface they all depend on. Composability wins against consolidation when the primitive is hard and the runtime is easy.
- **We do not build a hosted review UI.** GitHub PR comments and Checks are the review UI. Building a dashboard competes with the customer's existing tool and loses on integration cost.
- **We do not fine-tune models or ship our own LLMs.** The value is the graph and the policy shape. Routing model choice back to the agent platform preserves our neutrality — we can be the grounding layer for a Claude agent and an Amazon Q agent in the same org without picking a side.

The developer-laptop artifact factory from 001/006 stays in the product. It is the wedge that makes OpenCodeHub visible to engineers; the agent-scale grounding plane is the surface that makes OpenCodeHub structural to their org. Two surfaces, one graph.

## 3. Coherent actions

Ten moves. P0 = ship this quarter alongside the 006 artifact surface. P1 = next quarter. P2 = followup.

**A. [P0] MCP-over-HTTP server at `packages/mcp-http/`.** The existing stdio server at `packages/mcp/src/server.ts` is laptop-only. Fork a `packages/mcp-http/` flavor that speaks Streamable HTTP per the MCP spec, authenticates via short-lived OAuth tokens (GitHub App installation tokens are the natural issuer), and exposes a narrower tool set: `grounding_pack`, `query`, `context`, `impact`, `detect_changes`, `verdict`, `group_contracts`, `group_query`, `list_findings_delta`. Destructive tools (`rename`, raw `sql`) stay local-only; remote callers get read-only graph surface plus pre-computed gates. *Assumption: short-lived GitHub-App-minted tokens scoped to repo + group are sufficient auth for v1; SSO/OIDC lands in P1.* Allocation: one engineer, full quarter.

**B. [P0] `opencodehub/analyze-action@v1` and `opencodehub/verdict-action@v1` — GitHub Action pair.** Home them under `packages/actions/analyze/` and `packages/actions/verdict/` with a thin Node action shell that shells out to the CLI already in `packages/cli/src/commands/`. `analyze-action` runs `codehub analyze` on checkout, uploads the resulting `.codehub/graph.duckdb` + sidecars to S3/R2/GitHub Actions Cache keyed by `graph_hash`. `verdict-action` pulls the graph by hash, runs `codehub verdict` + policy evaluation, posts a GitHub Checks run with structured annotations. Companion GitLab template at `packages/cli/src/ci-templates/` (directory already scaffolded). Allocation: one engineer, six weeks.

**C. [P0] `grounding_pack` MCP tool — `packages/mcp/src/tools/grounding-pack.ts` + `packages/mcp-http/` surface.** Signature: `grounding_pack({repo, task_description, target_files?, group?}) → { symbol_slice, blast_radius_hint, owners, recent_findings_on_touched_files, group_contracts_if_crosses_boundary, invariants }`. Implementation composes existing primitives (`query`, `context`, `impact`, `owners`, `list_findings`, `group_contracts`) into one JSON payload an agent prepends to its system prompt. This is the single most important tool in this memo — it is the pre-write intervention made concrete. Allocation: one engineer, four weeks.

**D. [P0] `@opencodehub/agent-sdk` — thin Node/Python client at `packages/agent-sdk-node/` and `packages/agent-sdk-python/`.** Drop-in for Claude Agent SDK, Vercel AI SDK, LangGraph, Strands, and a generic OpenAI tool-use loop. Wraps the MCP-over-HTTP endpoint, handles token refresh, and exposes `groundingPack()` plus a `withGrounding(agent)` decorator that auto-injects on every turn. Ships with example integrations in `examples/`. *Assumption: MCP-over-HTTP adoption by agent frameworks is uneven; an SDK wrapper is the cheap accelerant.* Allocation: one engineer, six weeks.

**E. [P0] `opencodehub.policy.yaml` + evaluator — `packages/analysis/src/policy/`.** Declarative rules at the repo or group root: blast-radius tiers that auto-approve or block, license allowlists, required owners, architectural invariants as graph queries (e.g., `no_import_from: [packages/storage/**] unless target_path: [packages/storage/**, packages/service-*/**]`). The evaluator consumes `verdict`, `impact`, and `sql` output; emits a structured result with `decision: approve|block|route`, `reasons[]`, `policy_version`. Wired into `verdict-action` from B. Allocation: one engineer, full quarter.

**F. [P1] Grounding provenance manifest — `.opencodehub/grounding.json` in every agent PR.** Schema: `graph_hash`, `tools_called[]` with digests, `findings_received[]`, `policy_evaluation`, `agent_identity`, `signed_by`. Written by the `agent-sdk` on each turn, committed as a PR artifact, verified by `verdict-action`. Two deterministic gate signals drop out of this: (1) "did the agent call grounding before writing?" (presence check), (2) "did the grounding content match post-merge reality?" (audit replay). Allocation: one engineer, four weeks, P1 only because the SDK (D) must land first.

**G. [P0] Graph-as-service storage — `packages/graph-store/` with S3/R2 and GitHub Actions Cache backends.** Ephemeral CI jobs must not re-index a 2M-LOC monorepo on every PR. Per-commit graph uploaded by `analyze-action` keyed by `graph_hash = sha256(commit_hash + analyzer_version + config_hash)`; group-scoped manifests keyed by `group_hash`. Content-addressed so cache collisions are impossible and coherence is trivial. *Assumption: GitHub Actions Cache 10 GB per-repo quota is enough for the median customer; S3/R2 is the overflow path and the path for self-hosted runners.* Allocation: one engineer, six weeks.

**H. [P1] Fleet-coherence primitive — `detect_changes` and `impact` gain `session_id` + `open_branches[]` params.** Question answered: "what changes would this PR conflict with if it merges while sibling PRs X, Y, Z are still open?" Requires a cross-branch graph merge over the graph-store in G. This is the uniquely-hard move and the one nobody else has. Ships behind a feature flag in v1 because the merge semantics need field data. Allocation: two engineers, full quarter — the hardest work in the plan.

**I. [P1] GitHub App webhook subscriber — `packages/github-app/`.** Listens for PR events, invokes `analyze-action` + `verdict-action` logic in-process, posts Checks and structured comments. Unlocks zero-config usage for customers who don't want to edit `.github/workflows/`. Kept P1 to avoid forcing a hosted-service commitment in the v1 quarter; customers can still self-host the App. Allocation: one engineer, six weeks.

**J. [P0] Auto-approval policy primitives — `codehub policy evaluate --pr <url>` and `opencodehub/auto-merge-action@v1`.** Rule classes shipped out of the box: `label:agent-authored + verdict.tier<=2 + all-policies-pass + required-owners-approved auto-merges after N hours`. The action writes a review and either approves or requests changes; merge itself stays with the customer's branch-protection rules. Allocation: one engineer, four weeks.

**Critical path.** A → C → D is the pre-write spine. B → E → J is the pre-merge spine. G unblocks both. H is the differentiator once both spines exist. F is provenance once D exists. I is distribution once everything else works.

## 4. What we are NOT doing

- **No OpenCodeHub-branded coding agent.** We do not compete with Devin, Claude-for-GitHub, Amazon Q Developer, or Cursor agents.
- **No hosted review UI.** GitHub PR comments, GitHub Checks, and GitLab MR widgets are the review surface. We post into them; we do not replace them.
- **No head-on competition with CodeRabbit / Greptile / Diamond.** Those tools are agents. We ground them — they become customers of `grounding_pack`.
- **No model fine-tuning.** Model choice stays with the agent platform.
- **No LSP or IDE plugin.** Claude Code plugin, MCP-over-HTTP, and GitHub Action are the three surfaces; an LSP is a fourth we do not need.
- **No head-on competition with Sourcegraph's enterprise-code-search SKU.** We are narrower and more opinionated: graph-grounding for agents, not general code search.
- **No hosted cloud service in v1.** Everything is self-hostable — the Action runs in the customer's CI, the graph store is their S3/R2, the policy file is in their repo. Hosted-OpenCodeHub is a P2 SaaS play contingent on v1 pull.
- **No new retrieval MCP tools beyond `grounding_pack`.** The 28-tool surface is frozen per 001; `grounding_pack` is a compositor, not a new primitive.

## 5. Moat analysis

The underlying graph tools (tree-sitter, SCIP, tsserver, pyright) are commodities. Moats are shape moats, not capability moats.

- **Group-level (multi-repo) graph joins.** The `group_*` surface — `group_contracts`, `group_query`, `group_status`, `group_sync` — is the delta over every single-repo code-intel tool (Sourcegraph Cody is closest; their group shape is weaker). Cross-repo blast radius and cross-repo invariants are table-stakes at agent scale, and single-repo tools structurally cannot answer them. Action H extends this into cross-branch, which is another order of hard.
- **Policy + provenance shape.** `opencodehub.policy.yaml` plus `.opencodehub/grounding.json` is a product-design problem dressed as an engineering one. The schema choices — what counts as an auto-approve signal, what provenance the gate requires, what reviewers see — compound over deployments. Customers who adopt the schema are expensive to migrate off.
- **Offline-safe and air-gap-friendly.** SPECS.md already commits to offline guarantees on the core graph path. In regulated orgs (finance, defense, health) the ability to run the grounding plane fully inside a VPC with no outbound calls is a deal qualifier, not a feature. Devin and Claude-for-GitHub cannot offer this today; neither can Sourcegraph's hosted tier.
- **Composability with every agent platform.** Because we ship no agent, every agent vendor is a potential distribution partner rather than a competitor. The positioning is symmetric to the way Vercel's AI SDK became the substrate for model-agnostic agents — be the neutral layer, get integrated by everyone.
- **Open-source and self-hostable.** The GitLab trajectory versus Sourcegraph's closed model. Enterprise procurement prefers self-hostable OSS substrate with an optional hosted SKU. Action G makes self-hosting operationally cheap.

The moats compound. Group graph joins are hard to replicate technically; policy-and-provenance shape is hard to replicate productively; offline guarantees are hard to replicate organizationally; composability is hard to replicate strategically once you have built a rival agent. The intersection is the defensible position.

## 6. Updated one-sentence strategy thesis

**OpenCodeHub is a two-surface product — the Claude Code artifact factory that produces group-level documentation on the developer's laptop, and the MCP-over-HTTP grounding plane plus CI merge gate that every coding agent platform calls to write and merge safely at org scale — unified by a single offline-safe cross-repo graph that nobody else ships.**
