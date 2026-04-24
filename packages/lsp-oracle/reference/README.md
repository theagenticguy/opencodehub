# lsp-oracle reference spikes

These are the two spikes that established the contract and wire-level
behavior for `@opencodehub/lsp-oracle`. They are preserved here as
documentation — not runtime code — so the design record stays close to
the package it motivated. The TypeScript implementation in `src/` is a
port of the second spike; the first is kept as the negative result that
motivated the rewrite.

| File | Stack | What it proved |
|---|---|---|
| `spike-01-multilspy-jedi.py` | `multilspy==0.0.15` + jedi-language-server + duckdb | multilspy at this version ships jedi, NOT pyright, despite the docs implying otherwise. `callHierarchy/incomingCalls` returns empty on every query; `prepareCallHierarchy` is partially broken. References work but recall is poor on cross-module calls. Per-symbol latency ~1.8s — jedi is interpreter-driven and slow. First spike that made the tradeoff concrete: we need a typed LSP backend. |
| `spike-02-pyright-langserver.py` | raw LSP over stdio (hand-rolled) + `pyright==1.1.390` + duckdb | Drives pyright-langserver directly over a hand-rolled Content-Length framing client (pygls doesn't ship a first-class LSP *client*). On the same 15-symbol sample against sdk-python: pyright returned **2.3× more references** than jedi, `callHierarchy/incomingCalls` actually works (20 total callers vs jedi's 0), and cold start is ~4s but every per-symbol query averages 0.08s after that. Surfaced the constructor quirk: pyright attaches references-to-a-constructor onto the *class* symbol, not `__init__`. |

## Key facts the spikes established

- **multilspy 0.0.14/0.0.15 does NOT ship pyright.** It ships jedi-language-
  server, which has broken / empty call-hierarchy support. Anyone reaching
  for "multilspy because it bundles pyright" will be surprised.
- **pyright-langserver via raw LSP stdio is the right primitive.** The
  framing protocol is tiny (Content-Length + JSON body) and a hand-rolled
  client is ~200 lines. Running pyright directly avoids the wrapper-library
  lag between pyright releases and multilspy bumps.
- **`callHierarchy/incomingCalls` works in pyright, not in jedi.** On the
  sdk-python sample, pyright returned 20 incoming-call edges across 15
  symbols; jedi returned 0. Any oracle intended to populate CALLS edges
  in a code graph must use pyright.
- **Per-symbol latency: ~0.08s pyright vs ~1.8s jedi** — a 22× speedup
  per query once pyright is warm.
- **Cold start: pyright ~4s (vs jedi <1s).** Pyright pays more upfront
  because it scans and indexes the workspace; every query after that is
  cheap. Jedi is lazy: fast to start, slow per query. For an ingestion
  pipeline that asks hundreds of queries per session, the pyright tradeoff
  is strictly better.
- **Constructor references attach to the class, not `__init__`.** When a
  caller writes `Foo(...)`, pyright records a reference to `class Foo`,
  not to `Foo.__init__`. A naive query against the `__init__` line
  returns empty. `PyrightClient.queryCallers` handles this automatically:
  if `symbolKind === "method"` and `symbolName` ends in `.__init__` and
  the direct call-hierarchy returns empty, the client locates the
  enclosing `class Foo` header and re-queries there.
- **References recall improves dramatically with a resolvable venv.**
  Without `pythonPath`, pyright only knows its bundled stdlib, so third-
  party references (boto3, pydantic, etc.) don't resolve. The client
  auto-detects `${workspaceRoot}/.venv/bin/python` or `.../venv/...`;
  callers can attach the resolution mode from `getStatus()` to edge
  provenance.

## Running the spikes

Both spikes use PEP 723 inline deps and run under `uv`:

```bash
uv run packages/lsp-oracle/reference/spike-01-multilspy-jedi.py
uv run packages/lsp-oracle/reference/spike-02-pyright-langserver.py
```

The pyright spike writes `/tmp/spike-pyright-oracle-report.json`, which
the TypeScript validation script (`scripts/validate-lsp-oracle.ts`) reads
as the reference to compare against.

## When to come back here

Read the spikes when:

- A pyright minor version ships and you suspect the call-hierarchy or
  references behavior changed. Re-run spike 02 against the same symbol
  sample and diff against the committed JSON.
- You're investigating why a specific symbol has empty / wrong callers
  in the TS client. The Python spike is the simplest reproducer you can
  point at the problem — it's 1,700 lines of flat procedural code, no
  abstraction to step over.
- You're porting the oracle to a new language server (basedpyright,
  ruff-lsp, jedi-language-server in a newer version). The spikes are
  the minimum-viable harness for checking references + call-hierarchy +
  implementations end-to-end against a known-good graph.
- You need to add a new LSP method to the TS client (semantic tokens,
  document symbols, workspace symbols). Extend spike 02 first to
  validate pyright's behavior on the wire before writing the TS code.
