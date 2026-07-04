---
title: A token-level duplication scan overcounts loop shells that already wrap shared helpers
track: knowledge
category: best-practices
module: packages/ingestion/src/providers
component: duplication analysis / dedup planning
severity: info
tags: [jscpd, duplication, dedup, scan, ground-truth, refactor-planning, false-signal]
applies_when:
  - "planning a dedup effort off a jscpd (or any token-level clone) report"
  - "the flagged files may already share the hard logic via a helper module"
  - "estimating LOC-collapse before committing to a refactor"
pattern: |
  A token-level duplication scanner counts the repeated LOOP SHELL that wraps an
  already-shared helper as a clone — even when the substantive logic was extracted
  long ago. Before trusting the scan's headline LOC-collapse number, ground-truth
  what is ALREADY shared: read the flagged files and the helper module they import.
  In OCH's providers, jscpd reported ~1,733 dup lines across the language providers,
  but the generic capture-pairing / owner-derivation / enclosing-scope walk was
  already centralized in extract-helpers.ts and consumed by all 14 providers. The
  REAL residual was two byte-identical private helpers (findNameInside,
  qualifiedForCapture — 13 verbatim copies) plus the ~20-30 line extractCalls/
  extractDefinitions loop shells that call the shared helpers. Also: the scan's
  "most-duplicated file" (ts-shared.ts) was not a duplicate at all — it is the
  shared TS-family module, consumed by typescript/tsx/javascript. And one extractor
  (extractImports) is irreducibly per-language (hand-rolled regex sets) — forcing a
  generic there adds indirection with no dedup win. Rank targets by
  (dup-lines-saved ÷ divergence-risk), not by the scanner's raw clone count.
example_files:
  - packages/ingestion/src/providers/extract-helpers.ts
  - packages/ingestion/src/providers/ts-shared.ts
---

# Why this matters

Acting on the scan's headline (~1.7k lines in providers) without grounding would
have (a) over-promised the collapse, (b) wasted effort trying to genericize
extractImports where every language's regex set is genuinely distinct, and (c)
risked "deduplicating" ts-shared.ts, which is the shared module the scan misread as
the biggest clone. Five parallel Explore agents ground-truthed the scan first; the
actual, safe collapse was the two zero-variance helpers (−247 LOC, near-zero risk)
+ extractCallsGeneric across all 14 providers (−472 LOC). The scan pointed at the
right AREA (providers, not the MCP↔CLI axis it originally emphasized) but its
per-file LOC attribution needed verification against what was already extracted.
