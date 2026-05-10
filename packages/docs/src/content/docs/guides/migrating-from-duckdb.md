---
title: Migrating from DuckDB to LadybugDB
description: Move an existing OpenCodeHub index from the legacy DuckDB single-file layout to the default LadybugDB + DuckDB temporal layout.
sidebar:
  order: 75
---

If you indexed a repo before the M7 default-flip, your `.codehub/`
holds a single `graph.duckdb` file. The default backend is now
**LadybugDB + DuckDB temporal** (two artifacts:
`graph.lbug` + `temporal.duckdb`). This guide covers the migration
options.

## Option A — re-index from scratch

The simplest path. Throws the legacy artifact away, runs the full
pipeline against HEAD, writes the new layout.

```bash title="re-index a repo into the default backend"
codehub clean
codehub analyze
```

`codehub analyze` defaults to `CODEHUB_STORE=auto`, which probes
`@ladybugdb/core` and uses LadybugDB when the binding is importable.
The graph hash will match what the legacy DuckDB layout would have
produced at the same commit (the M7 parity gate enforces this), so
downstream tooling does not see drift.

Trade-off: full re-index time. On a 100k-LOC repo that is single-digit
minutes; on a 500k-LOC repo it can be 10–20 minutes depending on the
machine.

## Option B — keep both artifacts, let the resolver pick

`codehub analyze` will not delete a sibling artifact. If you run
`codehub analyze` while `.codehub/graph.duckdb` exists, the new run
writes `graph.lbug` + `temporal.duckdb` alongside it. From that
moment, **the newer-mtime file wins** when both exist.

To force the legacy backend explicitly during a migration window:

```bash
CODEHUB_STORE=duck codehub analyze
```

This is useful if you need to keep an older script reading
`graph.duckdb` directly — but the moment you move to OCH-driven tools
(`codehub query`, MCP tools, `verdict`), `CODEHUB_STORE=duck` is the
only way to keep them on the legacy file.

To force LadybugDB explicitly (and refuse the fallback):

```bash
CODEHUB_STORE=lbug codehub analyze
```

This **throws** if `@ladybugdb/core` is not importable, instead of
silently dropping back to DuckDB. Useful in CI to guarantee a
specific layout.

## Option C — run on the legacy DuckDB layout indefinitely

The legacy single-file DuckDB layout is supported. Set
`CODEHUB_STORE=duck` in your environment and every `codehub
analyze` / `codehub query` / MCP tool / scanner emission stays on
the legacy path:

```bash title="opt out of the M7 flip permanently"
export CODEHUB_STORE=duck
```

This is the right choice if your deployment cannot install
`@ladybugdb/core` (locked-down npm registry, air-gapped CI image,
unsupported platform). The graph hash, the MCP surface, the SARIF
output, and the determinism contract all hold on the legacy layout.

Trade-off: the M3+ workload performance improvements that motivated
the M7 flip are not available — recursive-CTE traversals on the
polymorphic `relations` table do not get faster than they were in
v1.0.

## Verifying the migration

```bash title="confirm the active backend"
codehub status
```

`status` reports the artifact path (`graph.lbug` or `graph.duckdb`)
and the graph hash. If the same commit produced different hashes on
the two backends, the M7 parity invariant is broken — file an issue
with the `meta.json` from each `.codehub/`.

## Edge cases

### Both `graph.lbug` and `graph.duckdb` exist

The newer-mtime file wins. If you need to force one:

```bash
# Force the graph-database backend regardless of mtime.
CODEHUB_STORE=lbug codehub status

# Force the legacy file regardless of mtime.
CODEHUB_STORE=duck codehub status
```

To delete the unused sibling once the migration is complete:

```bash
rm .codehub/graph.duckdb       # if you migrated to the graph-database backend
# or
rm .codehub/graph.lbug .codehub/temporal.duckdb   # if you stayed on legacy
```

### Embedder model mismatch

If you re-index with a different embedder than the original (e.g.
switching from local ONNX to a SageMaker endpoint), the embeddings
table inherits the modelId of whichever embedder ran last. The query
path refuses with `EMBEDDER_MISMATCH` rather than silently misranking;
ADR 0014 covers the contract. Pass the documented force flag if you
intend to mix embedders.

### CI parity

If you run a CI matrix that exercises both backends, set
`CODEHUB_STORE=lbug` on one job and `CODEHUB_STORE=duck` on the
other. The M7 parity gate compares the hashes at the same commit and
fails the build on drift.

## See also

- [Storage backend](/opencodehub/architecture/storage-backend/) — the
  resolver, the dual-artifact precedence rule, the community-adapter
  escape hatch.
- [ADR 0013 (M7)](https://github.com/theagenticguy/opencodehub/blob/main/docs/adr/0013-m7-default-flip-and-abstraction.md)
  — the decision and the parity gate.
- [Configuration](/opencodehub/reference/configuration/#storage-backend)
  — the env var inventory.
