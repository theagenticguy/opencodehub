# 012 — Competitive Landscape: Agent + Grounding + Guardrail Ecosystem

*Draft: 2026-04-27. Scope: autonomous coding agents, PR review tooling, code-graph grounding, MCP ecosystem, policy-as-code, agent provenance. Sources cited inline; products move fast so everything below is dated to April 2026.*

## 1. The Map

| Player | Category | What they do | Surface (LSP/IDE/CI/SDK/MCP) | Who runs it | Differentiator | Gap we can exploit |
|---|---|---|---|---|---|---|
| Claude Code (Anthropic) | Autonomous agent | Agent loop over local repo; `/loop` scheduler, Auto Mode, Linear-triggered background agents [1][2] | CLI + GitHub Action + IDE ext + MCP client | Laptop, cloud VM, CI runner | Best-in-class agent loop; native MCP consumer | Deep graph grounding — reads files, doesn't precompute blast radius |
| Claude Agent SDK (Anthropic) | Agent framework | Programmatic agent loop w/ hooks (PreToolUse/PostToolUse), subagents, MCP servers, permissions [3] | Python + TS SDK | CI / server-side | `PreToolUse` hook is a perfect seam for deterministic gates | No built-in code-graph; hooks are empty unless someone ships policy packs |
| GitHub Copilot coding agent | Autonomous agent | Issue → PR w/ Actions runner; `@copilot` PR edits; Autopilot CLI w/ `--max-autopilot-continues` [4][5] | GitHub-native + CLI | Cloud (GitHub Actions) | Incumbent distribution; owns the merge button | Grounding is "read files in the runner"; no graph, no cross-repo |
| Cursor background agents | Autonomous agent | Automations + Cloud Agents via Graphite; sandboxed PR authoring; open-sourced security agents [6][7] | IDE + web + GH integration | Cursor Cloud sandbox | $2B ARR, Composer 2.5 model, deep IDE loop | CI surface is thin; not the canonical choice where PRs are gated by compliance |
| Devin (Cognition) | Autonomous agent | ACU-billed autonomous SWE; Windsurf IDE, Devin Wiki, Devin Search [8][9] | Web + Slack + GitHub + VPC | Cognition cloud / VPC | Enterprise VPC; multi-product (Wiki = graph-adjacent) | Wiki is single-repo; no graph primitives exposed as tools to other agents |
| Jules (Google) | Autonomous agent | Async agent; Gemini 3.1 Pro; Jitro KPI-driven variant coming [10] | Web + GitHub + CLI (`jules`) | Google Cloud VM | Full-filesystem sandbox; async discipline | No graph context; explicitly struggles on large files/edge cases |
| Amazon Q Developer `/dev` | Autonomous agent | Multi-file feature agent; CLI auto-runs validation [11] | IDE + CLI + AWS Console | AWS | IP indemnity; AWS ecosystem hooks | Single-repo context; no blast radius; no cross-service graph |
| Replit Agent 4 | Autonomous agent | Parallel frontend/backend/DB agents; browser-based [12] | Web-only | Replit Cloud | Zero-setup full-stack | Not oriented toward CI/merge gates on external repos |
| v0 (Vercel) | Autonomous agent | React/Next.js UI generator; Figma + Shadcn [12] | Web + Vercel | Vercel Cloud | UI-first, not general SWE | Out of our lane — UI generation, not grounding |
| Bolt / StackBlitz | Autonomous agent | Prompt-to-preview browser dev | Web | StackBlitz WebContainers | Instant dev loop | Out of lane — prototyping, not merge gating |
| CodeRabbit | PR review | Inline PR review + pre-merge checks; YAML policies; 40+ linters [13][14] | GitHub App + CLI + IDE | SaaS | Largest install base; policy framework in YAML | LLM-grounded review; no precomputed graph; no blast radius tier |
| Greptile v4 | PR review | Codebase-graph-based review; multi-repo context; severity badges [15][16] | GitHub App | SaaS | Claims graph; 66.2% precision benchmark | Graph is proprietary + closed; no open export; no determinism guarantee |
| Graphite Diamond / Agent | PR review | Real-time PR review + stacked PRs + merge queue [17] | GitHub App + VS Code | SaaS | Stacked-PR UX + merge queue + review | Diamond deprecated into Graphite Agent; LLM review, not policy-graph |
| Ellipsis | PR review | Async PR review + bug fixes via `@ellipsis-dev` [18] | GitHub App | SaaS | Low-friction; async fix bot | Smaller; no graph story; style-focused |
| Qodo PR-Agent | PR review | Open-source PR review (Apache 2.0), now community-governed [19][20] | Self-host + SaaS (Qodo Merge) | Self-host or SaaS | Apache-2.0 license; self-host; benchmark-leading F1 60.1% | No code graph; multi-repo "context engine" is embeddings, not graph |
| Sweep AI | PR review / agent | Pivoted away from coding PRs; now ESG/sustainability [21] | N/A | N/A | — | De-facto exited the market |
| Sourcegraph (Cody + Code Intelligence) | Graph + agent | SCIP-backed code graph; Cody chat+search; auto-edit; code review agents [22][23] | IDE ext + web + API | Self-host + Sourcegraph Cloud | Deepest graph incumbency; SCIP governance now open (Uber/Meta steering) [24] | SCIP governance move signals they're less possessive; Cody-as-surface is fading vs Code Intelligence-as-substrate |
| SCIP / LSIF specs | Graph infra | Compiler-grade index format for code intelligence [24] | File format + indexers | Anyone | Neutral spec; now community-governed | Ours consumes SCIP natively — we're downstream-compatible, not a fork |
| GitHub Code Search | Graph-lite | Semantic + symbol search across repos | Web + API | GitHub | Universal; zero-setup | No blast radius; no process clusters; not agent-shaped |
| Context7 | Docs grounding | Library-docs MCP; `resolve-library-id` → `query-docs` | MCP | SaaS | Best-in-class library-docs grounding | Docs only — doesn't know *your* repo |
| Repomix / pack-codebase | Grounding | Pack repo into a single token blob | CLI | Laptop | Simple; supports agent onboarding | Flat; no relations; token-bloated for any real repo |
| Aider context | Grounding | `repo-map` embedded into Aider agent | CLI | Laptop | Built-in to Aider | Aider-specific; not a surface |
| E2B | Sandbox | MicroVM code-exec sandboxes; 200M+ executions; OpenAI Agents SDK integration [25] | SDK | SaaS | Dominant execution substrate; Firecracker isolation | Execution-only; no grounding; we'd sit above them |
| Modal | Sandbox | gVisor sandboxes + GPU infra [25] | SDK | SaaS | Infra breadth | Same — execution substrate |
| GitHub MCP Server (official) | MCP ecosystem | 51 tools over OAuth; Streamable HTTP mode [26] | MCP | github.copilot.com/mcp | Official; OAuth; Lockdown Mode | 7-32× token bloat vs `gh` CLI; read-oriented, not graph-oriented |
| Linear / Sentry / PagerDuty MCP | MCP ecosystem | Remote MCP servers over HTTP+OAuth [27] | MCP (remote) | Vendor hosted | Remote MCP is real and production | All per-vendor; nobody ships a code-graph remote MCP |
| OPA / Conftest | Policy-as-code | Rego policies against structured inputs (Terraform plans, K8s) in CI [28] | CLI + GH Action | CI runner | Mature; deterministic; auditable | Targets IaC, not code-graph diffs |
| Semgrep Supply Chain | Policy-as-code | Reachability + malicious-dep detection + license + SAST [29] | CI | SaaS | Reachability analysis = graph-lite | Single-repo SAST; no cross-repo contract gate |
| Mergify / Dependabot / Renovate | Merge automation | Queue + auto-merge based on labels/statuses [30] | GitHub App | SaaS | Default plumbing for PR flow | No semantic gate — just label + status check plumbing |
| GitHub Rulesets + Checks API | Merge automation | Required status checks + branch protection [31] | GitHub native | GitHub | Owns the merge primitive | Any status we publish here becomes a gate |
| SLSA + Sigstore | Provenance | OIDC → Fulcio → Rekor attestations via GH Actions [32] | GH Action | Public good | Mature; OpenSSF-backed | Nobody wires SLSA attestations to *who-the-agent-was* — attestation target is always the build, not the agent identity |

## 2. Segment analysis

### Autonomous coding agents — who writes PRs, and where

Volume is clear. **Copilot, Claude Code, Cursor, and Jules** write most of the agent-authored PRs today. Copilot rides GitHub distribution, Claude Code ships `/loop` for cron-scheduled autonomous work [2], Cursor's Automations drive hands-off maintenance PRs claimed at "20–40% review reduction" [6], and Jules runs async in a Google Cloud VM with filesystem access [10]. Devin and Q Developer are real but sit in enterprise-deal volumes, not raw PR count.

Where they run matters more than who they are. Copilot, Cursor, Jules, and Claude Code-in-background-mode all execute in **ephemeral cloud runners** (GitHub Actions, Cursor Cloud, Google Cloud VMs, Anthropic-managed). This is the shift since early 2025: the PR-filing agent is no longer on a laptop. That's the bet OpenCodeHub must play to — the agent that writes the diff never sees a developer's IDE.

Grounding today is embarrassingly primitive. Every agent except Greptile and Sourcegraph Cody says some variant of "read files + maybe Grep." Claude Agent SDK literally lists `Read, Write, Edit, Bash, Glob, Grep` as its built-ins [3]. Nobody is asking for external graph grounding *explicitly*, because nobody has shipped it as an MCP tool that's easy to wire. The demand is latent: every post-mortem of a bad agent PR ("it broke the callers it couldn't see") is demand for blast-radius-in-one-call.

### PR review tools — how they gate merges

CodeRabbit, Greptile, Diamond, Ellipsis, and Qodo all publish **GitHub Check runs** that can be wired as required status checks [31]. CodeRabbit explicitly ships "pre-merge checks" — built-in + custom rules in YAML [14]. But every one of them produces an **LLM verdict** on a diff. Greptile markets "graph-based review" [15], but their graph is closed and the verdict is still LLM-synthesized text.

Nobody composes policy-as-code over a real code graph. Nobody publishes a Check that says `blast_radius=HIGH AND contract_version_bumped=false AND license_added=AGPL-3.0 → block`. CodeRabbit gets closest with YAML custom checks but has no graph substrate underneath. This is a wide-open seam.

### Code graph + grounding infrastructure

Sourcegraph is shifting. The March 2026 SCIP governance move — handing the spec to a Steering Committee with Uber and Meta engineers [24] — is Sourcegraph signaling that SCIP is infrastructure, not a product moat. Cody's positioning has softened; public comms emphasize **Code Intelligence** (the graph-as-substrate) and **review agents** rather than Cody-the-chatbot [22]. They're enterprise-priced, require hosted infra (Sourcegraph Cloud or self-managed), and are not lightweight enough for per-repo CI.

Practically, Sourcegraph owns "enterprise code graph on a server." OpenCodeHub owns "offline deterministic code graph in a CI runner's filesystem." Those are different products. We consume SCIP natively; we're downstream-compatible, not competitive on format.

### MCP ecosystem maturity

MCP 2025-03-26 / 2025-11-25 consolidated on **Streamable HTTP** (POST/GET, no persistent SSE) and **OAuth 2.1** for remote server auth [33]. Production deployments exist: Linear (May 2025 remote MCP), Sentry (production-ready MCP with Seer integration), PagerDuty (250+ customers within a month of launch) [27]. AWS Bedrock and Lambda-hosted MCP servers are documented patterns [33]. Auth is settled enough that enterprise teams now buy it.

The one soft spot is cost. GitHub's MCP server consumes **7–32× more tokens** than equivalent `gh` CLI calls [26]. This is pertinent to us — our MCP tools need to be token-lean per call, which is a design constraint we already meet (one-shot blast radius vs ten round-trips).

### Policy-as-code

Conftest/OPA is mature for Terraform plans and K8s manifests [28]. Semgrep Supply Chain is the closest thing to "graph-aware gating" with reachability analysis and license compliance [29]. But nobody blends **code-graph blast radius + contract diffs + SBOM license risk + scanner findings** into a single deterministic verdict. The market composes gates the way vi composes shortcuts: everyone wires their own.

This is the second wide-open seam. A policy-as-code primitive that takes a graph diff and emits a verdict with evidence is a product, not a feature.

### Provenance

SLSA Level 3 via GitHub Actions + Sigstore's Fulcio/Rekor pipeline is mature [32]. But the attestation subject is always **the build artifact**, not **the agent that authored the commit**. Claude Code's `Co-Authored-By: Claude` is literally a freeform git-trailer string and inconsistently respected even by Anthropic's own tool [34]. No agent platform I can find signs its outputs with a verifiable agent-identity attestation. This is a third open seam, though one with slower commercial pull.

## 3. Seams for OpenCodeHub

Each seam below describes where no player is credibly present, the closest almost-competitor, and why our existing assets give us a head start.

1. **Blast-radius-as-a-Check (deterministic merge gate).** Publish a GitHub Check named `codehub/impact` that maps a diff → affected symbols → risk tier in one call. Closest: Greptile (graph-claimed LLM review); CodeRabbit (YAML policies but no graph). Our head start: `impact()` + `detect_changes()` are already MCP tools returning deterministic structured output, and `SPECS.md §1.2` mandates byte-identical `graphHash` across runs [local]. No one else has determinism guarantees a compliance team can audit.

2. **Cross-repo contract gate.** `group_contracts` surfaces API contracts shared across a group of repos. Breaking changes become a Check that blocks merge. Closest: Sourcegraph Code Connect (enterprise-only, server-hosted); nobody in the PR-review segment does cross-repo. Our head start: `group_contracts`, `group_query`, `group_status`, `group_sync` already exist as cross-repo MCP primitives; nobody else has even a single-surface cross-repo graph tool.

3. **Policy-as-code over a code graph.** Expose the graph as a Rego input so teams write `deny[msg]` rules like "AGPL introduced" or "blast_radius=HIGH requires 2 reviewers." Closest: Conftest (IaC only) + Semgrep (pattern-only, not graph). Our head start: `sql` tool already exposes read-only graph access with 5s timeout [CLAUDE.md]; `verdict` tool gives us a natural point to plug a Rego evaluator.

4. **Agent-scoped grounding server for CI runners.** A remote (or in-runner-colocated) MCP server that any agent framework — Claude Agent SDK, Copilot agent runners, Cursor Cloud Agents — can consume without installing. Closest: GitHub's MCP (read-only of GH metadata, not code graph); Context7 (library docs only). Our head start: the MCP server is already stdio; we need a Streamable-HTTP mode and OIDC auth to be a drop-in in any runner.

5. **Claude Agent SDK hook pack.** Ship a published `@codehub/claude-hooks` that wires `PreToolUse(Edit)` → impact check → block-if-HIGH. Closest: nobody has shipped hook packs — the hook API exists and is empty [3]. Our head start: we already produce the exact structured output a hook would consume; this is a 200-line adapter.

6. **Agent-attributable provenance.** Sign PR diffs with an attestation whose subject is the *agent identity* (Claude Code Auto Mode, Cursor Cloud Agent #X), not the build. Closest: SLSA attests builds, not authorship; Claude Code's freeform git trailer [34]. Our head start: `detect_changes` already fingerprints the diff and our output envelope is versioned; adding a signed attestation over `{diff-hash, agent-id, graphHash, verdict}` is a natural extension.

7. **Staleness-aware grounding.** Most MCP tools silently serve stale data. Our `_meta["codehub/staleness"]` envelope makes staleness first-class; a CI gate can refuse to trust an agent that operated against a stale index. Closest: nobody — not even Sourcegraph exposes index-freshness per tool call. Our head start: already shipped [CLAUDE.md, OBJECTIVES.md §7].

8. **Deterministic cross-run graph hash for audit.** Compliance teams can verify that two PRs on identical commits got identical verdicts. Closest: nobody. Our head start: `graphHash` invariant is already an acceptance gate [SPECS §1.2].

## 4. Risks — who moves into this space fastest

### GitHub
GitHub owns the Checks API, the Rulesets primitive, the MCP server for its own surface, and the coding agent's execution environment [4][26][31]. Most likely move: a GitHub-native "Code Intelligence Check" that publishes a first-party Check run from an internal SCIP-like index, bundled with Copilot Enterprise. Countermove: be offline-first, deterministic, and license-open *now* — GitHub won't ship Apache-2.0 offline, won't cover non-GitHub SCMs, and will charge per-seat. Our wedge is "self-hostable, offline, cross-repo, any SCM."

### Sourcegraph
Sourcegraph has graph incumbency and enterprise trust. Most likely move: double down on Cody review agents + Code Connect, pitched as "Sourcegraph inside your CI." Countermove: we're a tenth the weight — no server to operate, one DuckDB file, embedded in the runner. The SCIP governance move [24] tells us Sourcegraph sees the protocol as a commons; that's good for us because our indexer stays interchangeable.

### Anthropic
Anthropic controls the agent side — Claude Agent SDK, Claude Code, the hook API [3]. Most likely move: ship a first-party "repo understanding" tool in the SDK that quietly replaces `Read + Grep` with a lightweight graph. Countermove: *become the reference implementation of that tool*. Ship the Claude hook pack (seam #5) so that when Anthropic looks for a graph backend, they integrate with us rather than rebuild. Mirror: same posture with Cursor and Jules.

### Secondary risk: Greptile / CodeRabbit
They could reposition from "LLM PR review" to "graph PR review" if they invest in indexing. Greptile v4 already markets graph-based [15]. Countermove: their graph is closed and SaaS-only. Ours is Apache-2.0 and offline. Position against them on auditability (deterministic verdict, graphHash invariant) and license (Apache-2.0 vs SaaS lock-in). Their enterprise buyers already ask for both.

## 5. Bet recommendations

1. **Ship Streamable-HTTP MCP transport with OIDC auth within 8 weeks.** *Why now:* remote MCP is production-real in 2026 [27][33]; every runner agent needs a no-install grounding endpoint; Claude Agent SDK + Copilot agent runners are hiring for exactly this shape. *Risk of being wrong:* stdio covers 80% of laptop use; if runner agents take longer to converge on remote MCP we ship ahead of demand. Low risk — this is table stakes.

2. **Ship `codehub/impact` as a first-party GitHub Check with a signed verdict by Q3.** *Why now:* CodeRabbit, Greptile, and Diamond own the GitHub App slot; we can't beat them on LLM review, but the "deterministic graph verdict" slot is empty [13][15][17]. *Risk of being wrong:* if GitHub ships its own Code Intelligence Check first, we become a complement, not a competitor — still fine if our depth is greater.

3. **Ship the Claude Agent SDK hook pack this quarter.** *Why now:* hooks API is live [3]; Claude Code's `/loop` and Auto Mode [1][2] mean agents are already running unattended; the hook is the last place to prevent a bad edit before it lands. *Risk of being wrong:* if Anthropic ships a first-party graph tool, our hook becomes redundant — but our backend is still consumable, and shipping now means we're the reference.

4. **Ship Rego-over-the-graph (`codehub/verdict --policy file.rego`) by Q4.** *Why now:* OPA/Conftest have a deep bench of policy authors [28]; Semgrep reachability [29] proves the appetite for graph-aware gating; nobody composes across the whole stack. *Risk of being wrong:* teams may prefer YAML over Rego for simplicity (see CodeRabbit's YAML success) — mitigate by shipping a YAML-subset frontend that compiles to Rego.

5. **Ship agent-identity attestations (SLSA-adjacent) in 2026-H2.** *Why now:* SLSA + Sigstore pipeline is mature [32]; no agent platform signs its outputs; Claude Code's co-author trailer [34] is evidence the market feels the gap but hasn't solved it. *Risk of being wrong:* buyers may not care yet. Slower commercial pull than seams 1–4, so sequence it last, but it's the moat when compliance catches up to agent-authored commits.

---

## Sources

1. sfeir.com — "Claude Code Auto Mode: Permissions & Autonomy" (March 2026). https://institute.sfeir.com/en/articles/claude-code-auto-mode-permissions-autonomy/
2. winbuzzer.com — "Anthropic Claude Code cron scheduling background worker loop" (March 2026). https://winbuzzer.com/2026/03/09/anthropic-claude-code-cron-scheduling-background-worker-loop-xcxwbn/
3. Anthropic — "Claude Agent SDK overview" (retrieved April 2026). https://code.claude.com/docs/en/agent-sdk/overview
4. GitHub — "Copilot CLI autopilot" (2026). https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot
5. GitHub — "Copilot direct edits via @mention" (March 2026). https://blockchain.news/news/github-copilot-pull-request-direct-edits
6. digitalapplied.com — "Cursor Automations guide" (early 2026). https://www.digitalapplied.com/blog/cursor-automations-always-on-agentic-coding-agents-guide
7. graphite.com — "Cursor Cloud Agents in Graphite" (March 2026). https://www.graphite.com/blog/cursor-cloud-agents
8. eesel.ai — "Cognition AI pricing" (2026). https://www.eesel.ai/blog/cognition-ai-pricing
9. vibecoding.app — "Devin review" (2026). https://vibecoding.app/blog/devin-review
10. testingcatalog.com — "Google prepares Jules V2 agent" (April 6 2026). https://www.testingcatalog.com/google-prepares-jules-v2-agent-capable-of-taking-bigger-tasks/
11. AWS — "Amazon Q Developer FAQs" (2026). https://aws.amazon.com/q/developer/faqs/
12. mindstudio.ai — "Replit Agent 4 vs Bolt" (early 2026). https://www.mindstudio.ai/blog/replit-agent-4-vs-bolt
13. coderabbit.ai — "How CodeRabbit delivers accurate AI code reviews on massive codebases" (2025). https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases
14. coderabbit.ai — "Pre-merge checks built-in and custom" (2025). https://www.coderabbit.ai/blog/pre-merge-checks-built-in-and-custom-pr-enforced
15. greptile.com — "Greptile v4 release" (2026). https://www.greptile.com/blog/greptile-v4
16. morphllm.com — "Greptile vs Copilot comparison" (2026). https://www.morphllm.com/comparisons/greptile-vs-copilot
17. devclass.com — "Graphite debuts Diamond AI code reviewer" (March 2025). https://devclass.com/2025/03/19/graphite-debuts-diamond-ai-code-reviewer-insists-ai-will-never-replace-human-code-review/
18. docs.ellipsis.dev — "Ellipsis features" (retrieved 2026). https://docs.ellipsis.dev/features
19. qodo.ai — "Qodo hands PR-Agent to the community" (April 2026). https://www.qodo.ai/blog/qodo-is-handing-pr-agent-over-to-the-community/
20. github.com/qodo-ai/pr-agent — Qodo PR-Agent repo (2026). https://github.com/qodo-ai/pr-agent
21. prnewswire.com — "Sweep raises $22.5M Series B" (May 2025). https://www.prnewswire.com/news-releases/sweep-raises-22-5m-in-series-b-funding-led-by-insight-partners-302460023.html
22. sourcegraph.com — "Cody: better, faster, stronger" (2025). https://sourcegraph.com/blog/cody-better-faster-stronger
23. infoworld.com — "Sourcegraph unveils AI coding agents" (2025). https://www.infoworld.com/article/3812799/sourcegraph-unveils-ai-coding-agents.html
24. sourcegraph.com — "The future of SCIP" (March 2026). https://webflow.sourcegraph.com/blog/the-future-of-scip
25. northflank.com — "E2B vs Modal" (2026). https://northflank.com/blog/e2b-vs-modal
26. github.com/github/github-mcp-server — GitHub official MCP server (2026). https://github.com/github/github-mcp-server
27. linear.app — "Linear MCP changelog" (May 2025). https://linear.app/changelog/2025-05-01-mcp ; sentry.io — "Sentry MCP docs." https://docs.sentry.io/ai/mcp/ ; pagerduty.github.io — "PagerDuty remote MCP server" (2026). https://pagerduty.github.io/pagerduty-mcp-server/docs/remote-server/setup
28. policyascode.dev — "GitHub Actions policies with OPA/Conftest" (2025). https://policyascode.dev/guides/github-actions-policies
29. semgrep.dev — "Block malicious dependencies with Semgrep Supply Chain" (2025). https://semgrep.dev/blog/2025/block-malicious-dependencies-with-semgrep-supply-chain
30. docs.mergify.com — "Mergify Dependabot integration" (2025). https://docs.mergify.com/integrations/dependabot
31. docs.github.com — "Checks API & Rulesets" (2026). https://docs.github.com/enterprise-cloud@latest/rest/guides/getting-started-with-the-checks-api
32. github.blog — "SLSA 3 compliance with GitHub Actions" (updated 2024+). https://github.blog/security/supply-chain-security/slsa-3-compliance-with-github-actions/
33. aws.amazon.com — "Open protocols for agent interoperability: authentication on MCP" (2025). https://aws.amazon.com/blogs/opensource/open-protocols-for-agent-interoperability-part-2-authentication-on-mcp/
34. github.com/anthropics/claude-code — Issues #1653, #4224, #6848 on Co-Authored-By attribution (2025–2026). https://github.com/anthropics/claude-code/issues/1653
