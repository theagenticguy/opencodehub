# TypeScript gym corpus

## ts-pattern.yaml

Golden corpus of 13 LSP-oracle cases (6 `references`, 4 `callers`, 3
`implementations`) against the [`ts-pattern`][tsp] fixture pinned at tag
`v5.5.0`, commit `1fed6208ee0c7f662e7e5239cdc7ee791e0fa246`, vendored as a
submodule at `packages/gym/corpus/repos/typescript/ts-pattern`. Expected
results were auto-labeled by Opus 4.7 by reading the source directly — every
line and column was verified against the checked-in v5.5.0 file contents, with
1-indexed line and column pointing at the identifier's first character.
Imports, declarations, JSDoc comments, `tests/`, `benchmarks/`, `examples/`,
`docs/`, and `scripts/` were excluded; compound type names that merely contain
a target substring (e.g., `UnknownPattern` for the `Pattern` target,
`InvertPattern` for the `Pattern` target, `AnyMatcher` for the `Matcher`
target) were filtered out with word-boundary matching. The three
`implementations` cases are waived because ts-pattern's type surface is
expressed entirely as type aliases and structurally-typed object literals, for
which `typescript-language-server` returns no implementers — the cases are
retained so the gym distinguishes "LSP returned nothing" from "no case
present" and exposes any future tsserver improvement.

To regenerate: update the fixture submodule
(`git -C packages/gym/corpus/repos/typescript/ts-pattern fetch && git -C …
checkout v5.5.0`), re-run the Opus labeler over the source tree, and diff
against the committed YAML before committing. The existing `corpus.test.ts`
tests lock the case count at 13 so any change to the set is deliberate.

[tsp]: https://github.com/gvergnaud/ts-pattern
