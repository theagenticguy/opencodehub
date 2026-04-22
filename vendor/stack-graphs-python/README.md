# vendor/stack-graphs-python

Upstream **rule data** (not code) for the Python stack-graphs name resolver,
vendored from `github/stack-graphs` at a pinned SHA.

- Source: https://github.com/github/stack-graphs
- Commit: `fcb7705d5b38ae13b3665a9b2c882e5a97243d44`
- Upstream license: **MIT OR Apache-2.0** (dual; redistribution permitted with attribution)
- Upstream status: repository archived by GitHub on 2025-09-09 (read-only)
- Date pinned here: 2026-04-19

See the top-level `NOTICE` for the project-wide attribution.

## Layout

```
vendor/stack-graphs-python/
  LICENSE-MIT            # verbatim from upstream root
  LICENSE-APACHE-2.0     # verbatim from upstream root (upstream filename: LICENSE-APACHE)
  VERSION                # source/commit/date/license pin
  README.md              # this file
  rules/
    stack-graphs.tsg     # verbatim copy of languages/tree-sitter-stack-graphs-python/src/stack-graphs.tsg
```

The `.tsg` file is a declarative tree-sitter-graph rule set (~1,377 lines).
It describes how to build a stack graph from a tree-sitter-python parse tree
for name resolution. It is **data**, not source code: no functions execute
from this file directly.

## Our evaluator

OpenCodeHub ships its own clean-room TypeScript evaluator for these rules at:

```
packages/ingestion/src/providers/resolution/stack-graphs/
```

(to be created in W2-B.2). That evaluator consumes the vendored `.tsg` as
input; it is **not** a port of the upstream Rust evaluator and contains no
code copied from `github/stack-graphs`.

## Vendoring policy

1. **Never edit the files in `rules/` in place.** They are upstream data and
   must stay byte-identical to the pinned SHA so we can re-verify provenance
   at any time.
2. **Upgrades happen by re-vendoring** at a new SHA: delete the old file,
   re-fetch from the new raw URL, update `VERSION` and `NOTICE`, run the
   resolver eval suite, and commit.
3. **Bug fixes** needed in the rules must be filed as a separate OpenCodeHub
   patch layer — either a post-processor (see "Known gaps" below) or a
   fork-at-a-new-SHA with a clear diff note. We do not carry ad-hoc local
   patches inside `rules/`.
4. Keep the MIT/Apache license files next to the rule file so redistribution
   attribution stays intact if someone vendors this subtree further
   downstream.

## Known gaps (tracked in OpenCodeHub, not upstream)

- **`__all__` filtering.** The upstream rules do not honour Python's
  `__all__` convention when resolving `from foo import *`. They treat `*` as
  "every public binding in the module". OpenCodeHub adds a post-processor in
  **W2-B.3** that prunes wildcard-import references to the `__all__`
  allowlist when one is declared. The post-processor runs after the .tsg
  evaluator; the rules themselves are untouched.
- **Archived upstream.** Because `github/stack-graphs` is archived, any
  future tree-sitter-python AST shape changes will need local workarounds,
  not upstream PRs. We pin `tree-sitter-python` to a version compatible with
  these rules (see `packages/ingestion/package.json`) and re-evaluate on
  each grammar bump.
