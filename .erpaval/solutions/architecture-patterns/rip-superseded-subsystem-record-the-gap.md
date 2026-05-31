---
name: "Rip a superseded never-wired subsystem — but record the capability gap it covered"
description: When a sophisticated subsystem is dead at runtime (zero live callers), superseded by a better-resourced alternative, AND its upstream is archived, rip it under rip-and-replace latitude — but first investigate intent, and record the precision/capability gap it was meant to close so a future session doesn't re-discover the gap and revive it.
type: architecture-patterns
---

During the 2026-05-30 full-repo sweep, the OCH ingestion package carried
a ~1,900 LOC `stack-graphs` name-resolution subsystem
(`providers/resolution/stack-graphs/` + `stack-graphs-{python,ts}.ts` +
`resolver-strategy.ts` + `python-all-filter.ts` + vendored `.tsg` rules)
that ran ONLY under test. `getResolver()` had zero production callers; the
live `resolve()` path in `context.ts` never dispatched through it. Four
language providers still advertised `resolverStrategyName: "stack-graphs"`
in docstrings for a path that never executed.

## Investigate intent BEFORE ripping (don't just delete dead code)

The reflex is "no live callers → delete." Correct outcome here, but the
*reasoning* matters and the investigation is cheap. Read: the subsystem's
header docstring (design intent), the vendored asset's README (provenance +
"known gaps"), `git log` for when/why it landed, the ADRs, and prior
`.erpaval` research notes. That investigation revealed:

- **Intent was sound.** Stack-graphs was a planned *precision* layer to
  replace the three-tier walker's lossy "global tier" (0.5 confidence,
  name-only matching) with graph-theoretic name binding — LSP-quality
  resolution without a stateful server. Vendored `.tsg` rules + a
  clean-room TS evaluator. Roadmapped Python→TS→JS.
- **Superseded by a better-resourced bet.** The `scip-index` phase (SCIP
  indexers) emits compiler-grade edges at confidence 1.0, tagged
  oracle-confirmed. SCIP is strictly better for the same job, so
  stack-graphs became redundant for every SCIP-covered language.
- **Upstream died.** `github/stack-graphs` was archived 2025-09-09. A
  prior research session had ALREADY recorded "a dead-end dependency, do
  not adopt for new work" — the repo's own durable notes contained the
  verdict.

## The rip test (all three must hold)

1. **Dead at runtime** — zero live callers outside the subsystem + its
   tests (verify with grep across `src` minus `*.test.*` minus `dist`).
2. **Superseded** — a better-resourced alternative already does the job in
   production (here: SCIP-as-oracle).
3. **Upstream dead or diverged** — reviving it means maintaining a fork of
   something abandoned.

When all three hold, delete under rip-and-replace latitude: the subsystem
files, the vendored assets, the NOTICE/attribution entry, and the now-false
docstrings/`resolverStrategyName` hints in the referencing providers. Also
drop now-orphaned re-exports (`defaultResolver`, `ResolverStrategy` from the
package barrel) once grep confirms no external consumer.

## Record the capability gap — the part everyone forgets

Ripping a precision layer means the capability it covered is now carried by
something else (or nothing). Here: non-SCIP-covered languages (Rust has a
SCIP gap; Swift, COBOL) now fall back to the lossy name-only global tier
with NO precision overlay. That's an acceptable v1 posture (it was the
de-facto behavior anyway, since the layer never ran) — but it MUST be
written into the rip commit message / an ADR. Otherwise a future session
re-discovers "our cross-language resolution is imprecise for Rust" and
revives the exact dead-end you just removed. The gap note is the durable
artifact, not the deletion.

Generalizes to: any "elegant but never-wired" subsystem — a second cache
tier, an alternate serializer, a pluggable-backend seam with one
implementor. Related: [[doctor-probe-drift-after-rip-and-replace]] (sweep
probes/flags/CI branches at rip time) and
[[post-deletion-promise-debt-anti-pattern]] (the inverse failure: deleting
with intent to recreate, which never happens).
