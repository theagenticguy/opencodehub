# Finding 0002 — Does an OCH pack cut a coding agent's search loops?

- Status: **Instrument ready — awaiting the live measurement run.** The scoring
  harness and the SWE-bench task generator ship in this change; the numbers
  below are placeholders until the gated Bedrock run fills them.
- Author: Bonk + Laith.
- Instrument: `codehub code-pack --variance-probe --insight` (Move 1), scoring
  each run's tool-call trajectory against the TraceProbe (arXiv:2607.06184)
  structural anti-pattern detectors, on real SWE-bench Verified tasks.
- Grounding: TraceProbe ran its 2,500 trajectories on **SWE-bench Verified**, so
  these per-detector numbers are directly comparable to the paper's.

## The question

Finding 0001 showed an OCH pack cuts a coding agent's **token usage 2–4×** by
letting it stop re-reading files to reconstruct structure. That is a *resource*
number. This finding asks the *behavioral* question underneath it: does the pack
change **what the agent does** — specifically, does it cut the anti-patterns
TraceProbe found are the most stable failure-associated clues, chiefly the
**search loop**?

The hypothesis follows directly from OCH's thesis (hand the agent structure up
front, it stops hunting): with the pack in context, the agent should run fewer
long search/read stretches, re-read the same file less, and repeat fewer
searches. If it does not — if the pack cuts tokens but not loops — that is a real
result we publish too. **The number can come back null.**

## What is measured

For each task, the probe runs the agent N times with the pack and N times
without, holding commit / instruction / agent / model fixed (the same two-arm
design as Finding 0001). New in Move 1: every run's tool-call stream is captured
and normalized to TraceProbe's nine-type action taxonomy, then scored against
the four **structural** detectors — the ones whose predicates read only the
action list, no LLM labeler:

| Detector | Fires when (frozen predicate) |
|---|---|
| **Search Loop** | ≥10 consecutive search/read actions with no write and no validation command between them |
| **Re-read Churn** | the same file is read ≥3× within a 10-action window with no intervening write |
| **Redundant Search** | the same normalized query recurs ≥2× within a 10-action window |
| **Shell-over-Tool** | a shell `cat`/`grep`/`rg`/`find` runs read/search work a structured tool covers |

The report's headline is the **per-run `without − with` delta** for each
detector: positive means the pack suppressed the anti-pattern.

### The four semantic detectors are deliberately out of scope

TraceProbe defines eight structural + four semantic detectors. The semantic ones
(Phase Oscillation, and effect-labelled variants) need an LLM to label each
action's phase/effect — the same judge-oracle dependency that kept Finding
0001's headline on the directly-measured token number. Scoring them would import
labeler noise into a number we want to be a pure function of the trajectory.
They are a v2 concern.

## Results

_Awaiting the live run. Table shape (per harness, per detector):_

| Harness | Detector | without (per run) | with (per run) | Δ (without − with) |
|---|---|---:|---:|---:|
| claude | search loops | _tbd_ | _tbd_ | _tbd_ |
| claude | re-read churn | _tbd_ | _tbd_ | _tbd_ |
| claude | redundant search | _tbd_ | _tbd_ | _tbd_ |
| claude | shell-over-tool | _tbd_ | _tbd_ | _tbd_ |
| codex | … | | | |

Reported alongside Finding 0001's token/cost deltas and this run's assertion
pass-rate (graded by the tasks' own FAIL_TO_PASS/PASS_TO_PASS tests).

## What this is / is NOT

- **A behavioral complement to 0001, on graded tasks.** SWE-bench instances ship
  their own tests, so correctness here is *graded*, not the eyeball judgment
  0001 flagged.
- **NOT leaderboard resolve-rate.** v1 grades on a `/tmp` clone with deps
  installed; the probe runner does not reset the checkout between the N runs, so
  treat the **token + trajectory deltas as the trustworthy headline** and the
  assertion pass-rate as indicative. Per-run isolation (or SWE-bench's official
  per-instance Docker images) is a v2 upgrade.
- **NOT the four semantic detectors** (see above).
- **NOT a claim the pack makes agents *smarter*.** TraceProbe is explicit that
  structure helps by making navigation reproducible and disciplined; this
  measures exactly that — less wasted search — not higher capability.

## Reproduce

```bash
# 1. Get a SWE-bench Verified slice as instances.json (HF datasets), then:
node packages/eval/scripts/swebench-to-tasks.mjs \
  --instances /tmp/sb/instances.json --out-dir /tmp/sb/tasks \
  --clone-root /tmp/sb/repos --limit 8

# 2. Clone + install + analyze each repo (materializes the graph the pack needs):
bash packages/eval/scripts/swebench-prep.sh /tmp/sb/tasks

# 3. Run the probe with --insight (Claude on Bedrock; Sonnet 5 lane):
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-east-1 \
  codehub code-pack --variance-probe /tmp/sb/tasks/<id>.task.json \
  --insight --runs 10 \
  --pack-tokenizer anthropic:claude-sonnet-5@2026-06-30 --json
```

The `--json` report carries per-arm `insight.total` / `insight.perRun` and the
per-harness `insightDelta` (positive = the pack suppressed the anti-pattern).

## Next

1. Run the gated Bedrock measurement, fill the results table, flip status to
   **Preliminary**.
2. Add the SWE-bench Pro slice (harder, contamination-resistant) once Verified
   works end-to-end.
3. v2: per-run checkout isolation (or official Docker images) for
   leaderboard-comparable resolve-rate; then the four semantic detectors behind
   an explicit judge opt-in.
