---
title: Verify a config/AST branch is grammar-reachable before treating it as a coverage gap
track: knowledge
category: conventions
module: packages/ingestion/src/providers
component: tree-sitter queries / extractor config branches
severity: info
tags: [tree-sitter, grammar, reachability, coverage, characterization, dead-branch, dart, promote-to-method, empirical]
applies_when:
  - "a review flags a config branch or AST-handling path as having no test coverage"
  - "you are about to add a fixture to exercise a per-language/per-variant branch"
  - "working with tree-sitter grammars whose node vocabulary you have not empirically confirmed"
pattern: |
  A branch with "no fixture coverage" is not always a coverage gap — sometimes the
  branch is UNREACHABLE by the grammar's construction, i.e. defensive/dead code that
  no valid input can trigger. Before writing a fixture to cover it, PROVE the branch
  is reachable by parsing a candidate input through the actual (WASM) grammar and
  inspecting the node types / captures. If no valid source produces the node the
  branch keys on, the branch is unreachable-by-construction: document it, do NOT
  fabricate invalid source to force it, and do NOT treat its absence from the golden
  as a defect.

  Three real cases from OCH (session-6a05ac), all confirmed by live-parse probes:
  - dart @reference.call: dart's grammar has NO invocation node (function_expression_
    invocation → "Bad node name"); calls are flat sibling chains, so a sound single-
    S-expression call capture is impossible. Left absent + documented.
  - promoteToMethod struct/enum (swift), module (ruby), interface (kotlin): the
    provider config lists these owner tags, but the grammars never emit a
    `definition.function` nested under those container tags (methods in a struct
    parse as definition.method, etc.), so the promotion branch for those owners is
    dead. Only the class (and dart mixin) branch actually fires.
  Conversely, the isExported=false branch WAS reachable for swift/dart/kotlin/cpp/js
  (a `_`-prefixed decl fires it) — that one was a genuine gap, and adding a
  `_privateHelper` fixture closed it.

  The discriminator: reachability is a property of the grammar + the extractor's
  tag vocabulary, not of the current fixture. Probe the grammar, don't guess.
example_files:
  - packages/ingestion/src/providers/characterization.test.ts
  - packages/ingestion/src/parse/unified-queries.ts
---

# Why this matters

Two adversarial reviewers flagged ~8 "uncovered config branches" after the
extractor-generic refactor. A naive response fabricates a fixture for each. The
correct response, taken here: probe the dart/swift/ruby/kotlin WASM grammars, find
that most of the flagged promotion branches are unreachable-by-construction (dead
defensive code, not gaps), close only the genuinely-reachable ones (isExported=false
via `_`-prefixed decls), and document the unreachable ones so the next reviewer
doesn't re-flag them. Fabricating invalid source to hit a dead branch would add a
misleading fixture and could even mask a real future regression. The same probe
discipline killed the dart-call-capture dead end before it shipped an unsound query.
Grep the grammar; a "gap" that no valid input can reach is a documentation task, not
a fixture task.
