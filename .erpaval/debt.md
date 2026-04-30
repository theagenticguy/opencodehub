# OpenCodeHub — Wave-plan tech-debt tracker

**Status**: Working document. Gitignored via `.gitignore: .erpaval/`.

This file catalogs every wave/stream code reference that was scrubbed from
the codebase on 2026-04-23 during the clean-room audit. The references were
originally left behind as "TODO when Wave X lands" style hints, and they
encoded actual product state — features deferred, scanner tiers, eval
baselines, rollout priority, etc. The scrub removed the wave labels but
some of the underlying work is still incomplete.

Treat every line here as a candidate backlog ticket. For each: figure out
whether the thing was actually shipped (and the comment was stale), or
whether it's still open (and deserves an issue).

## Legend

- **W1** — W1-CORE (initial MVP shape)
- **W2** — second wave (language coverage, caching, scanner tiers, detectors)
- **W3** — third wave (analysis tools: risk_trends, verdict variants)
- **W4** — fourth wave (bench, doctor, gates)
- **W5** — fifth wave (new tools, eval matrix expansion)

Stream letters appeared on W1 artifacts (Stream E = caching, Stream J =
multi-repo groups, Stream T = suppressions, etc). They're a second axis
orthogonal to the W-code.

## Catalog

### packages/cli — wave hints

- `packages/cli/src/commands/analyze.ts:170` — "Cache-health stats
  (W2-E.4): the parse-cache hit ratio and on-disk" size telemetry. Ships
  the stats; was flagged as W2-E.4 work. **Action:** confirm stats are
  actually populated; add a test if not.
- `packages/cli/src/commands/bench.test.ts:2` and
  `packages/cli/src/commands/doctor.test.ts:2` — "Unit tests for codehub
  bench — W4-G.3" / "doctor — W4-G.3". Both command+test exist; W4-G.3
  is delivered. **Action:** no debt, just a stale label.

### packages/embedder — W2-A.2 (embedder weights downloader)

All 5 files reference "W2-A.2" as the code path that installs ONNX
weights via `codehub setup --embeddings`.

- `packages/embedder/src/index.ts:7`
- `packages/embedder/src/paths.ts:12`
- `packages/embedder/src/model-pins.ts:4`
- `packages/embedder/src/model-pins.ts:40` — `"once from the upstream repo"`
- `packages/embedder/src/model-pins.test.ts:4`
- `packages/embedder/src/onnx-embedder.ts:11`

**Action:** `codehub setup --embeddings` ships in `packages/cli/src/commands/setup.ts`
— feature is done. Labels are stale. No debt.

### packages/eval — MVP + W2-C.* language fixtures + W5-3 new-tool matrix

- `packages/eval/baselines/opencodehub-v1.json:60` — "14 language fixtures
  (MVP 7 + W2-C.2/3/4 additions: c, cpp, ruby, kotlin, swift, php,
  dart)."
- `packages/eval/baselines/opencodehub-v1.json:63` — "risk_trends and
  verdict map to tools still in flight (W3-F.1 / W3-F.2). Cases pass via
  the isError branch with a structured error envelope until the server
  registers the tools."
- `packages/eval/src/opencodehub_eval/agent.py:177` — "W5-3 new tools"
  section delimiter
- `packages/eval/src/opencodehub_eval/agent.py:185` — "are still in
  flight (W3-F.1 / W3-F.2)"
- `packages/eval/src/opencodehub_eval/bench.py:243` — "new = 63 (W5-3
  new-tool matrix)"
- `packages/eval/src/opencodehub_eval/bench.py:269` — "hard-coded 98 (the
  W2-C.5 core target)"
- `packages/eval/src/opencodehub_eval/tests/conftest.py:31` — "14
  language fixtures (7 MVP + 7 W2-C.2/3/4 additions)"
- `packages/eval/src/opencodehub_eval/tests/test_parametrized.py:8,10` —
  "W2-C.5 deliverable", "W5-3 coverage for the nine tools"
- `packages/eval/src/opencodehub_eval/tests/test_parametrized.py:167-175`
  — risk_trends / verdict (W3-F.1/W3-F.2) tool-still-unregistered
  fallback logic
- `packages/eval/src/opencodehub_eval/tests/test_parametrized.py:257` —
  "W5-3 expansion" in the parametrize helper

**Real debt here:**

1. **W3-F.1 / W3-F.2 (risk_trends + verdict):** eval acknowledged these
   as unregistered tools with fallback paths. Search `packages/mcp/src/tools/`
   — if both tools exist and are registered, the fallback branches in
   `test_parametrized.py:167-175` become dead code that can be removed.
   If one is missing, that's a product gap.
2. **W2-C.5 core target = 98.** If the eval baseline now passes a
   different target, update the hard-coded fallback in
   `bench.py:269`.

### packages/ingestion — language registry (W2-C.1) + content cache (Stream E / W2-E.*)

- `packages/ingestion/src/parse/grammar-registry.test.ts:52-53` — loads
  "W2-C.1 grammars" (7 additional: c, cpp, ruby, kotlin, swift, php,
  dart)
- `packages/ingestion/src/parse/grammar-registry.ts:198` — "W2-C.*
  languages whose grammar package is not installed"
- `packages/ingestion/src/parse/language-detector.ts:26` — "W2-C.1
  additions"
- `packages/ingestion/src/pipeline/phases/content-cache.ts:2` —
  "Content-addressed parse cache (Stream E, W2-E.1)"
- `packages/ingestion/src/pipeline/phases/content-cache.ts:133` —
  "lazily by a future eviction pass (W2-E.4)"
- `packages/ingestion/src/pipeline/phases/content-cache.ts:193` —
  "meta-sidecar cache-stats path (W2-E.4)"

**Real debt:**

1. **W2-E.4 eviction pass.** content-cache.ts:133 says eviction is
   deferred to "a future eviction pass." Search for any actual eviction
   code — if none exists, this is a real backlog item (parse cache will
   grow unbounded).

### packages/ingestion — profile detectors + providers (wave-labelled)

- `packages/ingestion/src/pipeline/phases/default-set.ts:20` — "scanner
  phases (W2-I4)"
- `packages/ingestion/src/pipeline/phases/dependencies.ts` — probably
  has W-code mentions; verify
- `packages/ingestion/src/pipeline/phases/incremental-helper.ts` — W-code
  mention; verify
- `packages/ingestion/src/pipeline/phases/incremental-scope.ts` and
  `incremental-scope.test.ts` — W-code mentions; verify
- `packages/ingestion/src/pipeline/phases/openapi.ts` — verify
- `packages/ingestion/src/pipeline/phases/parse.test.ts`, `parse.ts` —
  verify
- `packages/ingestion/src/pipeline/phases/processes.ts` — verify
- `packages/ingestion/src/pipeline/phases/profile.ts` — verify
- `packages/ingestion/src/pipeline/phases/sbom.test.ts`, `sbom.ts` —
  verify
- `packages/ingestion/src/pipeline/profile-detectors/frameworks.ts`,
  `languages.ts`, `manifests.ts` — verify
- `packages/ingestion/src/pipeline/types.ts` — verify
- `packages/ingestion/src/providers/http-detect.ts` — verify
- `packages/ingestion/src/providers/registry.test.ts`, `registry.ts` —
  verify

**Action:** most are likely stale labels. Spot-check any that contain
"TODO", "FIXME", or "in flight" — those are real debt.

### packages/mcp — prompts + tools (W-code markers)

- `packages/mcp/src/prompts/prompts.test.ts` — verify
- `packages/mcp/src/tools/annotations.test.ts` — verify
- `packages/mcp/src/tools/context.ts` — verify
- `packages/mcp/src/tools/dependencies.ts` — verify
- `packages/mcp/src/tools/group-query.ts` — verify
- `packages/mcp/src/tools/license-audit.ts` — verify

### packages/sarif — schema-validation W-code marker

- `packages/sarif/src/schema-validation.test.ts` — verify

### packages/scanners — P1/P2 tiers + W2-I4

- `packages/scanners/src/catalog.ts:107` — "W2-I4: Priority-2 scanners.
  These ship alongside P1 but are opt-in via" (exact quote)
- `packages/scanners/src/wrappers/osv-scanner.ts` — W-code mention
- `packages/scanners/src/wrappers/p2-wrappers.test.ts` — W-code mention
- `packages/scanners/src/wrappers/trivy.ts` — W-code mention

**Product fact to preserve:** the P1/P2 split is a real user-facing
feature. Keep "Priority-1" and "Priority-2" as product terminology
(they're documented in scanners/package.json description). Only drop
the W2-I4 label.

### Vendor README — the literal "(to be created in W2-B.2)" smoking gun

- `vendor/stack-graphs-python/README.md:39` — "That evaluator consumes
  the vendored `.tsg` as (to be created in W2-B.2)."

**Action:** the evaluator DOES exist at
`packages/ingestion/src/providers/resolution/stack-graphs/`. Rephrase
the README to point at the real path instead of a wave code. No debt;
just a stale pointer.

### Root / infra

- `pnpm-workspace.yaml` — W-code mention (probably a comment)
- `scripts/acceptance.sh` — W-code mentions
- `scripts/smoke-mcp.sh` — W-code mentions

### Commit subject lines (historical)

- `645c08e "Stream J: Multi-repo retrieval & group queries"` — this
  was a real release. Stream J = multi-repo groups. Confirmed shipped.
- `f08c87f "Initial commit: OpenCodeHub MVP + v1.0 roadmap"` — subject
  and body fine; body mentioned prior-art naming that has since been
  scrubbed via history rewrite.

## Stream names seen in history (for reference)

| Stream | What it shipped |
|--------|-----------------|
| Stream E | Content-addressed parse cache (`content-cache.ts`, meta sidecar) |
| Stream J | Multi-repo groups (group-query/group-status/group-sync MCP tools) |
| Stream T | SARIF suppressions (`packages/sarif/src/suppressions.ts`) |

## Revisit workflow

When you come back to these:

```bash
# Re-list any wave codes that survived into future commits
git grep -nE 'W[0-9]+[-.][A-Z0-9]+|\bStream [A-Z]\b'

# Run the banned-strings guardrail
bash scripts/check-banned-strings.sh
```

The guardrail (`scripts/check-banned-strings.sh`) blocks wave codes
and a rotating set of literals from re-entering the tree — so any
future appearance is a regression, not drift.

## SageMaker embedder backend — deferred follow-ups (2026-04-30, erpaval session-8564bf)

V1 of the SageMaker remote-embeddings backend shipped intentionally minimal
(new backend file + router tweak, 4 files touched). The following items were
surveyed by the ultraplan critic and deferred as scope-creep for v1.

1. **Index-metadata rebuild-on-switch refusal.** Today the `modelId` stamp
   (`gte-modernbert-base/sagemaker:<endpoint>`) is distinct from the local
   stamp (`gte-modernbert-base/fp32`), so a switched index is visible, but
   nothing refuses to query mismatched vectors. Add a check in
   `codehub analyze` + `codehub query` that reads the stored `modelId` from
   the graph store's `embedder_metadata` (new row) and hard-refuses with a
   clear message, plus a `--force-backend-mismatch` escape hatch.

2. **`defaultOpenEmbedder` consolidation.** The same seven-line
   tryOpenHttpEmbedder → openOnnxEmbedder dance is duplicated in three
   files: `packages/mcp/src/tools/query.ts:455`,
   `packages/cli/src/commands/query.ts:122`,
   `packages/ingestion/src/pipeline/phases/embeddings.ts:454`. Collapse
   into `packages/embedder/src/factory.ts` exporting
   `openDefaultEmbedder(options?)`.

3. **Piscina bypass for the remote backend.** `openOnnxEmbedderPool` wraps
   embeddings in Piscina worker threads to parallelize CPU-bound ONNX
   inference. For the SageMaker (I/O-bound) path, Piscina is pure overhead
   — structured-clone Float32Array copies across the worker boundary. Add
   a branch so remote backends skip the pool and use an in-process
   semaphore (see ultraplan Plan B § 2 for the speed-first design — AIMD
   breaker, 32-concurrency default, `p-limit`).

4. **Metrics + benchmark harness.** `embed.remote.{requests,retries,throttles,latency_ms,batch_size}`
   counters emitted via the existing structured logger, plus a benchmark
   script `packages/embedder/bench/remote-vs-local.ts` that runs 2,048
   repo-realistic chunks across both backends and reports p50/p95/p99
   latency, throughput, and CPU util. Pass criteria: ≥3× throughput on a
   4-core devbox with main-process CPU <20%.

5. **`codehub setup` / `codehub doctor` integration.** Setup could
   optionally validate AWS creds + endpoint reachability when
   `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` is set. Doctor could probe the
   endpoint with a 1-text canary and surface IAM / throttle / dim
   drift as a failed check.

6. **Client-side token budgeting.** v1 relies on the SDK-surfaced
   `ValidationException` path with a single split-retry. A proper
   packer that respects `MAX_BATCH_TOKENS=16384` — via a char-length
   heuristic (`ceil(chars/3.2)`) or a bundled tokenizer — would avoid
   the round-trip on oversized batches entirely.

Reference plans (all three): `.erpaval/sessions/session-8564bf/plans/synthesis.md`.
