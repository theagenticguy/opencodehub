# USECASE.md — OpenCodeHub

## Customer Problem / Opportunity Statement

Today, **software engineers working with AI coding agents** have to
**babysit those agents through every non-trivial refactor, cross-file
change, or blast-radius question — re-prompting them when they miss
callers, break downstream handlers, or edit a hot-path function without
knowing it's on the hot path** when **the agent's only view of the
codebase is whatever files it opened and whatever strings `grep` turned
up, so it cannot see the graph — the callers, callees, processes, and
data flows — the change actually sits inside**. Customers need a way to
**give their agents a precomputed, graph-aware view of the repository
that answers "what breaks if I change this, what depends on this, where
does this data flow" in one tool call, locally, on an Apache-2.0 stack
they can embed and ship**.

## How Might We statements

### 1. Amp up the good — *agents are already great at code synthesis once they have the right context*

**How might we** ship agents a single, deterministic, graph-grounded
context pack (callers + callees + participating processes + blast radius
+ risk tier) at the moment they are about to write a diff, so their
existing synthesis skill lands the first edit correctly instead of the
third?

Concrete angle: `impact(target)` already returns depth buckets, affected
modules, affected processes, and a risk tier. Wire it into
PreToolUse hooks so every rename-class edit gets auto-enriched before
the model sees the file.

### 2. Remove the bad — *the failure modes that make agents untrustworthy*

**How might we** eliminate the three recurring agent failures the README
calls out — missed dependencies, broken call chains, blind hot-path
edits — by turning them into gate conditions (`verdict: block`,
`impact: HIGH`) the agent must resolve before it can merge, instead of
bugs we find in code review?

Concrete angle: the `verdict` tool already returns one of five tiers;
surface `block` / `expert_review` as non-zero CLI exit codes (it
already does) *and* as PR-check failures via `ci-init`-generated
workflows so the loop closes in CI, not just in the editor.

### 3. Explore the opposite — *what if the agent never had to ask?*

**How might we** invert the pull model entirely and have OpenCodeHub
write the relevant graph context as structured comments / SKILL.md
stanzas / wiki pages *into the repo* at index time, so the agent
reads the context as code, not as tool output?

Concrete angle: `codehub analyze --skills` already emits one `SKILL.md`
per Community with ≥ 5 symbols under `.codehub/skills/`, and
`codehub wiki --llm` renders LLM-narrated module pages. The opposite
extreme is full: every callable gets a co-located summary block
(already validated by a Zod contract and embedded via Bedrock / Haiku
4.5) so the agent never needs a query round-trip for static context.

### 4. Create an analogy — *agents as new hires, OpenCodeHub as the onboarding wiki*

**How might we** treat a new agent session the way a good engineering
team treats a new hire — hand them a map of the services, the critical
flows, and the "if you touch this, also touch that" crib sheet on day
one — so the first pull request they open is already shaped by
institutional knowledge?

Concrete angle: the MCP server already exposes
`codehub://repo-context`, `codehub://repo-clusters`, and
`codehub://repo-processes` as resources. Treating those as the
new-hire doc set (Processes = "the way requests move through this
system"; Communities = "the neighborhoods of this codebase") reframes
the product from "another search tool" to "onboarding-as-a-service
for agents".

---

## Storyboards

### Storyboard A — Solo developer asking an agent to rename a core function

- **Frame 1 — Setting & user.** Priya is a backend engineer at a
  mid-size SaaS company. Saturday morning, one terminal, one editor,
  Claude Code open.
- **Frame 2 — Trigger.** She wants to rename `validateUser` to
  `validateAccount` across a TypeScript + Python monorepo she maintains.
- **Frame 3 — Pain.** The agent greps, finds three hits, edits them,
  declares victory. CI blows up Monday on 14 call sites the string match
  missed — two of them in the Python service.
- **Frame 4 — Discovery.** A teammate mentions OpenCodeHub; she runs
  `codehub setup` and `codehub analyze` once.
- **Frame 5 — Action.** She re-asks the agent. This time the agent
  calls `impact("validateUser")`, gets `risk: HIGH, direct callers: 14,
  affected processes: 3`, then `rename validateUser validateAccount`
  (dry-run by default) and gets a coordinated edit plan with
  per-site confidence.
- **Frame 6 — Resolution.** She reviews the plan, applies it. Tests
  pass. Zero Monday fires.
- **Frame 7 — Ongoing benefit.** The plugin's `PostToolUse` hook
  re-analyzes after every `git commit | merge | rebase | pull`, so the
  graph stays current without her thinking about it.

### Storyboard B — Platform engineer onboarding a new service to a fleet of 40 repos

- **Frame 1 — Setting & user.** Miguel is on a platform team that owns
  40 microservices across Go, Python, and TypeScript.
- **Frame 2 — Trigger.** A new team joins with a fresh service and wants
  to know which upstream callers already hit the shared `/users` HTTP
  surface and which producers publish the `account.created` topic.
- **Frame 3 — Pain.** The answer currently lives in people's heads and
  half-outdated Confluence pages. The onboarding call runs long.
- **Frame 4 — Discovery.** Miguel sees OpenCodeHub's
  `codehub group create fleet service-a service-b ...` flow and the
  `group_sync` tool that extracts HTTP / gRPC / topic contracts across
  every repo.
- **Frame 5 — Action.** He creates a group for the fleet, runs
  `codehub group sync fleet`, then asks his agent via the
  `group_contracts` MCP tool for every repo that FETCHES `/users` and
  every producer of `account.created`.
- **Frame 6 — Resolution.** The agent returns the DuckDB-backed
  FETCHES↔Route edges plus signature-matched cross-links from the
  registry. The new team gets a concrete list of upstream dependencies
  in five minutes.
- **Frame 7 — Ongoing benefit.** `group_query` now fans BM25 across the
  whole fleet with RRF fusion; onboarding calls for future services
  start with a working query instead of a whiteboard.

### Storyboard C — Security engineer auditing blast radius before approving a PR

- **Frame 1 — Setting & user.** Dana is a security engineer reviewing a
  PR that touches a Python auth helper.
- **Frame 2 — Trigger.** The PR has a three-line diff. Her instinct
  says "too small to be safe".
- **Frame 3 — Pain.** She has no fast way to check how many flows the
  diff actually lands on, whether the touched symbol carries dead-code
  or license risk, and whether the new scanner findings are regressions.
- **Frame 4 — Discovery.** Her team has OpenCodeHub in CI via
  `codehub ci-init`. The `verdict` tool ran on the PR and came back
  `expert_review` with reasoning signals and a scanner findings delta.
- **Frame 5 — Action.** From the MCP server inside Claude Code she
  runs `detect_changes` against the PR diff, then `list_findings_delta`
  against the frozen baseline, then `license_audit` for the newly
  pulled dependency.
- **Frame 6 — Resolution.** The tools show three `HIGH`-severity
  scanner findings newly introduced and one dependency that flips the
  `license_audit` tier from `OK` to `WARN`. She blocks the PR with
  specifics, not a gut feeling.
- **Frame 7 — Ongoing benefit.** `risk_trends` gives her per-community
  trend lines and 30-day projections, so she sees which subsystems are
  accumulating risk before anyone files a ticket.
