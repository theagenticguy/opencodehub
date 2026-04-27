/* Roadmap data — scope locked 2026-04-27.
 *
 * Distribution model: self-hosted OSS only. No SaaS, no managed tier, no
 * OpenCodeHub-operated infrastructure.
 *
 * Scope exclusions (per user directive 2026-04-27):
 *   - NO remote / HTTP MCP server
 *   - NO agent SDK (Python or TypeScript)
 *   - NO claude-hooks SDK wrapper
 *   - NO grounding_pack MCP tool as an agent-SDK compositor
 *
 * Surfaces that remain:
 *   1. Claude Code plugin on the laptop via stdio MCP (artifact factory)
 *   2. OSS GitHub Actions + GitLab templates wrapping the codehub CLI
 *      (policy, verdict, analyze — CLI under the hood, no HTTP, no SDK)
 *
 * Sources:
 *   .erpaval/brainstorms/006-synthesis-whats-next.md
 *   .erpaval/brainstorms/013-synthesis-v2-two-surface-product.md
 *   .erpaval/specs/001-claude-code-artifact-surface/spec.md
 *   (Spec 002 HTTP + SDK portions rescinded; CLI-wrapping actions survive)
 */

window.RoadmapData = {
  pillars: [
    {
      id: "pillar-laptop-artifacts",
      title: "Laptop · Artifact factory",
      surface: "laptop",
      body: "Claude Code plugin turns the graph into committed Markdown. The visible wedge — developers touch it, it demos well, it builds trust in the graph. All five artifact skills ship P0.",
      items: ["l-doc-skill", "l-doc-agents", "l-precompute", "l-docmeta", "l-pr-desc", "l-onboarding", "l-contract-map", "l-hooks", "l-discover"]
    },
    {
      id: "pillar-laptop-followups",
      title: "Laptop · Follow-ups",
      surface: "laptop",
      body: "P1/P2 additions to the laptop plugin once the P0 family lands and design partners give us field data.",
      items: ["l-adr", "l-doc-auto"]
    },
    {
      id: "pillar-runner-ci",
      title: "Runner · OSS GitHub Actions (CLI-wrapping)",
      surface: "runner",
      body: "CI thin shells around the codehub CLI. No HTTP MCP, no agent SDK — the action runs codehub analyze or codehub verdict inside the customer's runner and posts a GitHub Check. Deferred until after the laptop surface has traction.",
      items: ["r-analyze-action", "r-verdict-action", "r-token-action", "r-policy-schema", "r-policy-cli", "r-storage-tier0", "r-storage-tier1", "r-gitlab", "r-arch-invariants"]
    },
    {
      id: "pillar-runner-later",
      title: "Runner · Later",
      surface: "runner",
      body: "P2 runner items that only make sense once the P1 action + policy surface has adoption.",
      items: ["r-provenance-cli", "r-sigstore-prov", "r-self-gh-app", "r-federation"]
    },
    {
      id: "pillar-exclusions",
      title: "Explicit exclusions",
      surface: "laptop",
      body: "Shape choices we are rejecting, recorded as first-class cards so they are visible in every view. Stability and focus come from what we say no to.",
      items: ["x-saas", "x-http-mcp", "x-agent-sdk", "x-agent", "x-llm-review", "x-ide", "x-fine-tune"]
    }
  ],

  items: [
    /* ───────── Laptop · artifact factory · P0 ───────── */
    {
      id: "l-doc-skill",
      title: "codehub-document skill",
      surface: "laptop", tier: "P0",
      track: "laptop-skills",
      week: { start: 3, end: 7 },
      critical: true,
      tags: ["skill", "plugin", "codeprobe-pattern"],
      blurb: "Primary artifact generator. Single-repo and group mode, 4-phase orchestration (Phase 0 precompute → AB parallel → CD parallel → E assembler).",
      why: "The flagship of the laptop surface. Ports codeprobe's proven /document pattern to OpenCodeHub's graph, extended with group mode as the multi-repo wedge. If this skill does not ship, the laptop surface remains analytical-only.",
      scope: [
        "plugins/opencodehub/skills/codehub-document/SKILL.md",
        "references/ directory for progressive disclosure",
        "Argument hints: [output-dir] [--group <name>] [--committed] [--refresh] [--section <name>]",
        "Opus on --refresh --group; Sonnet otherwise"
      ],
      depends: ["l-doc-agents", "l-precompute", "l-docmeta"],
      unblocks: ["l-discover", "l-hooks", "l-contract-map"],
      source: "Spec 001 AC-2-1 · brainstorm 003/006/013"
    },
    {
      id: "l-doc-agents",
      title: "Six doc-* subagents",
      surface: "laptop", tier: "P0",
      track: "laptop-skills",
      week: { start: 3, end: 6 },
      critical: true,
      tags: ["agents", "sonnet", "plugin"],
      blurb: "doc-architecture, doc-reference, doc-behavior, doc-analysis, doc-diagrams, doc-cross-repo (group-only). Eight-section scaffold per codeprobe.",
      why: "Parallel subagents are the cost-efficient way to produce 30+ documents — each runs Sonnet, reads the Phase 0 precompute from disk, writes its own files in isolation.",
      scope: [
        "plugins/opencodehub/agents/doc-architecture.md",
        "plugins/opencodehub/agents/doc-reference.md",
        "plugins/opencodehub/agents/doc-behavior.md",
        "plugins/opencodehub/agents/doc-analysis.md",
        "plugins/opencodehub/agents/doc-diagrams.md",
        "plugins/opencodehub/agents/doc-cross-repo.md (group mode)"
      ],
      depends: [],
      unblocks: ["l-doc-skill"],
      source: "Spec 001 AC-1-2 · brainstorm 004"
    },
    {
      id: "l-precompute",
      title: "Phase 0 shared-context precompute",
      surface: "laptop", tier: "P0",
      track: "laptop-substrate",
      week: { start: 2, end: 4 },
      critical: true,
      tags: ["precompute", "substrate"],
      blurb: "Writes .codehub/.context.md (200-line cap) and .codehub/.prefetch.md (JSON tool-call ledger). Prompt-dedup via filesystem.",
      why: "The single design choice that makes parallel subagents affordable — every doc-* reads the same precomputed context instead of re-calling tools. Copied from codeprobe and extended for group mode.",
      scope: [
        "packages/analysis/src/prefetch.ts (or equivalent)",
        "200-line cap with per-section truncation flags",
        "Group mode writes to .codehub/groups/<name>/"
      ],
      depends: [],
      unblocks: ["l-doc-skill", "l-doc-agents"],
      source: "Spec 001 AC-6-1 · brainstorm 004/005"
    },
    {
      id: "l-docmeta",
      title: ".docmeta.json + Phase E assembler",
      surface: "laptop", tier: "P0",
      track: "laptop-substrate",
      week: { start: 4, end: 7 },
      tags: ["assembler", "determinism"],
      blurb: "Phase E: regex over backtick citations → co-occurrence join → See-also footers + cross-repo link graph. Sidecar drives --refresh.",
      why: "Deterministic 40-line code that makes the artifact tree machine-navigable. Without it, --refresh is impossible and cross-repo links never get computed.",
      scope: [
        "JSON Schema for .docmeta.json (generated_at, graph_hash, mode, sections[], cross_repo_refs[])",
        "Phase E citation regex + co-occurrence assembler",
        "--refresh diff algorithm"
      ],
      depends: ["l-doc-skill"],
      unblocks: ["l-hooks"],
      source: "Spec 001 AC-4-1/4-3 · brainstorm 005"
    },
    {
      id: "l-pr-desc",
      title: "codehub-pr-description skill",
      surface: "laptop", tier: "P0",
      track: "laptop-skills",
      week: { start: 4, end: 6 },
      tags: ["skill", "linear"],
      blurb: "Generates Markdown PR body from detect_changes + verdict + owners + list_findings_delta. Refuses on a clean tree.",
      why: "Highest-frequency use case (every PR). Shortest agent path in the family. Demonstrates the MCP→Markdown pipeline in 10 seconds, not 90.",
      scope: [
        "plugins/opencodehub/skills/codehub-pr-description/",
        "Sonnet, linear (no subagents)",
        "Writes to .codehub/pr/PR-<branch>.md by default"
      ],
      depends: [],
      unblocks: [],
      source: "Spec 001 AC-2-5 · brainstorm 003"
    },
    {
      id: "l-onboarding",
      title: "codehub-onboarding skill",
      surface: "laptop", tier: "P0",
      track: "laptop-skills",
      week: { start: 5, end: 7 },
      tags: ["skill", "subagent"],
      blurb: "Produces ONBOARDING.md with ranked reading order from project_profile + graph centrality + owners + entry points.",
      why: "Lowest-effort v1 output that immediately showcases the graph doing something prose can't — ranked reading order from centrality.",
      scope: [
        "plugins/opencodehub/skills/codehub-onboarding/",
        "One specialty subagent (doc-onboarding)",
        "Default .codehub/ONBOARDING.md; --committed writes to docs/"
      ],
      depends: ["l-precompute"],
      unblocks: [],
      source: "Spec 001 AC-2-6 · brainstorm 003"
    },
    {
      id: "l-contract-map",
      title: "codehub-contract-map skill",
      surface: "laptop", tier: "P0",
      track: "laptop-skills",
      week: { start: 6, end: 9 },
      tags: ["skill", "group-mode", "mermaid"],
      blurb: "Cross-repo-only skill that renders group_contracts into Markdown + Mermaid. Ships standalone alongside codehub-document --group.",
      why: "Promoted to P0. Group-level contract artifacts are the uniquely-ours wedge — nobody else exposes cross-repo graph primitives as a skill. Shipping standalone lets the skill fire on direct invocations (\"map the contracts\") without requiring the full codehub-document flow.",
      scope: [
        "plugins/opencodehub/skills/codehub-contract-map/",
        "Required: <group-name> positional arg",
        "Uses group_list + group_contracts + group_query + route_map",
        "Refuses on single-repo scope with a single-line hint",
        "Output: .codehub/groups/<name>/contracts.md with Mermaid"
      ],
      depends: ["l-doc-skill"],
      unblocks: [],
      source: "Promoted P1→P0 on 2026-04-27 · brainstorm 003/006"
    },
    {
      id: "l-hooks",
      title: "PostToolUse staleness hook",
      surface: "laptop", tier: "P0",
      track: "laptop-hooks",
      week: { start: 6, end: 8 },
      tags: ["hook", "freshness"],
      blurb: "After git commit/merge/rebase/pull + auto-reindex, emits a non-blocking systemMessage when graph_hash changed and .docmeta.json exists.",
      why: "Makes freshness free without spending Bedrock credits automatically. Users see the suggestion and opt in when convenient.",
      scope: [
        "plugins/opencodehub/hooks.json extension",
        "Non-blocking systemMessage format",
        "Precondition check: .codehub/docs/.docmeta.json exists"
      ],
      depends: ["l-docmeta"],
      unblocks: [],
      source: "Spec 001 AC-2-7 · brainstorm 006"
    },
    {
      id: "l-discover",
      title: "Discoverability patches",
      surface: "laptop", tier: "P0",
      track: "laptop-skills",
      week: { start: 7, end: 9 },
      tags: ["discovery", "docs"],
      blurb: "opencodehub-guide skills table · analyze-completion hint · verdict/detect_changes next_steps · Starlight /skills/ page.",
      why: "Users in the mental state of just having run codehub analyze are exactly the ones who want docs. Meeting them there is the decisive surface.",
      scope: [
        "opencodehub-guide skills table",
        "packages/cli/src/commands/analyze.ts completion hint",
        "packages/mcp/src/next-step-hints.ts adds codehub-pr-description suggestion",
        "Starlight /skills/ page rendering frontmatter as cards"
      ],
      depends: ["l-doc-skill", "l-pr-desc", "l-onboarding", "l-contract-map"],
      unblocks: [],
      source: "Spec 001 AC-7-* · brainstorm 003"
    },

    /* ───────── Laptop · P1 / P2 ───────── */
    {
      id: "l-adr",
      title: "codehub-adr skill",
      surface: "laptop", tier: "P1",
      track: "laptop-skills",
      tags: ["skill", "adr"],
      blurb: "Drafts an ADR from a problem statement + impact query. Consequences section grounded in blast-radius data.",
      why: "Impact-grounded consequences differentiate from generic ADR templates. Deferred because the template market is crowded; revisit once the P0 family has adoption.",
      scope: [
        "plugins/opencodehub/skills/codehub-adr/",
        "Required: \"<problem>\" positional arg",
        "Defaults to committed (docs/adr/NNNN-<slug>.md)"
      ],
      depends: [],
      unblocks: [],
      source: "Brainstorm 003"
    },
    {
      id: "l-doc-auto",
      title: "codehub-document --group --auto on merge",
      surface: "laptop", tier: "P2",
      track: "laptop-hooks",
      tags: ["auto-refresh"],
      blurb: "PostToolUse hook auto-runs --refresh on merge-to-main for group members. Crosses into CI territory.",
      why: "Docs that track code without human gesture. Deferred because Bedrock-credit cost makes auto-regeneration a user-consent issue.",
      scope: [
        "plugins/opencodehub/hooks.json extension",
        "Merge-to-main detection",
        "Customer opt-in flag"
      ],
      depends: ["l-hooks"],
      unblocks: [],
      source: "Brainstorm 013 P2 list"
    },

    /* ───────── Runner · OSS Actions · deferred tier ─────────
     * All runner items wrap the `codehub` CLI. No HTTP MCP, no agent SDK —
     * the action is a thin Node/container shell that shells out to the CLI.
     * Tier kept at P1/P2 because the laptop surface is the only priority now.
     */
    {
      id: "r-token-action",
      title: "opencodehub/token-action@v1 (OIDC→JWT)",
      surface: "runner", tier: "P1",
      track: "runner-actions",
      tags: ["action", "oidc", "auth"],
      blurb: "Exchanges GitHub OIDC token for a short-lived signed JWT the customer's own verification key signs. Only needed if analyze/verdict actions mint presigned URLs.",
      why: "Cleans up the credential story when actions need to read/write storage. Only worth shipping once the analyze+verdict pair has adoption.",
      scope: [
        "packages/actions/token/action.yml + dist/",
        "OIDC → JWT exchange against customer-operated issuer",
        "15-min TTL, RS256 default"
      ],
      depends: [],
      unblocks: ["r-analyze-action", "r-verdict-action"],
      source: "Brainstorm 011/013 (scope reduced — no HTTP endpoint to authenticate against; JWT used for storage presign only)"
    },
    {
      id: "r-analyze-action",
      title: "opencodehub/analyze-action@v1 (CLI wrapper)",
      surface: "runner", tier: "P1",
      track: "runner-actions",
      tags: ["action", "indexing", "cli-wrapper"],
      blurb: "Runs codehub analyze on the checkout and uploads the graph blob to the configured storage backend. CLI-under-the-hood; no HTTP, no SDK.",
      why: "Makes indexing a CI concern. Needed once customers want verdict gates in their pipeline — without it every verdict run re-indexes from scratch.",
      scope: [
        "packages/actions/analyze/action.yml + dist/",
        "storage-backend input: actions-cache | s3 | r2 | minio",
        "Outputs: graph-hash, graph-uri, cache_hit",
        "Thin shell that execs `codehub analyze` + uploads output"
      ],
      depends: ["r-token-action", "r-storage-tier0"],
      unblocks: ["r-verdict-action"],
      source: "Brainstorm 011 §1 (HTTP MCP removed)"
    },
    {
      id: "r-verdict-action",
      title: "opencodehub/verdict-action@v1 (CLI wrapper)",
      surface: "runner", tier: "P1",
      track: "runner-actions",
      tags: ["action", "checks", "cli-wrapper"],
      blurb: "Runs `codehub verdict --policy opencodehub.policy.yaml` and posts a GitHub Check with per-rule annotations. Applies auto-approve label on full pass.",
      why: "The CI surface that replaces LGTM-as-reflex with deterministic, auditable merge gating. Humans review only what the policy flags. CLI under the hood — no HTTP call, no SDK install.",
      scope: [
        "packages/actions/verdict/action.yml + dist/",
        "Shells out to `codehub verdict --policy ...`",
        "Posts GitHub Check 'OpenCodeHub / verdict'",
        "Applies opencodehub:auto-approve label when outcome=pass && auto_approve=true"
      ],
      depends: ["r-analyze-action", "r-policy-cli"],
      unblocks: [],
      source: "Brainstorm 011 §2 (HTTP MCP + grounding_pack removed)"
    },
    {
      id: "r-policy-schema",
      title: "opencodehub.policy.yaml schema v1",
      surface: "runner", tier: "P1",
      track: "runner-policy",
      tags: ["schema", "yaml"],
      blurb: "JSON Schema for four rule types. Constrained YAML that compiles to a curated cypher subset run by the codehub CLI. Raw cypher explicitly out of scope.",
      why: "Policy-as-code is the moat even without HTTP MCP. The schema choices (what counts as auto-approve, what reviewers see) compound over deployments.",
      scope: [
        "packages/policy/schemas/policy-v1.json",
        "Four rule types with input schemas (blast_radius_max, license_allowlist, ownership_required, arch_invariants)",
        "auto_approve.require gate"
      ],
      depends: [],
      unblocks: ["r-policy-cli"],
      source: "Brainstorm 009 (HTTP-side tooling removed)"
    },
    {
      id: "r-policy-cli",
      title: "codehub verdict CLI (policy evaluator)",
      surface: "runner", tier: "P1",
      track: "runner-policy",
      tags: ["cli", "policy", "determinism"],
      blurb: "New CLI subcommand: `codehub verdict --policy file.yaml --pr <ref>`. Consumes the policy schema, compiles rules against the graph, emits structured verdict JSON.",
      why: "With HTTP MCP off the table, policy evaluation lives in the CLI. Same deterministic guarantees (byte-identical on unchanged inputs) — different consumer shape (actions shell out instead of calling a server).",
      scope: [
        "packages/policy/src/evaluator.ts (CLI-side)",
        "Rule types v1: blast_radius_max, license_allowlist, ownership_required",
        "arch_invariants scaffolded behind OPENCODEHUB_EXPERIMENTAL_ARCH_INVARIANTS",
        "Command: codehub verdict --policy file.yaml --pr base..head"
      ],
      depends: ["r-policy-schema"],
      unblocks: ["r-verdict-action"],
      source: "Brainstorm 009 refactored to CLI"
    },
    {
      id: "r-arch-invariants",
      title: "arch_invariants rule evaluation",
      surface: "runner", tier: "P2",
      track: "runner-policy",
      tags: ["policy", "feature-flag"],
      blurb: "Flip OPENCODEHUB_EXPERIMENTAL_ARCH_INVARIANTS=1 by default. Constrained YAML compiles to curated cypher subset.",
      why: "Scaffolded in v1 schema to reserve the slot; P2 flips the flag once we have field data from design partners on safe cypher patterns.",
      scope: [
        "packages/policy/src/rules/arch-invariants.ts",
        "Cypher subset whitelist",
        "Query timeout + result-size caps"
      ],
      depends: ["r-policy-cli"],
      unblocks: [],
      source: "Brainstorm 013 tension #3"
    },
    {
      id: "r-storage-tier0",
      title: "Graph storage · Tier 0 (Actions Cache)",
      surface: "runner", tier: "P1",
      track: "runner-storage",
      tags: ["storage", "zero-setup"],
      blurb: "GitHub Actions Cache backend via actions/cache@v4. graph_hash-derived key. 10 GB per-repo quota. Zero customer infra.",
      why: "Without caching the story collapses — every CI run re-indexing a large monorepo is unworkable. Tier 0 is the on-ramp for the analyze+verdict action pair.",
      scope: [
        "packages/graph-store/src/backends/actions-cache.ts",
        "Integrates with actions/cache@v4 directly in the workflow",
        "Content-addressed key format: opencodehub:{repo}:{graph_hash}"
      ],
      depends: [],
      unblocks: ["r-analyze-action", "r-verdict-action"],
      source: "Brainstorm 013 tension #2"
    },
    {
      id: "r-storage-tier1",
      title: "Graph storage · Tier 1 (customer S3/R2/MinIO)",
      surface: "runner", tier: "P2",
      track: "runner-storage",
      tags: ["storage", "self-hosted"],
      blurb: "Customer supplies bucket + optional KMS. Signed URLs minted by the customer's own CI host step. Runner never sees raw creds.",
      why: "Growth-stage customers outgrow Actions Cache quotas. Self-hosted bucket is the upgrade path — still no OpenCodeHub-operated infrastructure.",
      scope: [
        "packages/graph-store/src/backends/s3.ts",
        "KMS/CMK binding support",
        "Presigned-URL minting runs in the customer's CI, not via an OpenCodeHub HTTP service"
      ],
      depends: ["r-storage-tier0"],
      unblocks: [],
      source: "Brainstorm 013 tension #2"
    },
    {
      id: "r-gitlab",
      title: "GitLab CI templates",
      surface: "runner", tier: "P2",
      track: "runner-actions",
      tags: ["gitlab", "ci"],
      blurb: "Mirror of the GitHub Actions as GitLab CI templates. Same semantics, same CLI-wrapping shape.",
      why: "Drops reliance on GitHub as the only supported forge. Composition with the customer's existing GitLab runners.",
      scope: [
        "packages/cli/src/ci-templates/gitlab/analyze.yml",
        "packages/cli/src/ci-templates/gitlab/verdict.yml"
      ],
      depends: ["r-analyze-action", "r-verdict-action"],
      unblocks: [],
      source: "Brainstorm 011 §Self-hosted-runner considerations"
    },
    {
      id: "r-provenance-cli",
      title: "codehub provenance CLI + .opencodehub/grounding.json",
      surface: "runner", tier: "P2",
      track: "runner-provenance",
      tags: ["cli", "manifest", "audit"],
      blurb: "CLI subcommand writes a signed JSON manifest with graph_hash, tools_called[], policy_result, agent_identity. No SDK — the agent or workflow calls the CLI.",
      why: "Incident forensics become possible. The agent-SDK path is closed, so provenance is recorded by invoking `codehub provenance record` at the end of an agent turn (or as a CI step).",
      scope: [
        "New subcommand: codehub provenance record",
        ".opencodehub/grounding.json JSON Schema",
        "Verification step inside verdict-action"
      ],
      depends: ["r-verdict-action"],
      unblocks: ["r-sigstore-prov"],
      source: "Brainstorm 007 Action F (reshaped from SDK to CLI)"
    },
    {
      id: "r-sigstore-prov",
      title: "Sigstore-signed provenance",
      surface: "runner", tier: "P2",
      track: "runner-provenance",
      tags: ["sigstore", "slsa", "signing"],
      blurb: "OIDC → Fulcio → Rekor signing with agent-identity as the attestation subject. Closes the audit loop.",
      why: "Competitive research: nobody signs agent output. SLSA attests builds; we attest the agent that authored. Compliance-tier moat.",
      scope: [
        "codehub provenance sign subcommand",
        "verdict-action verifies signatures",
        "in-toto predicate for agent identity"
      ],
      depends: ["r-provenance-cli"],
      unblocks: [],
      source: "Brainstorm 012 §3 seam 6 / 013 P2 list"
    },
    {
      id: "r-self-gh-app",
      title: "Customer-self-hosted GitHub App",
      surface: "runner", tier: "P2",
      track: "runner-actions",
      tags: ["github-app", "self-hosted"],
      blurb: "Webhook subscriber customers deploy on their own infra. Native Checks + PR comments without editing workflows.",
      why: "Zero-config onboarding for orgs that already operate GitHub Apps. Critically — runs on the customer's infrastructure, never OpenCodeHub's.",
      scope: [
        "packages/github-app/ — deployable container",
        "Install flow docs for customer-hosted deployment",
        "No OpenCodeHub-operated endpoint",
        "App itself shells out to the codehub CLI"
      ],
      depends: ["r-verdict-action"],
      unblocks: [],
      source: "Brainstorm 013 P2 list"
    },
    {
      id: "r-federation",
      title: "Cross-org policy federation (git-based)",
      surface: "runner", tier: "P2",
      track: "runner-policy",
      tags: ["policy", "federation", "self-hosted"],
      blurb: "Mechanism for policies shared across related orgs without a central registry. Git-based federation via customer-controlled mirrors.",
      why: "Orgs with multi-subsidiary or open-source-consortium topologies. Self-hosted substrate: policy files flow through customer-controlled git mirrors.",
      scope: [
        "packages/policy/src/federation/",
        "Git-based policy inheritance",
        "No central registry, no OpenCodeHub-operated service"
      ],
      depends: ["r-policy-cli"],
      unblocks: [],
      source: "Brainstorm 013 P2 list"
    },

    /* ───────── Never · explicit exclusions ───────── */
    {
      id: "x-saas",
      title: "Hosted · Managed · SaaS · OpenCodeHub-operated tier",
      surface: "laptop", tier: "never",
      track: "never",
      tags: ["distribution-model", "self-hosted-oss"],
      blurb: "OpenCodeHub is self-hosted OSS. No hosted service, no managed SaaS, no OpenCodeHub-operated infrastructure. Ever.",
      why: "Durable product-distribution decision, stated 2026-04-27. Not a timeline call. Every surface is customer-deployable.",
      scope: [
        "No OpenCodeHub-operated webhook receiver",
        "No hosted graph store",
        "No managed policy evaluator",
        "No SaaS tier"
      ],
      depends: [],
      unblocks: [],
      source: "User directive / project memory / spec 002 scope block"
    },
    {
      id: "x-http-mcp",
      title: "Remote / HTTP MCP server",
      surface: "runner", tier: "never",
      track: "never",
      tags: ["scope-exclusion", "stdio-only"],
      blurb: "No Streamable HTTP MCP, no `/mcp` endpoint, no remote MCP transport. MCP stays stdio-only for the Claude Code plugin on the laptop.",
      why: "Scope decision 2026-04-27. The agent-framework-plays-nice-with-HTTP-MCP story is deprioritized. CI integrations happen via OSS GitHub Actions that shell out to the codehub CLI, not via remote MCP.",
      scope: [
        "No packages/mcp-http/",
        "No OAuth/JWT flow for remote MCP callers",
        "No SSE or Streamable-HTTP transport"
      ],
      depends: [],
      unblocks: [],
      source: "User directive 2026-04-27"
    },
    {
      id: "x-agent-sdk",
      title: "Agent SDK (Python / TypeScript)",
      surface: "runner", tier: "never",
      track: "never",
      tags: ["scope-exclusion", "cli-only"],
      blurb: "No @opencodehub/agent-sdk, no opencodehub_agent_sdk Python, no @opencodehub/claude-hooks, no Vercel AI SDK or LangGraph adapters.",
      why: "Scope decision 2026-04-27. Without HTTP MCP, an agent SDK has nothing to call. Agent frameworks that want OpenCodeHub grounding can shell out to the codehub CLI directly or use the Claude Code stdio MCP.",
      scope: [
        "No packages/agent-sdk-python/",
        "No packages/agent-sdk-ts/",
        "No packages/claude-hooks/",
        "No framework adapters"
      ],
      depends: [],
      unblocks: [],
      source: "User directive 2026-04-27"
    },
    {
      id: "x-agent",
      title: "OpenCodeHub-branded coding agent",
      surface: "runner", tier: "never",
      track: "never",
      tags: ["no-compete", "composability"],
      blurb: "We don't compete with Devin, Claude-for-GitHub, Amazon Q, Cursor, Copilot. We provide the graph; they use it (via Claude Code plugin or CLI).",
      why: "Composability wins against consolidation when the primitive is hard and the runtime is easy.",
      scope: [],
      depends: [],
      unblocks: [],
      source: "Brainstorm 007 §4 / 013 exclusions"
    },
    {
      id: "x-llm-review",
      title: "LLM-based PR review",
      surface: "runner", tier: "never",
      track: "never",
      tags: ["no-compete"],
      blurb: "We don't compete with CodeRabbit / Greptile / Diamond on LLM verdict quality. We compete on deterministic verdict quality.",
      why: "Deterministic graph verdict + graphHash invariant is the auditability wedge. LLM review is a crowded market with no moat.",
      scope: [],
      depends: [],
      unblocks: [],
      source: "Brainstorm 012 §3 seam 1 / 013 exclusions"
    },
    {
      id: "x-ide",
      title: "IDE plugin / LSP",
      surface: "laptop", tier: "never",
      track: "never",
      tags: ["no-compete"],
      blurb: "Three surfaces are enough: Claude Code plugin, OSS GitHub Action, GitLab template.",
      why: "LSPs and IDE plugins are Sourcegraph/Copilot territory. Our distribution channel is Claude Code and CI, not IDEs.",
      scope: [],
      depends: [],
      unblocks: [],
      source: "Brainstorm 007 §4 / 013 exclusions"
    },
    {
      id: "x-fine-tune",
      title: "Fine-tuned models",
      surface: "runner", tier: "never",
      track: "never",
      tags: ["no-compete"],
      blurb: "Model choice stays with the agent platform. We are model-neutral grounding, not a model-provider.",
      why: "Picking a model forfeits the neutrality that makes every agent vendor a distribution partner.",
      scope: [],
      depends: [],
      unblocks: [],
      source: "Brainstorm 007 §4 / 013 exclusions"
    }
  ],

  // Named tracks for the Timeline view
  tracks: [
    { id: "laptop-substrate", label: "Laptop · substrate", surface: "laptop" },
    { id: "laptop-skills", label: "Laptop · skills", surface: "laptop" },
    { id: "laptop-hooks", label: "Laptop · hooks", surface: "laptop" },
    { id: "runner-policy", label: "Runner · policy (CLI)", surface: "runner" },
    { id: "runner-actions", label: "Runner · actions (CLI-wrap)", surface: "runner" },
    { id: "runner-storage", label: "Runner · storage", surface: "runner" },
    { id: "runner-provenance", label: "Runner · provenance", surface: "runner" }
  ]
};
