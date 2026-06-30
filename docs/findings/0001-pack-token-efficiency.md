# Finding 0001 — An OCH pack cuts a coding agent's token usage 2–4× on real tasks

- Status: **Preliminary** — first live measurement, 2026-06-30.
- Author: Bonk + Laith.
- Instrument: `codehub code-pack --variance-probe` (Move 2, spec 010), the
  direct-CLI runner on Amazon Bedrock.
- Scope guard: 2 tasks × 5 runs/arm × 1 agent (Claude Code, Sonnet 4.5) × 1
  repo. This is a signal, not a benchmark. See "What this is not" below.

## The headline

Giving a coding agent an OpenCodeHub pack (the symbol skeleton + file-tree +
deps + xrefs map) instead of letting it explore the repo cut its **total token
usage 2.18×–4.08×** and its **dollar cost 1.9×–3.3×** across two tasks — while
producing the same quality of answer. The agent stopped re-reading files and
running tools to reconstruct structure it was handed up front.

This is the opposite direction from the variance-anchoring literature
(arXiv:2606.26979, "deterministic anchoring halves run-to-run variance at ~10%
*more* tokens"). OCH's pack does not *add* context on top of exploration — it
*replaces* the exploration. On a structure-discovery task that makes it
cheaper, not dearer.

## The measurement

Two tasks against an isolated snapshot of `@opencodehub/policy` (4 source files,
indexed to 106 graph nodes / 181 edges; pack `9fe66179`). Each task ran the
agent 5 times with the pack in context and 5 times without, holding
commit / instruction / agent / model fixed. Token totals include the cached
system prompt Claude Code injects per call (`cache_creation` + `cache_read`),
which dominates the count and was the subject of the bug fix in PR #271.

| Task | Arm | Total tokens | of which cache | Cost (5 runs) |
|---|---|---:|---:|---:|
| **A.** open-ended: "name the exact files + symbols to edit to add a `max_file_count` rule type" | without pack | 658,318 | 653,571 | $0.6412 |
| | with pack | 161,285 | 157,349 | $0.1965 |
| | **delta** | **4.08× fewer** | | **3.26× cheaper** |
| **B.** enumeration: "list every exported function and type" | without pack | 623,098 | 617,267 | $0.6969 |
| | with pack | 286,379 | 283,049 | $0.3644 |
| | **delta** | **2.18× fewer** | | **1.91× cheaper** |

The reduction is almost entirely **cache tokens** — the tokens the agent spends
reading files and running tools to reconstruct the codebase's shape. Without
the pack the agent burned 617K–654K such tokens per arm; with the pack, handed
the structure directly, it spent 157K–283K and stopped hunting. Output tokens
(the answer itself) barely moved (3.3K–5.6K), confirming the saving comes from
*exploration avoided*, not *shorter answers*.

## Why "variance" was the wrong headline

Move 2 was specced to measure run-to-run answer *variance* (does the pack make
the agent's answer wander less?). On these tasks the `output_hash` dispersion
metric came back **null** (delta 0, and −0.2 on Task B — noise at N=5). The
reason is mechanical, not a pack failure: `output_hash` compares answer *text*,
and a frontier model rephrases a free-text answer slightly every run, so every
answer hashes as distinct regardless of context. Measuring *decision*
convergence on prose needs the `judge` oracle (semantic-equivalence scoring),
which the CLI does not yet wire — tracked as the next gap.

Token efficiency, by contrast, is a directly measured resource number with no
such saturation problem — and it replicated cleanly across both task regimes.
It is the more defensible claim.

## What this is NOT

- **Not a benchmark.** N=5, one small repo, one agent, one model. The 2–4×
  range is a real signal on these tasks, not a published figure. A defensible
  number needs more tasks, more repos, larger N, and the second agent (Codex).
- **Not a variance result.** The variance question is still open pending the
  judge oracle (see above).
- **Not a correctness claim.** The probe did not score answer correctness here
  (the `output_hash` oracle only checks textual identity). The token saving is
  real; "same quality" is an eyeball judgment on the answers, not a graded one.

## Reproduce

```
# 1. Analyze a target repo so a pack can be generated.
codehub analyze /path/to/repo --no-scan

# 2. Write a task file (see packages/eval/examples/variance-task.yaml).
# 3. Run the probe (Claude on Bedrock, instance-role creds):
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-east-1 \
  codehub code-pack --variance-probe task.yaml \
  --runs 5 --harness claude \
  --model-claude us.anthropic.claude-sonnet-4-5-20250929-v1:0 --json
```

The emitted JSON reports per-arm `tokens` (`inputTokens` + `outputTokens` +
`cacheTokens`) and `tokenOverhead` (with/without total); a value below 1.0
means the pack reduced tokens.

## Next

1. Wire a `JudgeScorer` into `runVarianceProbe` so the `judge` oracle works
   end-to-end — unblocks the variance measurement on open-ended tasks.
2. Scale the token measurement: more tasks (build/fix/explain regimes), a
   second repo, the Codex arm, larger N — turn the 2–4× signal into a figure.
3. Revisit `DEFAULT_CLAUDE_MODEL` (`us.anthropic.claude-sonnet-4-6`): not
   confirmed available in the test account; sonnet-4-5 was used.
