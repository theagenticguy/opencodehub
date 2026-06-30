# Spec 010 — `pack --variance-probe`: measure the variance an OCH pack removes

**Status:** Draft for review (NO code yet — Laith wants to understand deeply first)
**Author:** Bonk + Laith · **Date:** 2026-06-30
**Branch:** `spec/010-variance-probe` (off `main` @ `6b4d122`)
**Roadmap origin:** M-W-F run 2026-06-29, Move 2 (HIGH). Depends on the Move 6 ruling (below).
**Grounding validator:** arXiv:2606.26979 — deterministic anchoring "roughly halves run-to-run variance at ~10% more tokens."

---

## 0. The Move 6 ruling this spec is built on (decision-equivalence)

Laith ruled (2026-06-30): **pivot the contract from byte-identity to decision-equivalence.** This reframes what `--variance-probe` measures, so it's stated up front.

- **Old contract (struck):** "same `(commit, tokenizer, budget, pins)` ⇒ byte-identical pack." Brittle — the #252 embedder swap (F2LLM-v2-80M, 320-dim) breaks byte-identity while the retrieval decision is unchanged. An auditor doesn't care about bytes; they care whether the agent saw the right thing.
- **New contract:** "same inputs ⇒ provably the **same retrieval decision set** (same files + byte ranges selected under the same budget)." Byte-identity becomes one cheap *witness* of decision-equivalence, not the contract itself.
- **Why this matters for Move 2:** the variance probe is *how you measure the new contract holding*. If the pack genuinely pins the agent's decision, run-to-run answer variance drops. The probe turns "decision-equivalence" from an assertion into a number. So Move 6 (the contract) and Move 2 (the measurement) are one story: **Move 2 is the instrument that proves Move 6's claim.**
- Move 6 also implies a sibling `codehub replay` that asserts decision-equivalence structurally (same selection, not same bytes) — specced separately (011); 010 is the empirical/behavioral half.

---

## 1. Diagnosis — why this move, why now

OCH's pitch has leaned on the adjective "deterministic." That word is now contested vocabulary (LeanCTX "token receipt", Rel(AI)Build, the receipt-tool cluster all claim it). A **measured variance delta** is a number rivals can't claim by relabeling. arXiv:2606.26979 (Jun 2026) gives the citable result — deterministic anchoring halves agent run-to-run variance — and `--variance-probe` is how OCH demonstrates *its own* pack does this on a real repo, not just cites a paper.

The headline this earns: **"an OCH pack halves how much a coding agent's answer wanders run-to-run, at ~10% token cost"** — backed by a reproducible measurement the user can run.

## 2. The hard part: what is a "task"? (Laith's first question)

A "task" must be precise enough to run repeatedly and score. Definition:

> A **task** is a fixed triple `(repo @ commit, instruction, success_oracle)` run by a coding agent, where the agent's only variable input across the experiment is **whether the OCH pack is in its context**.

- **`repo @ commit`** — a pinned checkout. Frozen so the *only* variable is the pack.
- **`instruction`** — a natural-language ask given verbatim to the agent every run (e.g. "Add a `--json` flag to `codehub status` that prints the staleness record"). Stored as a string in the task file; never paraphrased between runs.
- **`success_oracle`** — how a run is scored. Three oracle types, in increasing cost:
  1. **`output_hash`** (cheapest, no scoring agent) — variance = how often the agent's *final answer text / produced diff* differs across N runs. This measures raw output dispersion. Good for "did the agent converge".
  2. **`assertion`** — a deterministic check the run either passes or fails (a test command exit code, a grep for a required symbol, a file-exists check). Variance = pass-rate dispersion (e.g. 6/10 with pack vs 3/10 without). This is the most defensible "variance" because it's objective.
  3. **`judge`** (most expensive) — an LLM-judge panel scores each run's answer 0–1 on a rubric; variance = stddev of the scores. Reserved for tasks with no mechanical oracle.

**What "variance" means precisely:** for a task run N times in each arm (with-pack / without-pack), variance is a per-arm dispersion statistic over the N outcomes:
- `output_hash` oracle → **distinct-output ratio** = `(# distinct outputs) / N` (1.0 = every run different, 1/N = perfectly stable).
- `assertion` oracle → **failure-rate stddev** across N, or simply pass-rate (a stabler pass-rate IS lower behavioral variance).
- `judge` oracle → **stddev of rubric scores** across N.

The probe reports each arm's dispersion and the **delta** (without − with). The Move-2 claim holds when the with-pack arm's dispersion is materially lower.

## 3. The experiment design (with / without)

```
for arm in [without_pack, with_pack]:
  for i in 1..N:                      # N = --runs, default 10
    fresh agent session (no carryover)
    context = instruction
            + (arm == with_pack ? the OCH code-pack for repo@commit : nothing)
    run agent → capture (final_text, diff, oracle_result, tokens)
  dispersion[arm] = oracleDispersion(results[arm])
report { without: dispersion[without_pack], with: dispersion[with_pack],
         delta, tokenOverhead: tokens[with]/tokens[without] }
```

Controls that make the number honest:
- **Same instruction, same commit, same agent, same model** across both arms — the pack is the only manipulated variable.
- **Fresh session per run** — no conversational carryover contaminating variance.
- **Token overhead reported alongside** — the paper's claim is "halves variance at ~10% more tokens"; a probe that halves variance at 3× tokens is a different (worse) story, so cost is a first-class output, not a footnote.
- **Determinism of the probe itself** — temperature/seed are pinned where the harness allows; where it doesn't (most agents are nondeterministic by design), that nondeterminism IS the variance being measured, so it's left free *within* an arm but identical *between* arms.

## 4. Harness: how do we actually run the agent? (Laith's omnigent suggestion)

Grounded against the real repo (`omnigent-ai/omnigent`, 5,494★, Apache-2.0, Python 3.12, pushed 2026-06-30, **status: alpha**):

Omnigent is a **meta-harness** — one orchestration layer over Claude Code, Codex, Cursor, OpenCode, Kimi, and custom agents. An "agent" is a YAML (`executor.harness` + `prompt`); you run it with `omnigent run <agent.yaml> --harness <claude-sdk|codex|cursor|…>`, and a `sdks/python-client` drives it programmatically. **This is exactly the shape the probe needs**: one task definition, swap the harness flag, run headless, capture output.

**Why omnigent is the right call for this probe:**
- The variance story is far stronger if it holds **across agents** (Claude Code AND Codex), not just one — "the pack halves variance regardless of which agent reads it" is the defensible, agent-neutral claim. Omnigent is the only thing that drives both from one interface without per-agent glue.
- It already solves the headless-run + output-capture + sandbox problem the probe would otherwise hand-roll.

**The tradeoffs I'm not hiding:**
- **Alpha.** Pinning a specific commit/release is mandatory; its API may move. The probe must tolerate that (thin adapter, see §5).
- **Heavy dependency.** It pulls a server + sandbox providers. The probe should treat omnigent as an **optional, pluggable runner behind an interface**, NOT a hard dependency of `@opencodehub/eval`. Default to it; allow a simpler direct-CLI runner.
- **Credentials live in each harness's own login** (`claude` / `codex` CLI auth), not OCH config — fine for a local probe, a documented prerequisite.

**Recommendation:** define a small `AgentRunner` interface (`run(task, withPack) → {finalText, diff, tokens}`); ship an **omnigent-backed runner** as the default multi-agent implementation and a **direct-CLI runner** (shell out to `claude -p` / `codex exec`) as the dependency-light fallback. The probe logic is harness-agnostic; the runner is swappable. This keeps an alpha dep from being load-bearing while getting the cross-agent story omnigent uniquely enables.

## 5. Where it lives + shape

- **`packages/eval`** — currently a stub (README only). This is its first real content: `@opencodehub/eval` gains the variance-probe core (task loading, the experiment loop, dispersion stats, the `AgentRunner` interface + the two runner impls).
- **CLI surface:** `codehub pack --variance-probe <task-file> [--runs N] [--harness <h>] [--runner omnigent|cli]` → prints the per-arm dispersion + delta + token overhead; `--json` emits the full record.
- **Task file:** a small YAML/JSON: `{ repo, commit, instruction, oracle: {type, ...}, harness? }`.
- **Determinism of the probe's own output:** the *report* is a pure function of the captured run outcomes; no clock/run-id in the emitted record (same discipline as the context-bom), so two probe runs over the same captured outcomes serialize identically. (The agent runs themselves are nondeterministic by nature — that's the point.)

## 6. EARS requirements (draft — for review, not yet final)

- **R1** WHEN given a task file `(repo, commit, instruction, oracle)`, the probe SHALL run the agent N times (default 10) in each of the with-pack and without-pack arms, holding commit/instruction/agent/model fixed.
- **R2** The probe SHALL compute a per-arm dispersion statistic appropriate to the oracle type (distinct-output ratio / pass-rate stddev / judge-score stddev) and report the without−with delta.
- **R3** The probe SHALL report token overhead (with-pack tokens / without-pack tokens) alongside the variance delta — variance reduction is only meaningful against its cost.
- **R4** The agent runner SHALL be an interface with at least two implementations: an omnigent-backed multi-agent runner (default) and a direct-CLI runner (no omnigent dependency).
- **R5** WHERE omnigent (alpha) is unavailable or its API has drifted, the probe SHALL fall back to / be usable via the direct-CLI runner without code change to the probe core.
- **R6** The emitted `--json` report SHALL be a pure function of the captured run outcomes (no wall-clock/run-id), so the report serialization is reproducible given the same outcomes.
- **R7** The probe SHALL pin the omnigent version it was validated against and surface a clear error if the installed version mismatches.

## 7. Open questions for Laith (review these — don't want to build past them)

1. **Default oracle.** I lean `assertion` (objective, defensible) as the documented default, with `output_hash` as the zero-config quick look and `judge` opt-in. Agree, or do you want `judge` front-and-center for the marketing number?
2. **N (runs per arm).** 10 is the smallest N that gives a believable dispersion; 20+ is more defensible but doubles agent cost (real $ on Claude/Codex). Default 10, configurable?
3. **Which agents for the headline.** Claude Code + Codex both (the agent-neutral claim) — or is one enough for v1 and the second a follow-up?
4. **Token-overhead guardrail.** Should the probe *flag* (not fail) when variance drops but token overhead exceeds, say, 1.3× — i.e. "you bought stability expensively"? I think yes; it keeps the claim honest.
5. **Omnigent now, or CLI-runner first?** Given omnigent is alpha, a defensible v1 is: ship the probe core + the direct-CLI runner first (fast, dependency-light, proves the method), add the omnigent runner second (unlocks the cross-agent story). Or do you want omnigent in v1 because the multi-agent claim IS the point?

## 8. What this is NOT (scope guard)

- Not a SWE-bench-style correctness benchmark — it measures *dispersion*, not capability. (SWE-Explore / SWE-bench remain the publish-against targets, separate.)
- Not the `replay`/decision-equivalence structural check (spec 011, the other half of Move 6).
- Not a CI gate — it's an on-demand measurement (agent runs cost real money + minutes).
