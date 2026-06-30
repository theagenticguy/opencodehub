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

## Determinism of the probe's own output

The agent runs are nondeterministic by nature — that nondeterminism is exactly
what's being measured. The probe's *report*, by contrast, is a pure function of
the captured run outcomes: no wall-clock, no run-id. Two probe runs over the
same captured outcomes serialize byte-identically (same discipline as the
context-bom).

See `.erpaval/specs/010-variance-probe/spec.md` for the full design.
