# 009 — Agent-Grounding Plane: Remote API, CI Integrations, Policy Schema

*Draft: 2026-04-27. Inputs: 001 Strategy kernel, 002 PRD, 003–005 Design, 006 Synthesis (artifact plane). This memo extends OpenCodeHub past the laptop and into CI — the off-desktop surface that grounds any agent in any pipeline.*

Prior brainstorms locked the **artifact plane** (single-repo Markdown-factory skills on Claude Code). 006 closed that thread and called out four P1 items, including "CI workflow that runs `--refresh` on push-to-main". This memo designs the **grounding plane**: the HTTP MCP surface, two new agent-facing tools, a policy-verdict DSL, and the two GitHub Actions that stitch them together.

The wedge is the same — **graph-aware retrieval + blast-radius + group contracts** — but the consumer shifts from Claude Code to any agent (Claude Agent SDK, Vercel AI SDK, LangGraph, bespoke OpenAI loops) running inside CI or a remote runtime. The artifact plane writes Markdown *to* a repo; the grounding plane feeds *graph evidence* to whatever agent is editing the repo, then emits a verdict the pipeline can enforce.

## Section 1 — MCP-over-HTTP server: `packages/mcp-http/`

`packages/mcp/` is stdio-only today — 28 tools, single process per repo. The remote form is a new sibling package that reuses the tool registry verbatim and swaps the transport.

**Transport.** *Assumption: the current Anthropic MCP spec names the remote transport "Streamable HTTP" and provides `NodeStreamableHTTPServerTransport` in `@modelcontextprotocol/sdk`. That matches the docs I verified against the SDK's llms.txt on 2026-04-27.* We implement Streamable HTTP as the primary surface and keep SSE as a compatibility fallback for clients older than spec revision 2025-03-26.

**Entrypoint.** `packages/mcp-http/src/server.ts` runs an Express app with a single POST `/mcp` route plus `/healthz` and `/.well-known/oauth-protected-resource`. Bearer auth is enforced at middleware level before the transport touches the request body.

```typescript
// packages/mcp-http/src/server.ts (sketch, ~30 lines)
import express from "express";
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer, isInitializeRequest } from "@modelcontextprotocol/server";
import { registerAllTools } from "@opencodehub/mcp/registry";
import { authMiddleware, AuthedRequest } from "./auth.js";
import { rateLimit } from "./rate-limit.js";
import { GraphCache } from "./graph-cache.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/mcp", authMiddleware, rateLimit);
const cache = new GraphCache({ maxBytes: 2 * 1024 * 1024 * 1024 });
const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

app.post("/mcp", async (req: AuthedRequest, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (sid && sessions.has(sid)) {
    return sessions.get(sid)!.handleRequest(req, res, req.body);
  }
  if (!isInitializeRequest(req.body)) return res.status(400).json({ error: "missing session" });

  const server = new McpServer({ name: "opencodehub", version: "0.3.0" });
  const graph = await cache.load(req.scope.repo, req.scope.graphHash);
  registerAllTools(server, { graph, scope: req.scope });   // reuses packages/mcp registry

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => sessions.set(id, transport),
  });
  transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(Number(process.env.PORT ?? 8787));
```

**Auth.** Bearer JWT issued by a lightweight service (`packages/mcp-http/src/auth.ts`). Token payload: `{ install_id, repo, group?, pr_ref?, scope: "install" | "group" | "repo", allowlist: string[], exp }`. `allowlist` is the tool-name subset this token may invoke; absent means "all 28+3". Middleware:

```typescript
// packages/mcp-http/src/auth.ts
export async function authMiddleware(req, res, next) {
  const raw = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!raw) return res.status(401).json({ error: "missing bearer" });
  const claims = await verifyJwt(raw, process.env.OPENCODEHUB_JWT_PUBKEY!);
  if (claims.exp * 1000 < Date.now()) return res.status(401).json({ error: "expired" });
  req.scope = {
    installId: claims.install_id, repo: claims.repo, group: claims.group,
    prRef: claims.pr_ref, graphHash: req.headers["x-codehub-graph-hash"],
    allowlist: new Set(claims.allowlist ?? []),
  };
  next();
}
```

The registry wrapper in `registerAllTools` consults `scope.allowlist` per call; unknown tools return a structured `method not allowed` rather than silently dropping.

**Graph connection.** `GraphCache` is keyed by `{repo, graph_hash}`. Miss path: download `graph.duckdb` from the configured backend (S3, R2, GitHub Artifacts, or file://), open it read-only, pin in an LRU. 2 GB ceiling by default; spill to tmpfs above that. Cache-hit latency is the p50 target: sub-150 ms from POST `/mcp` to first tool result on a warm instance.

**Rate limits.** Token-bucket per `install_id` (default 120 rpm, burst 20) and per `repo` (60 rpm). Excess returns HTTP 429 + `Retry-After` seconds. Limits are advertised in `/healthz` for preflight.

**Surface.** All 28 existing tools (`list_repos`, `query`, `context`, `impact`, `detect_changes`, `rename`, `sql`, `owners`, `route_map`, `tool_map`, `list_findings`, `license_audit`, `group_contracts`, `group_query`, `group_status`, `group_sync`, `project_profile`, `verdict`, and the rest) stay byte-identical. Three new tools ship in this package: `grounding_pack`, `policy_evaluate`, `provenance_record`.

## Section 2 — `grounding_pack` tool

Composes the existing retrieval primitives into a single LLM-ready payload. Inputs:

```json
{
  "repo": "github.com/acme/payments-api",
  "task_description": "add rate limiting to the GraphQL mutation handlers",
  "target_files": ["packages/api/src/graphql/mutations.ts"],
  "max_tokens": 8192
}
```

Output (truncated at `max_tokens` by pruning `relevant_symbols` first, then `prior_findings`):

```json
{
  "graph_hash": "sha256:8f3c…",
  "repo_profile": {
    "summary": "Node 22 monorepo, GraphQL API over Postgres, 42 packages.",
    "languages": {"typescript": 0.87, "sql": 0.08, "shell": 0.05},
    "entrypoints": ["packages/api/src/server.ts", "packages/worker/src/main.ts"]
  },
  "relevant_symbols": [
    {"name": "createPayment", "kind": "function",
     "path": "packages/api/src/graphql/mutations.ts", "loc": "L42-L91",
     "summary": "Mutation resolver; calls PaymentService.create; no throttling."},
    {"name": "refundPayment", "kind": "function",
     "path": "packages/api/src/graphql/mutations.ts", "loc": "L93-L140",
     "summary": "Mutation resolver; calls PaymentService.refund."}
  ],
  "blast_radius": {
    "upstream":   [{"symbol": "graphqlServer", "path": "packages/api/src/server.ts"}],
    "downstream": [{"symbol": "PaymentService.create", "path": "packages/core/src/payment.ts"},
                   {"symbol": "metricsEmit",           "path": "packages/obs/src/metrics.ts"}],
    "tier": 2
  },
  "owners":  [{"path": "packages/api/**",  "owners": ["@api-team"]},
              {"path": "packages/core/**", "owners": ["@payments-core"]}],
  "prior_findings": [
    {"rule_id": "no-unbounded-loops", "severity": "warning",
     "path": "packages/api/src/graphql/mutations.ts", "summary": "L67 unbounded forEach over user input."}
  ],
  "group_contracts": null,
  "arch_invariants": [
    {"name": "db-access-only-in-storage", "query": "MATCH (f:Function)-[:CALLS]->(:Module {name:'db'}) …",
     "description": "Only packages/storage/** may touch db directly."}
  ]
}
```

**Internal pipeline.** `grounding_pack` is pure composition over existing tools, no new retrieval:

1. `project_profile({repo})` → `repo_profile`.
2. `query({repo, text: task_description, k: 20})` → candidate symbols, filtered by `target_files` when present.
3. For each top-k symbol: `context({repo, symbol})` for inbound/outbound refs and participating flows.
4. `impact({repo, targets: [...], depth: 2})` → union upstream/downstream; tier from the existing risk tiering in `packages/search`.
5. `owners({repo, paths: [...]})` → owners table.
6. `list_findings({repo, paths: [...]})` → `prior_findings`.
7. If token scope includes a group: `group_contracts({group, repo})` → `group_contracts`.
8. Read `opencodehub.policy.yaml#arch_invariants` entries verbatim → `arch_invariants`.

`graph_hash` is stamped at step 1 and carried through; drift during the session surfaces as an SDK-side refusal (see 010).

## Section 3 — `policy_evaluate` tool

Inputs: `{repo, pr_ref: "base..head", policy_path?: "opencodehub.policy.yaml"}`.

Output:

```json
{
  "graph_hash": "sha256:8f3c…",
  "pr_ref": "main..feat/rate-limit",
  "overall": "needs-review",
  "rules": [
    {"id": "no-direct-db-access", "type": "arch_invariant", "outcome": "pass",
     "evidence": {"matched_rows": 0}, "blocked_merge": false},
    {"id": "disallow-gpl", "type": "license", "outcome": "pass",
     "evidence": {"new_deps": []}, "blocked_merge": false},
    {"id": "blast-radius-tier", "type": "blast_radius", "outcome": "fail",
     "evidence": {"tier": 1, "touched": ["packages/core/src/payment.ts"]},
     "blocked_merge": true},
    {"id": "require-owner-approval", "type": "ownership", "outcome": "needs-review",
     "evidence": {"paths": ["packages/storage/**"], "required": ["@storage-team"]},
     "blocked_merge": false}
  ],
  "auto_approve": false,
  "required_reviewers": ["@storage-team"]
}
```

**Overall resolution.** Any `fail` with `blocked_merge: true` → `fail`. Else any `needs-review` or `fail` → `needs-review`. Else `pass`. `auto_approve` is `overall === "pass"` AND the policy's `auto_approve.require` clauses all match.

**Compilation.** The policy YAML is parsed once per call, each rule compiled to a tool call:

| rule `type`      | compiles to                                                                 |
|------------------|-----------------------------------------------------------------------------|
| `arch_invariant` | `sql` tool with rule's Cypher-over-DuckDB query, row count ≥ 1 ⇒ fail       |
| `license`        | `license_audit({repo, pr_ref})` filtered by `deny` list                     |
| `ownership`      | `owners({repo, paths})` × `detect_changes({pr_ref})` intersection           |
| `blast_radius`   | `detect_changes` → `impact(depth=2)` → tier compared against threshold      |

## Section 4 — `opencodehub.policy.yaml` schema

Committed to the repo root (or group root for monorepos). Realistic example:

```yaml
version: 1
auto_approve:
  require:
    - blast_radius.tier: ">= 3"       # tier 1 = highest risk, 5 = lowest
    - license_audit.violations: 0
    - findings.severity_critical: 0
rules:
  - id: no-direct-db-access
    type: arch_invariant
    severity: error
    query: |
      MATCH (n:Function)-[:CALLS]->(db:Module {name:'db'})
      WHERE NOT n.path STARTS WITH 'packages/storage/'
      RETURN n.path, n.name
  - id: disallow-gpl
    type: license
    severity: error
    deny: ["GPL-3.0", "AGPL-3.0", "SSPL-1.0"]
  - id: require-owner-approval
    type: ownership
    severity: warning
    paths: ["packages/storage/**", "packages/core/src/payment.ts"]
    require_approval_from: ["@storage-team", "@payments-core"]
  - id: blast-radius-tier
    type: blast_radius
    severity: error
    max_tier: 2                        # fail if touched symbols land at tier 1 or 2
    depth: 2
```

**Rule-type reference.**

- **`arch_invariant`.** Input: `query` (Cypher-over-DuckDB string), optional `allow_rows: int`. Compiles to `sql({repo, query, readonly: true})`. Pass when `rows.length <= allow_rows` (default 0).
- **`license`.** Input: `deny: string[]` (SPDX ids), optional `allow: string[]`. Compiles to `license_audit({repo, pr_ref})`, filter `.violations[].spdx ∈ deny`. Pass when filtered length is 0.
- **`ownership`.** Input: `paths: glob[]`, `require_approval_from: string[]`. Compiles to `owners({repo, paths})` intersected with `detect_changes({pr_ref})` file set. Pass when no intersection; `needs-review` when intersection is non-empty (verdict-action posts the required-reviewers list as a PR comment).
- **`blast_radius`.** Input: `max_tier: 1..5`, `depth: int` (default 2). Compiles to `detect_changes({pr_ref})` → `impact({targets, depth})` → worst tier across touched symbols. Pass when `tier > max_tier` (higher tier = lower risk in OpenCodeHub's convention).

## Section 5 — `opencodehub/analyze-action@v1`

```yaml
# action.yml
name: OpenCodeHub Analyze
description: Build a code graph and publish it to a storage backend.
inputs:
  repo-path:        { description: "Path to checkout",       required: false, default: "." }
  storage-backend:  { description: "s3 | r2 | artifact | local", required: true }
  bucket:           { description: "Bucket (s3/r2)",         required: false }
  prefix:           { description: "Key prefix",             required: false, default: "codehub" }
  codehub-version:  { description: "npm tag",                required: false, default: "latest" }
outputs:
  graph-hash:       { description: "sha256 of graph.duckdb" }
  graph-url:        { description: "Backend-resolvable URL or artifact id" }
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with: { node-version: "22" }
    - name: Install codehub
      shell: bash
      run: npm i -g @opencodehub/cli@${{ inputs.codehub-version }}
    - name: Analyze
      shell: bash
      working-directory: ${{ inputs.repo-path }}
      run: codehub analyze --emit-hash
    - name: Publish graph
      id: publish
      shell: bash
      env:
        STORAGE: ${{ inputs.storage-backend }}
        BUCKET:  ${{ inputs.bucket }}
        PREFIX:  ${{ inputs.prefix }}
      run: codehub publish --backend "$STORAGE" --bucket "$BUCKET" --prefix "$PREFIX" --out "$GITHUB_OUTPUT"
```

Workflow usage:

```yaml
jobs:
  analyze:
    runs-on: ubuntu-latest
    outputs:
      graph-url:  ${{ steps.ch.outputs.graph-url }}
      graph-hash: ${{ steps.ch.outputs.graph-hash }}
    steps:
      - uses: actions/checkout@v4
      - id: ch
        uses: opencodehub/analyze-action@v1
        with:
          storage-backend: s3
          bucket: acme-codehub-graphs
```

## Section 6 — `opencodehub/verdict-action@v1`

```yaml
name: OpenCodeHub Verdict
description: Evaluate a policy against a PR and post a GitHub Check.
inputs:
  graph-url:        { required: true }
  pr-ref:           { required: true }
  policy-path:      { required: false, default: "opencodehub.policy.yaml" }
  endpoint:         { required: false, default: "https://mcp.opencodehub.dev" }
  token:            { required: true }
outputs:
  verdict:                 { description: "pass | needs-review | fail" }
  auto-approve-eligible:   { description: "true | false" }
runs:
  using: composite
  steps:
    - name: Fetch graph
      shell: bash
      run: codehub fetch-graph --url "${{ inputs.graph-url }}" --out "$RUNNER_TEMP/graph.duckdb"
    - name: Evaluate
      id: eval
      shell: bash
      env:
        OPENCODEHUB_ENDPOINT: ${{ inputs.endpoint }}
        OPENCODEHUB_TOKEN:    ${{ inputs.token }}
      run: codehub mcp call policy_evaluate
            --repo "$GITHUB_REPOSITORY"
            --pr-ref "${{ inputs.pr-ref }}"
            --policy-path "${{ inputs.policy-path }}"
            --out "$GITHUB_OUTPUT"
    - name: Post Check
      uses: actions/github-script@v7
      with:
        script: |
          const verdict = JSON.parse(process.env.VERDICT_JSON);
          await github.rest.checks.create({
            owner: context.repo.owner, repo: context.repo.repo,
            name: "opencodehub/verdict", head_sha: context.payload.pull_request.head.sha,
            status: "completed",
            conclusion: verdict.overall === "pass" ? "success" : verdict.overall === "fail" ? "failure" : "neutral",
            output: { title: `OpenCodeHub: ${verdict.overall}`, summary: renderMd(verdict) },
          });
```

## Section 7 — Grounding provenance: `.opencodehub/grounding.json`

Committed to the PR branch by the agent (via `provenance_record` tool). One file per PR under `.opencodehub/grounding.json`; `.opencodehub/history/<pr_ref>.json` for historical PRs.

```json
{
  "$schema": "https://opencodehub.dev/schemas/grounding.v1.json",
  "schema_version": 1,
  "agent_identity": {"runtime": "claude-agent-sdk", "model": "claude-opus-4-7", "run_id": "cr_01HXZ…"},
  "graph_hash": "sha256:8f3c…",
  "tools_called": [
    {"name": "grounding_pack", "at": "2026-04-27T14:12:03Z", "input_digest": "sha256:…", "output_digest": "sha256:…"},
    {"name": "impact",         "at": "2026-04-27T14:12:41Z", "input_digest": "sha256:…", "output_digest": "sha256:…"}
  ],
  "policy_result": {"overall": "needs-review", "rules": [ /* as in policy_evaluate output */ ]},
  "generated_at": "2026-04-27T14:13:02Z"
}
```

JSON Schema sketch (`packages/core-types/src/schemas/grounding.v1.json`):

```json
{
  "$id": "https://opencodehub.dev/schemas/grounding.v1.json",
  "type": "object",
  "required": ["schema_version", "agent_identity", "graph_hash", "tools_called", "generated_at"],
  "properties": {
    "schema_version": {"const": 1},
    "agent_identity": {"type": "object",
      "required": ["runtime", "model"],
      "properties": {"runtime": {"type": "string"}, "model": {"type": "string"}, "run_id": {"type": "string"}}},
    "graph_hash":     {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
    "tools_called":   {"type": "array", "items": {"type": "object",
      "required": ["name", "at", "input_digest", "output_digest"]}},
    "policy_result":  {"type": "object"},
    "generated_at":   {"type": "string", "format": "date-time"}
  }
}
```

Signing is P2 — detached JWS over the canonical JSON, public key resolved from the install's GitHub App. For v1 the manifest is unsigned but content-addressed via the digests, which is sufficient for audit and correlation with CI logs.

---

This closes the public surface. 010 covers the SDK agents drop into their framework; 011 wires the two actions above into a copy-pasteable workflow playbook.
