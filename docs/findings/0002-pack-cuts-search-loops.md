# Finding 0002 — An OCH pack cuts a coding agent's shell-hunting and file re-reads (search loops don't fire on fix tasks)

- Status: **Preliminary — first live run, 2026-07-08.** Two SWE-bench Verified
  tasks × 5 runs/arm on Claude Code / Sonnet 5 via Amazon Bedrock. A wider sweep
  (more tasks, the pytest repos) was still running at write time; this reports
  what completed. A signal, not a benchmark.
- Author: Bonk + Laith.
- Instrument: `codehub code-pack --variance-probe --insight` (Move 1), scoring
  each run's tool-call trajectory against the TraceProbe (arXiv:2607.06184)
  structural anti-pattern detectors, on real SWE-bench Verified tasks.
- Grounding: TraceProbe ran its 2,500 trajectories on **SWE-bench Verified**, so
  these per-detector numbers are directly comparable to the paper's.

## The headline

Across the two tasks measured, an OCH pack **suppressed the two anti-patterns
that actually fired** and left the others at zero:

- **Shell-over-Tool: 1.8 → 0.3 firings/run** (mean Δ +1.5) — the pack stops the
  agent from shelling `grep`/`cat`/`find` to reconstruct structure it was handed.
- **Re-read Churn: 0.6 → 0.1 firings/run** (mean Δ +0.5) — it re-reads the same
  file far less.
- **Search Loop: 0 → 0.** It never fired in either arm. SWE-bench fix tasks give
  the agent a specific bug, so it does not run the ≥10-action open-ended search
  stretches TraceProbe's Search Loop detects. On these tasks the pack's win is
  *shell-hunting and re-reads*, not loops — the honest, narrower claim.
- **Redundant Search: 0 → 0.** Same reason.

This is the behavioral complement to Finding 0001's 2–4× token cut: the pack
doesn't just cost fewer tokens, it changes what the agent *does* — less shelling
out, fewer re-reads.

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

Claude Code / Sonnet 5 on Bedrock, N=5 runs/arm. Per-run detector firings,
`without pack → with pack`:

| Task | tokenOverhead | Search Loop | Re-read Churn | Redundant Search | Shell-over-Tool |
|---|---:|---|---|---|---|
| `pallets/flask-5014` | 11.0× | 0 → 0 | 0 → 0 | 0 → 0 | **1.6 → 0.4** |
| `psf/requests-1142` | 2.3× | 0 → 0 | **1.2 → 0.2** | 0 → 0 | **2.0 → 0.2** |
| **mean** | 6.6× | 0 → 0 | 0.6 → 0.1 | 0 → 0 | 1.8 → 0.3 |

Positive delta = the pack suppressed the anti-pattern. Both tasks agree in
direction; the pack cut every anti-pattern that fired and introduced none.

**Codex arm:** not run. This Bedrock account exposes only `openai.gpt-oss-*`,
not the `gpt-5.5` the Codex runner targets, so the run is Claude-only (Sonnet 5,
the default agentic tier). The Codex arm is deferred to an account with the
model.

**Token overhead** ranged 2.3×–11×: the pack is injected fresh and uncached per
run, so a small repo (flask) with a large-relative pack shows high overhead. On
the `--cache-channel` path (Move 4), a stable pack prefix caches across runs on
opt-in providers — not exercised here.

**Assertion pass-rate: 0 in both arms, uninformative.** The `/tmp` clones did
not have their Python deps installed, so the graded oracle could not run the
tests. Exactly the fidelity limit called out below. The token + trajectory
deltas are the trustworthy headline; the graded correctness number needs the
Docker-image path (v2).

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

1. **Widen the corpus.** Two tasks is a signal, not a benchmark. Finish the
   in-flight sweep (the pytest repos, more requests instances) and add tasks
   with genuinely open-ended exploration to test whether Search Loop *ever*
   fires under a pack — the one detector still at zero.
2. **Install deps in the checkouts** (or use SWE-bench's official per-instance
   Docker images) so the assertion pass-rate becomes informative and we can
   report graded correctness alongside the trajectory deltas.
3. **Codex arm** on an account exposing a `gpt-5.x` Bedrock model, for the
   agent-neutral claim.
4. Add the SWE-bench Pro slice (harder, contamination-resistant).
5. v2: the four semantic detectors behind an explicit judge opt-in.
