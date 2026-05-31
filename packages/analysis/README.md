# @opencodehub/analysis

Impact analysis, change detection, and staleness primitives for
OpenCodeHub. Consumed by the MCP server and CLI; not intended for direct
use by end users. Every primitive is **read-only with respect to user
source** — analysis reads the graph and reports; it never edits the
working tree.

## Surface

```ts
import { runImpact } from "@opencodehub/analysis";
import { runDetectChanges } from "@opencodehub/analysis";
import { computeStaleness } from "@opencodehub/analysis";
```

- **`runImpact`** — walks the graph from a target symbol to its
  dependents up to a configurable depth, returning a risk-tiered list of
  affected nodes (`packages/analysis/src/impact.ts`).
- **`runDetectChanges`** — maps an uncommitted or committed diff to the set of
  symbols that were added, removed, or modified, grouped by execution flow
  (`packages/analysis/src/detect-changes.ts`).
- **`computeStaleness`** — compares the stored graph hash against the current
  HEAD to report how stale the index is (`packages/analysis/src/staleness.ts`).

## Design

- Analysis primitives are pure reads over the graph and temporal stores;
  the package writes only its own derived artifacts (e.g. risk snapshots
  via `write-file-atomic`), never user source files.
- Staleness is measured at call time and embedded in every MCP response as
  `_meta.codehub/staleness` so agents can surface it without an extra round-trip.
