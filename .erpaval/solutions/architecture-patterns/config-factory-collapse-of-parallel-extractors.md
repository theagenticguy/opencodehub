---
title: Collapse N near-duplicate per-variant implementations into one generic + config factories, gated by a characterization harness
track: knowledge
category: architecture-patterns
module: packages/ingestion/src/providers
component: language-provider extractors
severity: info
tags: [dedup, generic, config-factory, strategy, behavior-preserving, characterization, extractors, dry]
applies_when:
  - "N implementations of the same operation share a ~80% identical loop shell and diverge only in small parameterized ways"
  - "behavior must be preserved exactly (a downstream hash or contract depends on the output)"
  - "the per-variant tests are structural and won't catch value drift"
pattern: |
  The safe recipe for collapsing N parallel near-duplicate implementations (here: 14
  language providers x 3 extractors — extractCalls, extractDefinitions, extractHeritage):
  1. Build a value-locking characterization harness FIRST (see the sibling lesson
     characterization-harness-before-hash-preserving-refactor) and prove it with a
     negative self-check. This is the arbiter for every subsequent step.
  2. Extract ONE generic function owning the identical loop shell, parameterized by a
     small `Config` object. Keep the generic in the deepest shared module (extract-helpers.ts).
  3. For each axis of variance, provide a FACTORY that returns a closure reproducing
     the original algorithm EXACTLY — e.g. receiver strategies (dotPrefixReceiver,
     sepStripReceiver, multiSepReceiver), kindFromMap(map), promoteToMethod predicates,
     ownerOverride. Do NOT collapse genuinely-different algorithms into one "unified"
     parameter — the extractCalls receiver had 4 distinct algorithms (lastIndexOf(.name)
     vs bare-name+strip vs multi-sep-preference vs none) that MUST stay separate.
  4. Accept two escape hatches: (a) a variant too entangled to fit stays custom
     (python's extractDefinitions — dual property/const dedup + Variable kind), and
     (b) some config providers pass a FUNCTION where others pass data (csharp/java
     kindFor reads nodeType; the generic takes the function form, data-providers wrap
     a Record). Forcing uniformity where the variants genuinely differ is the anti-goal.
  5. Convert ONE variant at a time, re-running the harness after each; a snapshot flip
     means you drifted — fix the config, never regenerate the golden.
  6. Prove dead/defensive config branches are grammar-unreachable rather than forcing
     fixtures for them (see verify-grammar-reachability-before-covering-a-config-branch).
  Result across OCH: ~1,100 net lines removed with graphHash byte-identity intact,
  verified by 2 adversarial reviewers finding NO drift.
example_files:
  - packages/ingestion/src/providers/extract-helpers.ts
  - packages/ingestion/src/providers/characterization.test.ts
---

# Why this matters

This is the generalization of collapse-parallel-switches-into-record-registry to a
LOOP body, not just a switch. The load-bearing discipline is: the characterization
harness makes "did I preserve behavior?" a mechanical per-variant check instead of a
judgment call, so the collapse can proceed one variant at a time with a hard gate,
and genuinely-divergent variants (4 receiver algorithms, python defs, csharp/java
nodeType kind resolution) are left as explicit config branches or custom code rather
than smeared into a lowest-common-denominator abstraction that drifts. The two failure
modes it avoids: over-unification (merging 4 receiver algs into 1 regex → silent
drift) and over-extraction (forcing python/extractImports into a generic that becomes
a pass-through lambda — the extractImports non-win). Config-factory + harness + one-at-
a-time is how you get the DRY win without the drift.
