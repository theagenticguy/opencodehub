---
name: silent-degradation-needs-a-run-level-guard
description: A pipeline stage that catches per-item errors and continues (returns empty, logs a per-item warning) will hide a GLOBAL failure of that stage — every item fails identically, the run completes, prints a count, and exits 0. Per-item warnings collapse and never become a verdict. The fix is a pair — (a) at the failure site, distinguish a global/init failure from a per-item failure and THROW on global; (b) a run-level aggregate guard ("processed N items but produced 0 of the expected output") that maps to a distinct exit code. Smoke tests must assert real output, not "any non-empty result".
metadata:
  type: bug
  category: best-practices
tags: [analyze, parse, wasm, silent-failure, exit-code, error-handling, piscina, smoke-test, guard]
discovered: 2026-06-08
session: session-analyze-hardening
related:
  - fixed-offset-asset-resolvers-break-on-bundle-collapse
  - doctor-probe-drift-after-rip-and-replace
  - kill-escalation-races-the-exit-handler
---

# Silent degradation needs a run-level guard, not just per-item warnings

## What bit us

The fixed-offset WASM-resolver bug ([[fixed-offset-asset-resolvers-break-on-bundle-collapse]])
shipped invisibly for ~5 days. The resolver bug was the *cause*; the reason it
was *invisible* is a separate, more general defect worth its own lesson:

`codehub analyze` parses every source file in a Piscina worker. The worker's
per-file `try/catch` (parse-worker.ts) mapped **any** thrown error to
`{captures: [], warnings: [msg]}` and continued. So when the grammar runtime was
globally dead (vendored `vendor/wasms/` unresolvable in the flat bundle), EVERY
file took the catch, produced zero captures, and the pipeline built a
File/Directory-only **skeleton graph** — then printed `"5 nodes"` and **exited
0**. The per-file warnings existed but `logWarnings` collapsed them into
`"parse: N warnings (use --verbose)"`, and nothing aggregated them into a
run-level verdict or an exit code. A broken parser looked exactly like a healthy
parse of a symbol-free repo.

## The shape of the bug class

Any stage with this shape is vulnerable:

```
for (const item of items) {
  try { results.push(await process(item)); }
  catch (e) { warnings.push(e.message); results.push(EMPTY); }  // continue
}
return results;  // a GLOBAL failure = N identical EMPTY results = silent success
```

The per-item resilience (good — one malformed file shouldn't fail the run) is
exactly what masks a global failure (bad — a dead runtime should fail the run).

## The fix is a PAIR, not one change

You need both halves; either alone is insufficient.

**(a) At the failure site, distinguish global from per-item and THROW on global.**
Introduce a sentinel error (`WasmRuntimeUnavailableError`) for the
init/deployment-level failure (vendored dir missing, runtime won't init). Throw
it from the init path; rethrow it through the per-item catch *before* the
generic warning-mapping. A global failure then aborts the run loudly with an
actionable message, instead of becoming N warnings. Per-item errors (one bad
file) still warn-and-skip.

**(b) A run-level aggregate guard as the backstop.** Even with (a), a softer
degradation can slip through (e.g. the runtime package is genuinely absent and
the init path returns a soft `undefined` by design). So add a run-level
predicate: "the run processed >= K items that SHOULD have produced output, but
produced 0" → push a loud warning AND set a **distinct advisory exit code**
(here: 3, separate from generic-failure 1) so CI can detect a silent-skeleton
run without scraping logs. Make the predicate a pure exported function and
table-test the threshold.

Keep the two orthogonal: (a) keys off the thrown error, (b) keys off the output
count. They must not double-fire on the same condition — (a) handles hard death,
(b) handles the residual soft case.

## Gotchas that matter

- **Piscina structured-clones the rejection across threads** — a custom
  `class XError extends Error` arrives on the main thread as a plain `Error`
  with the prototype lost. Set `this.name` in the constructor and match on
  `err.name === "XError"` on the main thread (NOT `instanceof`). `instanceof`
  is fine *inside* the worker, before serialization.
- **Pick the denominator carefully.** "Files scanned" is the wrong count if some
  legitimately produce no output (here: cobol routes through a regex provider,
  not tree-sitter; config-only/empty repos have zero parseable files). The guard
  must key off "items that SHOULD have produced output" (tree-sitter files), or
  it false-positives on legitimately-empty repos. And don't count placeholder
  output (external import stubs are `CodeElement` nodes — counting them as
  "symbols" would let an import-only repo mask a broken parser).
- **Smoke tests must assert REAL output, not "any non-empty result".** The
  global-install verifier queried `'export default'` and passed on "≥1 hit" —
  but the query command's stderr header (`query: "..." (0 results)`) is itself
  non-empty, so the gate passed on a 0-symbol graph. Tighten to a KNOWN symbol
  from a KNOWN fixture with the expected KIND (`Function`) and FILE — something
  that can only appear if extraction actually ran.
- **A separate `doctor`-style health command does NOT protect the hot path.**
  `doctor` had a vendored-wasms check, but it's a manual command never run by
  `analyze`. Don't assume an existing health probe covers the pipeline.

## The one-line takeaway

Per-item error resilience hides global stage failure. Whenever you write
`catch → warn → continue` in a loop, ask "what does a GLOBAL failure of this
stage look like?" — and add (a) a thrown sentinel for the global case + (b) a
run-level "produced 0 of the expected output" guard with its own exit code.
Then make the smoke test assert real output, not a non-empty string.
