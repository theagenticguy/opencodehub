---
title: A backtick inside a template-literal-embedded DSL string terminates the literal (TS1005)
track: bug
category: build-errors
module: packages/ingestion/src/parse
component: tree-sitter query strings (JS template literals)
severity: low
tags: [template-literal, backtick, tsc, TS1005, tree-sitter, query, comment, dsl]
symptoms:
  - "tsc -b fails with TS1005 ',' expected on prose lines inside a template literal"
  - "the error points at natural-language text that was meant to be a comment inside an embedded DSL string"
root_cause: |
  A tree-sitter query (or any DSL) stored as a JS template literal is delimited by
  backticks. Writing an explanatory comment INSIDE that query body — using the DSL's
  own line-comment syntax (`; ...` for tree-sitter S-expressions) — is fine UNTIL the
  comment prose contains a backtick (e.g. a Markdown-style `obj.field` inline-code
  span). The backtick closes the JS template literal early; everything after it is
  re-parsed as JavaScript, and tsc emits TS1005 (',' expected) on the now-orphaned
  prose. The DSL comment marker (`;`) does NOT protect against this — comment-ness is
  a property of the DSL parser, but the JS template literal is delimited by the JS
  lexer FIRST, before the string ever reaches the DSL.
resolution_type: code-fix
applies_when:
  - "writing an explanatory comment inside a DSL stored as a JS/TS template literal"
  - "the DSL is delimited by backticks (tree-sitter queries, SQL-in-backticks, GraphQL gql``, etc.)"
---

# Fix

Do not use backticks in prose that lives inside a backtick-delimited template
literal. Write `obj.field` as `obj.field` without the code-span backticks (plain
`obj.field` text), or escape as `\``, or move the explanation to a JS `//` comment
OUTSIDE the template literal. In OCH this bit when documenting why dart's
`DART_QUERY` intentionally omits `@reference.call`: the comment said "field READs
like `obj.field`" and the backticks around `obj.field` truncated the query template,
breaking `tsc -b` (unified-queries.ts). Fix was to drop the inline-code backticks
("field READs such as obj.field").

# Why this matters

The build gate caught it immediately (TS1005), so it never shipped — but the error
message points at the PROSE, not the backtick, so it reads as a nonsense parse error
until you notice the stray backtick closed the literal. Any embedded-DSL-in-template-
literal comment is exposed: SQL in backticks, GraphQL `gql\`...\``, tree-sitter query
bodies. Sweep DSL-in-template-literal comments for backticks, or keep such
explanations in host-language comments outside the literal.
