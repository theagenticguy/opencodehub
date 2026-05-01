# Python corpus — `sdk-python.yaml`

Schema: `corpusFileSchema` in `packages/gym/src/corpus.ts`.
See sibling corpora via `../repos/README.md` (fixture pins).

These golden cases were ported from the pyright oracle spike at
`/tmp/spike-pyright-oracle-goldens.yaml` (captured 2026-04-23T17:11:42Z,
labeler `opus-4-7`) into the gym corpus schema.

The fixture is
[`strands-agents/sdk-python`](https://github.com/strands-agents/sdk-python)
pinned at commit `5a6df59502dc618781b85e80b01706a19cd45828`. The oracle tool
is `scip-python@0.6.6` invoked as a one-shot indexer.

## Schema

Each file is a single YAML document with the top-level shape validated by
`corpusFileSchema` in `packages/gym/src/corpus.ts`:

- `language` — one of `python | typescript | go | rust`.
- `corpus.{name, commit, path}` — matches `manifestCorpusSchema`; `commit` is
  a 40-char SHA, `path` is relative to `packages/gym/corpus/repos/<language>/`.
- `tool.{name, version, sha256?}` — matches `manifestToolSchema`.
- `cases[*]` — list of golden cases. Each case has:
  - `id` — stable unique id (e.g. `sdk-python.callers.Agent.__init__`).
  - `kind` — `references | implementations | callers`.
  - `target.{symbolName, file, line, column}` — the request pin.
  - `expected[*]` — expected result set, same shape as `manifestResultSchema`.
  - `labeler`, `labeler_note` — provenance.
  - `waived: true` — optional, marks a case whose expected set is intentionally
    empty pending fresh labels.

At runtime the gym harness turns each case into a `ManifestRecord` (the JSONL
shape in `packages/gym/src/manifest.ts`), runs pyright, and compares.

## Migration notes

- Only spike rows whose `source` was `pyright` or `both` were carried forward.
  AST-only rows were dropped because they are heuristic false positives the
  gym is meant to flag, not verify.
- The spike did not record `column` for targets or expected entries. All
  `column` values are set to `1`; the pyright phase performs column-1 lookup
  internally.
- The spike did not record target `line` values. All target `line` values are
  set to `1` pending a follow-up pass that will pin exact definition lines
  from the fixture.
- `sdk-python.callers.BedrockModel._stream` had zero `pyright`/`both` rows in
  the spike, so its `expected` list is empty and the case is marked `waived`.
