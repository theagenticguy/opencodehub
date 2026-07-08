# @opencodehub/eval — variance probe

`@opencodehub/eval` measures the **run-to-run answer variance** a coding agent
shows with vs. without an OpenCodeHub code-pack in its context. It is the
empirical instrument behind the decision-equivalence contract (Move 6): if the
pack genuinely pins the agent's retrieval decision, the agent's answer wanders
less across repeated runs. The probe turns that claim into a number.

> The Python retrieval / graph-quality harness that *used* to live here was
> extracted to the sibling `opencodehub-testbed` repo so the published package
> set ships free of test-time dependencies. This TypeScript probe honors that
> intent: it is pure JS + `node:child_process` (no heavy runtime deps, no
> Python), and the package is `private`. It is force-bundled into the
> `@opencodehub/cli` tarball (tsup `noExternal`), so it never adds an
> independently published runtime package.

## What it does

Given a **task** — a fixed triple `(repo @ commit, instruction, success_oracle)` —
the probe runs a coding agent N times in each of two arms (with-pack /
without-pack), holding commit, instruction, agent, and model fixed. The only
manipulated variable is whether the OCH pack is in context. It then computes a
per-arm dispersion statistic appropriate to the oracle and reports the
`without − with` delta alongside the token overhead.

| Oracle | Dispersion statistic | Use |
|---|---|---|
| `output_hash` | distinct-output ratio `(# distinct outputs)/N` | zero-config quick look |
| `assertion` (default) | pass-rate + failure-rate stddev across N | objective, defensible headline |
| `judge` | stddev of LLM-panel rubric scores | tasks with no mechanical oracle |

## Inference backend

The direct-CLI runner drives `claude -p` (Claude Code) and `codex exec`
(Codex), and **both route inference through Amazon Bedrock** (spec 010 §4a):
Claude Code via `CLAUDE_CODE_USE_BEDROCK=1` + a `us.`-prefixed
`ANTHROPIC_MODEL` inference profile; Codex via its first-party
`amazon-bedrock` provider. AWS credentials and region are inherited from the
operator's environment.

## Trajectory scoring — INSIGHT anti-patterns (Move 1)

Passing `--insight` also captures each run's **tool-call trajectory** (Claude
Code `--output-format stream-json`; Codex `--json`), normalizes it to
TraceProbe's ([arXiv:2607.06184](https://arxiv.org/abs/2607.06184)) nine-type
action taxonomy, and scores it against four **structural** anti-pattern
detectors — no LLM labeler:

| Detector | Fires when |
|---|---|
| Search Loop | ≥10 consecutive search/read actions, no write or validation between |
| Re-read Churn | same file read ≥3× in a 10-action window, no intervening write |
| Redundant Search | same normalized query recurs ≥2× in a 10-action window |
| Shell-over-Tool | `cat`/`grep`/`rg`/`find` shelled while a structured tool covers it |

The report adds a per-harness `insightDelta` — the per-run `without − with` of
each detector (positive = the pack suppressed the anti-pattern). The four
*semantic* TraceProbe detectors (Phase Oscillation, …) need an LLM labeler and
are deferred to v2 (the judge-oracle caveat).

### Real tasks — SWE-bench Verified / Pro

`scripts/swebench-to-tasks.mjs` turns a SWE-bench instances JSON into probe task
files: the `problem_statement` becomes the instruction, and an `assertion`
oracle applies the `test_patch` and runs the FAIL_TO_PASS + PASS_TO_PASS tests
(so correctness is *graded*, unlike Finding 0001). `scripts/swebench-prep.sh`
clones + installs + analyzes each repo. See `docs/findings/0002` for the full
protocol and fidelity limits (v1 grades on a `/tmp` clone without per-run
checkout isolation — token + trajectory deltas are the trustworthy headline).

## Determinism of the probe's own output

The agent runs are nondeterministic by nature — that nondeterminism is exactly
what's being measured. The probe's *report*, by contrast, is a pure function of
the captured run outcomes: no wall-clock, no run-id. Two probe runs over the
same captured outcomes serialize byte-identically (same discipline as the
context-bom).

See `.erpaval/specs/010-variance-probe/spec.md` for the full design.
