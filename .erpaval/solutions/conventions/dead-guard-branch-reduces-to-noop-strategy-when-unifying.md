---
title: Verify a per-variant guard actually filters before preserving it when unifying implementations
track: knowledge
category: conventions
module: packages/ingestion/src/providers
component: extractCalls receiver inference
severity: info
tags: [refactor, dead-code, guard, regex, receiver-inference, unify, behavior-preserving, no-op]
applies_when:
  - "collapsing N per-variant implementations into one parameterized generic"
  - "a variant carries a guard (regex test, early-return, includes-check) that LOOKS like it differentiates behavior"
  - "you must preserve behavior exactly (hash-identity / characterization gate)"
pattern: |
  When unifying near-duplicate implementations, a per-variant guard can be DEAD —
  present in the source but with no effect on output — and collapsing it to the
  simpler shared strategy is then behavior-PRESERVING, not a change. Prove deadness
  from the OLD code before folding. Two real cases from the OCH extractCalls unify:
    - python's inferPyReceiver and ts-shared's inferTsReceiver each had a regex
      guard whose BOTH branches returned the same prefix
      (`if (RE.test(prefix)) return prefix; return prefix;`) — the regex never
      filtered anything. Folding them to the no-regex strategy (dotPrefixNoRegex)
      was exact. The packet had said "defer python/ts unless trivial"; proving the
      guard dead made it trivial.
    - java's receiver block was gated on `ref.text.includes(".")` before a
      `lastIndexOf(".name")` — a proven no-op, because lastIndexOf returns -1 when
      there is no ".", so the guard short-circuits nothing. java folded into the
      plain dot-prefix strategy.
  Contrast: do NOT assume all guards are dead. cpp/php use `lastIndexOf(bareName)`
  + strip-trailing-separator + a REAL regex that filters; swift/ruby use
  `lastIndexOf(".name")` with a REAL regex; rust tries `::` then `.` in order.
  Those are genuine behavior and must each be reproduced verbatim (do NOT collapse
  the four algorithms into one "unified" regex). The discriminator is: does the
  guard change the output for any input the code actually sees? Read both branches;
  if they converge, it's dead.
example_files:
  - packages/ingestion/src/providers/extract-helpers.ts
---

# Why this matters

The unify agent could have "played it safe" and preserved python/ts/java's guards
as distinct strategies, leaving three near-duplicate factories that don't earn
their existence. By proving the guards dead from the deleted code, it folded all 14
providers into 4 honest strategy factories with the characterization harness green
at every step. Equally important is the inverse discipline: the same agent did NOT
merge cpp's `->`/`::` strip or rust's separator-preference loop into the dot-prefix
strategy, because those guards DO filter — merging them would have drifted
`calleeOwner` and failed the harness. The rule is symmetric: prove a guard dead
before dropping it, and prove two guards equivalent before merging them.
