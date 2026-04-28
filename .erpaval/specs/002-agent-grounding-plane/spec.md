# Spec 002 — CI Action Surface (CLI-wrapping, deferred)

*EARS form. Feeds `/erpaval` Act phase once spec 001 ships. Rewritten 2026-04-27 to remove the HTTP/SDK framing. Source memos: `007-agents-at-scale-strategy.md` (diagnosis retained, transport rejected), `011-ci-integration-playbook.md` (workflows retained, HTTP server removed), `013-synthesis-v2-two-surface-product.md` §rescinded sections. Companion spec: `.erpaval/specs/001-claude-code-artifact-surface/spec.md` (artifact factory, laptop — ships first).*

## Spec directory note

The directory is named `002-agent-grounding-plane/` for historical reasons — the original v1 of this spec designed an HTTP MCP "grounding plane" with an agent SDK. Both are now explicitly out of scope (see project memory: no HTTP MCP, no agent SDK). The renamed content is a **CI action surface**: OSS GitHub Actions (and GitLab templates) that shell out to the `codehub` CLI.

## Scope

Ship OSS CI integrations that let a customer run OpenCodeHub's graph-backed verdict + blast-radius gates in their own runners. Every integration is a **thin wrapper around the `codehub` CLI** — no HTTP server, no MCP-over-HTTP, no remote transport, no SDK for agents. The shape is:

1. Customer authors `opencodehub.policy.yaml` in their repo (or group root).
2. CI action checks out code, runs `codehub analyze` inside the runner, uploads the graph blob to their chosen storage tier.
3. CI action pulls the graph on the PR side, runs `codehub verdict --policy opencodehub.policy.yaml --pr base..head`, posts a GitHub Check with per-rule annotations, applies an `opencodehub:auto-approve` label on full pass.
4. Customer's branch-protection rules decide whether the Check gates merge.

**Distribution model (re-stated):** OpenCodeHub is self-hosted OSS. Every action runs inside the customer's CI runner. Storage lives in the customer's GitHub Actions Cache, bucket, or self-operated MinIO. No OpenCodeHub-operated infrastructure.

**Priority:** This entire spec is P1 — deferred until spec 001 (laptop artifact factory) ships and has adoption. Some items slide to P2.

## Out of scope for this spec (now and forever for most)

- **Remote / HTTP MCP server** — ruled out permanently (project memory). MCP stays stdio-only for the Claude Code plugin on the laptop.
- **Agent SDK (Python or TypeScript)** — ruled out permanently. Agents call OpenCodeHub via (a) the Claude Code plugin on a laptop, or (b) shelling out to the `codehub` CLI.
- **`@opencodehub/claude-hooks` SDK wrapper** — ruled out permanently.
- **`grounding_pack` MCP tool** — ruled out; its value was SDK consumption. Composable equivalents already exist as individual MCP tools accessible from Claude Code.
- **Hosted / managed / SaaS tier** — ruled out permanently.
- **OpenCodeHub-branded coding agent** — ruled out permanently.
- **LLM-based PR review** — we compete on deterministic verdict, not LLM verdict.
- **IDE plugin / LSP** — out.
- **Fine-tuned models** — out.

## Acceptance criteria (EARS)

### Ubiquitous

- **AC-1-1** The system shall ship three GitHub Actions under `packages/actions/`:
  - `opencodehub/token-action@v1` (OIDC → signed JWT used only for storage-backend presign; no HTTP MCP endpoint consumes it),
  - `opencodehub/analyze-action@v1` (shells `codehub analyze`, uploads graph blob),
  - `opencodehub/verdict-action@v1` (shells `codehub verdict`, posts GitHub Check).
  Each is publishable to the GitHub Marketplace under the `opencodehub/` org. [P]
- **AC-1-2** The `codehub` CLI shall gain a `codehub verdict` subcommand that consumes `opencodehub.policy.yaml`, compiles rules against the local graph, and writes a structured verdict JSON to stdout. The subcommand shall not open any network connections beyond what existing analyzers already require. [P]
- **AC-1-3** The system shall define `opencodehub.policy.yaml` schema version 1 at `packages/policy/schemas/policy-v1.json` with four rule types (`blast_radius_max`, `license_allowlist`, `ownership_required`, `arch_invariants`). [P]
- **AC-1-4** The system shall ship GitLab CI templates at `packages/cli/src/ci-templates/gitlab/` mirroring the two primary actions with equivalent semantics. [P]

### Event-driven

- **AC-2-1** When `token-action@v1` runs inside a workflow with `permissions: id-token: write`, it shall exchange the GitHub OIDC token for a signed JWT (15-minute TTL) scoped to `{install_id, repo, pr_ref?}` and shall write it to `$GITHUB_ENV` as `OPENCODEHUB_TOKEN`. The JWT shall be used only by the `analyze-action` and `verdict-action` storage-backend presign endpoints that the customer themselves operates.
- **AC-2-2** When `analyze-action@v1` runs with `OPENCODEHUB_TOKEN` set, it shall execute `codehub analyze` on the working tree, capture the resulting `graph_hash`, and upload the graph blob to the configured storage backend. Step outputs shall include `graph-hash`, `graph-uri`, and `cache_hit` (boolean). Dependencies: AC-2-1, AC-4-1
- **AC-2-3** When `verdict-action@v1` runs with `OPENCODEHUB_TOKEN` and `graph-uri` inputs, it shall download the graph blob, execute `codehub verdict --policy <path> --pr <base..head>`, parse the structured verdict JSON, post a GitHub Check named `OpenCodeHub / verdict` with per-rule annotations, and apply the `opencodehub:auto-approve` label if and only if the verdict is `pass` with `auto_approve: true`. Dependencies: AC-1-2, AC-2-2
- **AC-2-4** When `codehub verdict` is invoked with a valid `opencodehub.policy.yaml` and a fresh graph, it shall return a structured JSON verdict with top-level `outcome` in `pass|fail|needs-review`, an `auto_approve` boolean, and a `rules[]` array with per-rule entries `{id, type, outcome, evidence, blocked_merge}`. Dependencies: AC-1-2, AC-1-3
- **AC-2-5** When `codehub verdict` is invoked twice on unchanged inputs (same `graph_hash`, same `pr_ref`, same policy file, same `policy_version`), the two verdicts shall be byte-identical. Dependencies: AC-2-4

### State-driven

- **AC-3-1** While the customer has configured `storage-backend: actions-cache` (default), the `analyze-action` and `verdict-action` shall route all blob I/O through `actions/cache@v4` keyed by `opencodehub:{repo}:{graph_hash}`. No external service is contacted. Dependencies: AC-1-1
- **AC-3-2** While `OPENCODEHUB_EXPERIMENTAL_ARCH_INVARIANTS` is unset or `0`, `codehub verdict` shall return `outcome: skipped, reason: feature_flag` for every `arch_invariants` rule and shall evaluate the other three rule types normally. Dependencies: AC-1-2, AC-1-3
- **AC-3-3** While the graph blob referenced by `(repo, commit_sha)` is missing from the configured storage backend when `verdict-action@v1` runs, the action shall post a GitHub Check with conclusion `neutral` and message `graph not yet indexed — analyze-action must run first`; the workflow shall not exit `failure`. Dependencies: AC-2-3

### Optional feature

- **AC-4-1** Where the workflow configures `storage-backend: s3 | r2 | minio`, the action shall accept customer-supplied bucket credentials via GitHub Secrets and shall mint presigned URLs inside the runner using the customer's own tooling (e.g., `aws-actions/configure-aws-credentials`). No OpenCodeHub-operated service mints URLs. Dependencies: AC-2-2
- **AC-4-2** Where `opencodehub.policy.yaml` declares `auto_approve.require: [...]`, the `codehub verdict` output shall compute `auto_approve: true` if and only if every `require` clause passes. Dependencies: AC-2-4
- **AC-4-3** Where a repo-root `opencodehub.policy.yaml` and a group-root policy both exist, the repo-root shall take precedence and the merged effective policy (with inheritance chain) shall appear in the verdict output. Dependencies: AC-2-4
- **AC-4-4** Where the workflow wants `arch_invariants` rule evaluation in production, setting `OPENCODEHUB_EXPERIMENTAL_ARCH_INVARIANTS=1` in the action `env:` shall unlock evaluation; before the flag is flipped, the schema slot shall still be reserved so customers may author rules. Dependencies: AC-3-2

### Unwanted behavior

- **AC-5-1** If `opencodehub.policy.yaml` fails JSON Schema validation, `codehub verdict` shall exit with a non-zero code, shall not return a pass verdict, and shall print the schema error path and message. Dependencies: AC-1-3, AC-2-4
- **AC-5-2** If `analyze-action@v1` runs without `permissions: id-token: write`, it shall exit with a clear error message naming the missing permission, before attempting any upload. Dependencies: AC-2-1, AC-2-2
- **AC-5-3** If `verdict-action@v1` encounters a rule that the current CLI build cannot evaluate (e.g., a rule type introduced in a newer schema), it shall mark that rule `outcome: error, reason: unsupported_rule_type` but shall continue evaluating other rules. Dependencies: AC-2-4
- **AC-5-4** If any action attempts to contact an OpenCodeHub-operated endpoint (i.e., a hostname not matching `github.com`, GitHub Marketplace artifact hosts, the customer's configured storage bucket, or the customer's own JWT issuer), the action shall fail fast. No calls home. Dependencies: AC-1-1

### Policy schema (four rule types, reused across CLI + actions)

- **AC-6-1** `blast_radius_max` rule: input `{max_tier: 1..5}`; evaluated by calling `impact(detect_changes(pr_ref))` through the in-process graph client and asserting `max(tier) <= max_tier`. Evidence: affected symbols + max tier. [P] Dependencies: AC-1-3, AC-2-4
- **AC-6-2** `license_allowlist` rule: input `{allow: [SPDX-ids], deny: [SPDX-ids]}`; evaluated by the CLI's existing `license_audit` pipeline filtered by allow/deny. Evidence: package + resolved license + decision. [P] Dependencies: AC-1-3, AC-2-4
- **AC-6-3** `ownership_required` rule: input `{paths: [globs], require_approval_from: [teams | @users]}`; evaluated via `owners(pr_ref.changed_paths)` plus an approval-state lookup through the GitHub API (the action already has a token from the workflow context, so the CLI reads the approval state from the action rather than from a remote service). Evidence: path → required reviewer set → approval state. [P] Dependencies: AC-1-3, AC-2-4
- **AC-6-4** `arch_invariants` rule (schema-v1 scaffolded, feature-flagged): input `{id, query: <constrained-yaml>, severity}`; compiled to a curated cypher subset evaluated against the local graph. Only evaluated when `OPENCODEHUB_EXPERIMENTAL_ARCH_INVARIANTS=1`. Dependencies: AC-1-3, AC-2-4, AC-3-2

## Success criteria (beyond ACs)

- At least one design-partner org runs `analyze-action` + `verdict-action` on at least 10 real PRs per week with no false-block incidents for two consecutive weeks.
- Published Marketplace actions with ≥ 100 workflow runs across external repos in the month post-launch.
- `codehub verdict` p50 latency ≤ 5s on a warm graph for a 20-file PR.
- Zero calls home — audit the action manifests against AC-5-4.

## Validation

- **Static layer**: `tsc --noEmit` across `packages/actions/*/`, `packages/policy/`, `packages/cli/`. All typed.
- **Action layer**: GitHub Actions metadata validation via `actions/validate-workflow-schema`. Each action's `action.yml` lints clean.
- **Behavioral layer**: end-to-end synthetic PR test — a workflow on this repo runs `token → analyze → verdict` through the matrix (policy pass, policy fail per rule type, missing graph, missing token, expired token). Asserts Check annotations, labels, and exit codes.
- **Regression layer**: spec 001 artifact factory must still operate; existing `/probe`, `/verdict`, `/audit-deps`, `/rename`, `/owners` skill flows must still work laptop-side.
- **No-call-home layer**: action manifests audited; tcpdump on a test runner confirms no traffic leaves the (runner, GitHub, customer bucket) triad.

## Risks (see synthesis 013 §Risks, filtered)

1. **GitHub ships a first-party "Code Intelligence Check"** — countermove: be license-open, self-hostable, cross-SCM.
2. **Graph-privacy pushback from regulated orgs** — countermove (P2): per-repo CMK binding for graph storage, documented air-gap deployment pattern.
3. **Policy DSL expressiveness vs safety** — mitigated by v1 constrained YAML; `arch_invariants` feature-flagged.
4. **CLI invocation overhead dwarfing the verdict itself** — mitigated by graph blob caching via `actions/cache@v4`.

## Priority and sequencing

- **All items in this spec: P1** unless marked below.
- **P2 items** (deferred further):
  - `arch_invariants` flag-flip default-on
  - GitLab templates (ship GitHub Actions first)
  - Customer-self-hosted GitHub App webhook subscriber (wraps the same actions)
  - Sigstore-signed provenance attestations
  - Cross-org policy federation (git-based, no central registry)
  - `codehub provenance record` + `.opencodehub/grounding.json` sidecar

None of this spec begins until spec 001 (laptop artifact factory) has landed and produced adoption signal.

## References

- `/.erpaval/brainstorms/007-agents-at-scale-strategy.md` — diagnosis retained; Actions A/C/D/F rescinded (HTTP/SDK); Actions B/E/G/J reshaped to CLI-wrapping
- `/.erpaval/brainstorms/011-ci-integration-playbook.md` — workflow YAML shapes retained; HTTP server steps removed
- `/.erpaval/brainstorms/012-competitive-landscape.md` — deterministic-verdict wedge positioning
- `/.erpaval/brainstorms/013-synthesis-v2-two-surface-product.md` — synthesis (revised 2026-04-27 to remove HTTP + SDK)
- `/.erpaval/specs/001-claude-code-artifact-surface/spec.md` — companion spec, ships first
- Project memory: `project_opencodehub_no_http_mcp_no_sdk.md`, `project_opencodehub_no_saas.md`
