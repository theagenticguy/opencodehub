# @opencodehub/ingestion

The indexing pipeline. Walks a repo, extracts symbols and edges via
tree-sitter (WASM by default, native opt-in), then runs a 30-phase DAG
that emits the graph and supporting artifacts under `<repo>/.codehub/`.

## Surface

```ts
import { runIngestion, DEFAULT_PHASES } from "@opencodehub/ingestion/pipeline";

await runIngestion({
  repoRoot: "/path/to/repo",
  phases: DEFAULT_PHASES,
  // ...embeddings, summaries, scan, sbom toggles
});
```

- The pipeline runs serially in topological order — determinism is
  worth more than the parallelism win at MVP scale
  (`packages/ingestion/src/pipeline/phases/default-set.ts:14-17`).
- The runner validates the DAG (missing dependencies, cycles) on every
  invocation (`packages/ingestion/src/pipeline/runner.ts`).
- Parse runtime defaults to `web-tree-sitter` (WASM); set
  `OCH_NATIVE_PARSER=1` to opt into native on Node 22 (root `CLAUDE.md`,
  Parse runtime section).

## Phases

The 30-phase ordering, sourced from
`packages/ingestion/src/pipeline/phases/default-set.ts:55-135`. Phases
group by what they read from the repo or graph.

| Group              | Phases                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Discovery          | `scan`, `profile`, `repo-node`, `structure`, `markdown`                                               |
| Parse + scope      | `parse`, `incremental-scope`, `complexity`                                                            |
| Heuristic graph    | `routes`, `openapi`, `tools`, `orm`, `cross-file`, `accesses`                                         |
| SCIP overlay       | `scip-index`, `confidence-demote`, `mro`                                                              |
| Clustering         | `communities`, `dead-code`, `processes`, `fetches`                                                    |
| Temporal           | `temporal`, `cochange`, `ownership`                                                                   |
| Supply chain       | `dependencies`, `sbom`                                                                                |
| Annotation         | `annotate`, `risk-snapshot`                                                                           |
| Optional emitters  | `summarize`, `embeddings`                                                                             |

## Design

- **Single canonical ordering** — the runner consumes `DEFAULT_PHASES`
  as the source of truth. Adding a phase is one import + one array
  entry; the DAG validator does the rest.
- **Heuristic first, SCIP overlay second** — `parse` and friends emit
  confidence-0.5 edges; `scip-index` upgrades them to 1.0 and
  `confidence-demote` drops the unconfirmed survivors to 0.2 with a
  `+scip-unconfirmed` reason suffix
  (`packages/ingestion/src/pipeline/phases/default-set.ts:90-95`).
- **Dual parser runtime** — WASM is the default for cross-platform
  determinism; the native N-API addon is opt-in for Node 22 dev boxes.
  The `complexity` phase still requires native and degrades with a
  one-shot stderr warning otherwise (root `CLAUDE.md`).
- **Silent toggles** — `summarize`, `embeddings`, `sbom`, and the
  scanner phase are no-ops unless their option is on, so a default
  `analyze` writes only the deterministic graph.
- **Phase outputs are typed** — each phase declares an output type
  consumed by `ctx.phaseOutputs[<name>]`, surfacing dependency drift at
  compile time (`packages/ingestion/src/pipeline/types.ts`).

See ADR 0013 for the storage backend the pipeline writes into and the
root README's "Embedding backends" section for the optional
`embeddings` phase.
