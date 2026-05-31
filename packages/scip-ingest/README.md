# @opencodehub/scip-ingest

SCIP (`.scip`) loader and per-language indexer runners for OpenCodeHub.
Upgrades heuristic-confidence graph edges to 1.0 using precise,
compiler-derived symbol information.

## Surface

```ts
import { readFileSync } from "node:fs";
import {
  buildSymbolDefIndex,
  deriveIndex,
  parseScipIndex,
  runIndexer,
} from "@opencodehub/scip-ingest";

// Run the per-language indexer; it writes <outputDir>/<lang>.scip and
// reports whether it ran or was skipped (missing tool, timeout, etc.).
const result = await runIndexer("typescript", {
  projectRoot: "/path/to/repo",
  outputDir: "/path/to/repo/.codehub/scip",
});

// Decode the .scip bytes the caller reads, then derive caller->callee edges.
if (!result.skipped) {
  const index = parseScipIndex(readFileSync(result.scipPath));
  const derived = deriveIndex(index);
  const defs = buildSymbolDefIndex(index);
  // `derived.edges` are graph-ready DerivedEdge values; `defs` maps each
  // SCIP symbol to its defining document + range.
}
```

- Decodes the SCIP protobuf format with a hand-rolled minimal protobuf wire
  reader (`src/proto-reader.ts`) — zero runtime dependencies, no codegen.
- `runIndexer(kind, opts)` shells out to the per-language SCIP indexer and
  returns an `IndexerResult` (`{ kind, scipPath, tool, version, skipped,
  skipReason?, durationMs }`). A missing indexer, a deliberate `timeoutMs`
  hit, or an unmet preflight surfaces as `skipped: true` with a `skipReason`
  rather than throwing.
- The `scip-index` pipeline phase fans `runIndexer` out across the languages
  reported by `detectLanguages`, then merges the parsed outputs before the
  `confidence-demote` phase runs.
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
