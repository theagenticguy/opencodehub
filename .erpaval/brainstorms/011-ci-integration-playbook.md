# 011 — CI/CD Integration Playbook

*Draft: 2026-04-27. Inputs: 009 (remote MCP surface + both actions), 010 (agent SDK). This memo is copy-pasteable: an org drops these three workflows into `.github/workflows/` and they have the grounding plane wired to PRs and main-branch pushes.*

The playbook assumes the two actions from 009 are published (`opencodehub/analyze-action@v1`, `opencodehub/verdict-action@v1`) and the GitHub App is installed. Per 001 § "offline-safe by SPECS.md" and 009 §5, the storage backend is user-selectable so air-gapped orgs can pin to on-prem object storage.

## Workflow 1 — `opencodehub-analyze.yml`

Builds the graph on every push to default and every PR sync. Concurrency grouped per ref so the latest commit wins.

```yaml
# .github/workflows/opencodehub-analyze.yml
name: opencodehub-analyze
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened]
concurrency:
  group: codehub-analyze-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
  id-token: write              # for OIDC → JWT exchange
jobs:
  analyze:
    runs-on: ubuntu-latest
    outputs:
      graph-url:  ${{ steps.ch.outputs.graph-url }}
      graph-hash: ${{ steps.ch.outputs.graph-hash }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }       # full history for detect_changes
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - id: ch
        uses: opencodehub/analyze-action@v1
        with:
          storage-backend: s3
          bucket:          ${{ vars.CODEHUB_BUCKET }}
          prefix:          graphs/${{ github.repository }}
      - name: Annotate
        run: echo "graph_hash=${{ steps.ch.outputs.graph-hash }}" >> "$GITHUB_STEP_SUMMARY"
```

Runtime on a typical 200k-LOC TypeScript monorepo is 2-4 minutes cold, <90 s on warm incremental (the phase DAG in `packages/ingestion/` skips unchanged files). The graph is keyed in storage by `{repo, sha}` so downstream jobs look it up by commit.

## Workflow 2 — `opencodehub-verdict.yml`

Runs `policy_evaluate`, posts a GitHub Check, labels the PR with the verdict tier.

```yaml
# .github/workflows/opencodehub-verdict.yml
name: opencodehub-verdict
on:
  pull_request:
    types: [opened, synchronize, reopened]
concurrency:
  group: codehub-verdict-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: write
  checks: write
  issues: write
  id-token: write
jobs:
  verdict:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Resolve graph URL for PR head
        id: resolve
        env:
          REPO: ${{ github.repository }}
          SHA:  ${{ github.event.pull_request.head.sha }}
        run: |
          url="s3://${{ vars.CODEHUB_BUCKET }}/graphs/${REPO}/${SHA}.duckdb"
          if ! aws s3 ls "$url" > /dev/null; then
            echo "miss=true" >> "$GITHUB_OUTPUT"
          else
            echo "miss=false" >> "$GITHUB_OUTPUT"
            echo "url=$url"   >> "$GITHUB_OUTPUT"
          fi
      - name: Force re-analyze on cache miss
        if: steps.resolve.outputs.miss == 'true'
        id: reanalyze
        uses: opencodehub/analyze-action@v1
        with:
          storage-backend: s3
          bucket:          ${{ vars.CODEHUB_BUCKET }}
          prefix:          graphs/${{ github.repository }}
      - name: Mint OpenCodeHub JWT
        id: token
        uses: opencodehub/token-action@v1
        with:
          endpoint: https://auth.opencodehub.dev
      - id: v
        uses: opencodehub/verdict-action@v1
        with:
          graph-url:   ${{ steps.resolve.outputs.url || steps.reanalyze.outputs.graph-url }}
          pr-ref:      ${{ github.event.pull_request.base.ref }}..${{ github.event.pull_request.head.ref }}
          policy-path: opencodehub.policy.yaml
          token:       ${{ steps.token.outputs.jwt }}
      - name: Label PR
        uses: actions/github-script@v7
        env:
          VERDICT: ${{ steps.v.outputs.verdict }}
          TIER:    ${{ steps.v.outputs.tier }}
        with:
          script: |
            const labels = [`codehub/verdict:${process.env.VERDICT}`, `codehub/tier:${process.env.TIER}`];
            await github.rest.issues.addLabels({
              ...context.repo, issue_number: context.payload.pull_request.number, labels,
            });
```

Timing target: <30 s p50 from PR synchronize to posted check, assuming warm cache and a policy with 5-10 rules. The `policy_evaluate` tool parallelizes rule execution server-side.

## Workflow 3 — `opencodehub-auto-merge.yml`

Consumes verdict-action's `auto-approve-eligible` output, checks required reviewers are satisfied, enables auto-merge through the GitHub CLI.

```yaml
# .github/workflows/opencodehub-auto-merge.yml
name: opencodehub-auto-merge
on:
  pull_request_review:
    types: [submitted]
  check_run:
    types: [completed]
permissions:
  pull-requests: write
  contents: write
  checks: read
jobs:
  maybe-auto-merge:
    runs-on: ubuntu-latest
    if: github.event.check_run.name == 'opencodehub/verdict' || github.event_name == 'pull_request_review'
    steps:
      - uses: actions/checkout@v4
      - name: Read verdict from check
        id: read
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: |
          pr=$(gh pr list --head "${{ github.event.pull_request.head.ref }}" --json number -q '.[0].number')
          eligible=$(gh pr checks "$pr" --json name,summary -q \
            '.[] | select(.name=="opencodehub/verdict") | .summary' \
            | jq -r '.auto_approve_eligible')
          echo "eligible=$eligible" >> "$GITHUB_OUTPUT"
          echo "pr=$pr"             >> "$GITHUB_OUTPUT"
      - name: Enable auto-merge
        if: steps.read.outputs.eligible == 'true' && !contains(github.event.pull_request.labels.*.name, 'codehub/hold')
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: |
          gh pr merge --auto --squash "${{ steps.read.outputs.pr }}"
          gh pr edit "${{ steps.read.outputs.pr }}" --add-label auto-merge
```

**Human overrides.** Two escape hatches: `codehub/hold` label blocks auto-merge for that PR; `opencodehub.policy.yaml#auto_approve.require` can be edited to raise the bar globally. A `gh pr edit --remove-label auto-merge` immediately cancels a pending auto-merge.

## Group mode — monorepo with declared groups

Per 006 § group-mode and 001 "group contracts are the moat", orgs with `group_list` declarations fan analyze per repo and run one consolidated verdict.

```yaml
# .github/workflows/opencodehub-group-verdict.yml
name: opencodehub-group-verdict
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  discover:
    runs-on: ubuntu-latest
    outputs: { repos: ${{ steps.l.outputs.repos }} }
    steps:
      - uses: actions/checkout@v4
      - id: l
        run: echo "repos=$(cat opencodehub.group.yaml | yq -o=json '.repos')" >> "$GITHUB_OUTPUT"
  analyze:
    needs: discover
    runs-on: ubuntu-latest
    strategy:
      matrix: { repo: ${{ fromJSON(needs.discover.outputs.repos) }} }
    steps:
      - uses: actions/checkout@v4
        with: { repository: ${{ matrix.repo }}, path: repos/${{ matrix.repo }} }
      - uses: opencodehub/analyze-action@v1
        with: { repo-path: repos/${{ matrix.repo }}, storage-backend: s3,
                bucket: ${{ vars.CODEHUB_BUCKET }} }
  verdict:
    needs: analyze
    runs-on: ubuntu-latest
    steps:
      - uses: opencodehub/verdict-action@v1
        with:
          graph-url:   group://${{ vars.CODEHUB_BUCKET }}/${{ github.event.pull_request.head.sha }}
          pr-ref:      ${{ github.event.pull_request.base.ref }}..${{ github.event.pull_request.head.ref }}
          policy-path: opencodehub.group.policy.yaml
          token:       ${{ steps.token.outputs.jwt }}
```

The `group://` URL scheme tells the server to load all member-repo graphs and run `group_contracts` rules (see 009 §4 — `arch_invariant` rules can name `MATCH` patterns that cross repo boundaries). This is the one rule class impossible on a single-repo tool.

## Self-hosted runner considerations

- **Storage.** GitHub Artifacts caps at 500 MB per artifact and 90-day retention, which saturates on repos above ~1 M LOC once you add multiple SHAs. Recommend MinIO or Cloudflare R2 for any org with more than 20 active repos. S3 Intelligent-Tiering handles cold graphs cheaply.
- **JWT minting.** The OpenCodeHub GitHub App lives in the org. On-prem orgs either (a) run the auth service themselves — `packages/mcp-http/src/auth.ts` exports a standalone `opencodehub-auth` binary — or (b) mint JWTs from their existing IdP with the `codehub:*` claim scope that the server verifies.
- **Air-gap pattern.** Point the action at the on-prem endpoint via `with: endpoint: https://codehub.internal.corp`. The action image bundles no code that reaches out to opencodehub.dev; all telemetry defaults are off. The storage backend can be a local mount on the self-hosted runner: `storage-backend: local` with `prefix: /srv/codehub/graphs`.

## Failure modes and fallbacks

| Failure                                     | Behavior                                                                 |
|---------------------------------------------|--------------------------------------------------------------------------|
| Graph not in cache for PR head SHA          | `verdict.yml` runs `analyze-action` inline before evaluating (step shown) |
| `policy_evaluate` exceeds action timeout    | Action exits with `verdict=needs-review` (not `fail`) + posts a warning  |
| `opencodehub.policy.yaml` has invalid YAML  | Action fails loud with `line: N, col: M, msg: …`; does not post a check  |
| MCP-HTTP endpoint 5xx                       | SDK retries with exponential backoff (3 tries, 250/500/1000 ms)          |
| Graph hash drift mid-session (agent mode)   | `GraphDriftError` per 010; agent re-grounds or sets `strict=False`       |
| GitHub App lost install permissions         | Token action fails with a clear message to reinstall the app             |

Loud failure on policy syntax is deliberate — a silent drop would let a misconfigured gate look like a pass. Timeout → `needs-review` is also deliberate: blocking merges on transient MCP unavailability punishes the user for our infrastructure.

## Observability

- Every `policy_evaluate` call emits a structured log line to stdout:
  `{ "ts": "...", "install": "...", "repo": "...", "pr_ref": "...", "graph_hash": "...", "overall": "pass", "duration_ms": 1840, "rules": [{ "id": "...", "outcome": "..." }] }`.
- Optional Prometheus push: `verdict-action` honors `OPENCODEHUB_METRICS_URL`, posts counters per outcome and histograms per rule. Empty env var = no network egress.
- The `.opencodehub/grounding.json` manifest per PR is the durable audit surface — every `gh pr view` can link to it, and the schema in 009 §7 makes post-incident forensics concrete.

---

This playbook closes the trilogy. 009 defines the surface, 010 defines the SDK, 011 wires both into CI. A Day-1 adopter commits `opencodehub.policy.yaml`, pastes the three workflows, installs the App, and has grounding + verdicts running within an hour.
