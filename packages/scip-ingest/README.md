# @opencodehub/scip-ingest

SCIP (`.scip`) loader and per-language indexer runners for OpenCodeHub.
Upgrades heuristic-confidence graph edges to 1.0 using precise,
compiler-derived symbol information.

## Surface

```ts
import { loadScip, runScipIndexer } from "@opencodehub/scip-ingest";

// Load a pre-existing .scip index
const index = await loadScip("/path/to/index.scip");

// Run the appropriate indexer for the repo's language and produce a .scip file
await runScipIndexer({ repoRoot: "/path/to/repo", language: "typescript" });
```

- Decodes the SCIP protobuf format using `@bufbuild/protobuf`.
- The `scip-index` pipeline phase calls `runScipIndexer` for each detected
  language, then merges the outputs before the `confidence-demote` phase
  runs (`packages/ingestion/src/pipeline/phases/default-set.ts:90-95`).
- SCIP-confirmed edges carry confidence 1.0; unconfirmed heuristic edges
  are demoted to 0.2 with a `+scip-unconfirmed` reason suffix.

## Supported indexers

| Language | Indexer |
|---|---|
| TypeScript / JavaScript | `scip-typescript` |
| Python | `scip-python` |
| Go | `scip-go` |
| Java / Kotlin | `scip-java` |
| Rust | `rust-analyzer` (SCIP mode) |

Indexers are invoked as subprocesses; they must be on `PATH`. The phase
is a no-op for any language whose indexer is not installed.
