---
title: Build a full-value characterization harness before a hash-preserving refactor when unit tests are structural
track: knowledge
category: best-practices
module: packages/ingestion/src/providers
component: graph extractors / graphHash determinism
severity: info
tags: [characterization, golden-test, refactor, determinism, graphhash, snapshot, negative-self-check, behavior-preserving]
applies_when:
  - "refactoring code whose only field-level correctness gate is a downstream hash (graphHash byte-identity)"
  - "the existing unit tests assert set-membership / structure, not exact VALUES of hash-relevant fields"
  - "you are collapsing N near-duplicate implementations into one parameterized generic"
pattern: |
  When the per-unit tests are structural (e.g. "defs include Greeter") they do NOT
  lock the hash-relevant VALUES a refactor can silently drift: calleeOwner,
  qualifiedName, startLine, owner, the undefined-vs-null-vs-empty distinction. The
  only true gate (incremental-determinism / graphHash parity) may run over ONE
  fixture (e.g. a TS repo), leaving every other language's extractor field-drift
  uncaught. Close the gap BEFORE touching the code: build a characterization test
  that snapshots the FULL canonical-JSON output of every unit x every operation over
  a representative fixture, asserts byte-equality against a committed golden, and
  fails with a per-unit/per-operation diff. Prove the net works with a NEGATIVE
  SELF-CHECK (perturb one output, confirm it fails with a precise diff, revert)
  before trusting it. Then convert one unit at a time, re-running the harness after
  each. Sort each output array by canonicalJson(element) so pure-reorder churn is
  cancelled but value drift is caught. Gate golden regeneration behind an explicit
  env flag; never let it rewrite silently.
example_files:
  - packages/ingestion/src/providers/characterization.test.ts
  - packages/ingestion/src/providers/characterization-golden.ts
---

# Why this matters

The extractCallsGeneric refactor (session-6a05ac) collapsed 14 language providers'
extractCalls into one generic + 4 receiver-strategy factories. The per-provider
tests would have passed even if the generic drifted a `calleeOwner` value for
several languages — and that drift only shows up as a graphHash change in
production, long after the refactor. The characterization harness (65 snapshots:
16 providers × 4 extractors + a registry-count tripwire) made any field drift fail
immediately with `characterization drift: <lang>.<extractor> changed value`. Its
negative self-check (perturb swift calleeName → fail → revert) proved it before a
single provider was converted. Result: all 14 conversions landed with graphHash
byte-identity intact, verified from a clean rebuild.

A coverage caveat the harness itself surfaced: a snapshot only locks the paths its
fixture EXERCISES. Five providers had no receiver-bearing call site, so their
`calleeOwner` branch had no live tripwire — found in the Validate phase, fixed by
adding receiver-bearing calls to those fixtures (dart couldn't be fixed at fixture
level: its parse query has no @reference.call capture, so it structurally emits 0
calls — a genuine gap to log, not force). Lesson within the lesson: after building
the harness, audit whether each unit's fixture actually exercises the risky branch.
