# @opencodehub/analysis

Impact analysis, rename, change detection, and staleness primitives for
OpenCodeHub. Consumed by the MCP server and CLI; not intended for direct
use by end users.

## Surface

```ts
import { computeImpact } from "@opencodehub/analysis/impact";
import { detectChanges } from "@opencodehub/analysis/detect-changes";
import { rename } from "@opencodehub/analysis/rename";
```

- **`computeImpact`** — walks the graph from a target symbol to its
  dependents up to a configurable depth, returning a risk-tiered list of
  affected nodes (`packages/analysis/src/impact.ts`).
- **`detectChanges`** — maps an uncommitted or committed diff to the set of
  symbols that were added, removed, or modified, grouped by execution flow
  (`packages/analysis/src/detect-changes.ts`).
- **`rename`** — graph-aware multi-file rename; dry-run is the default; writes
  are gated behind `apply: true` (`packages/analysis/src/rename.ts`).
- **`staleness`** — compares the stored graph hash against the current HEAD to
  report how stale the index is (`packages/analysis/src/staleness.ts`).

## Design

- All writes use `write-file-atomic` so a crash between analyses never
  leaves a corrupt graph on disk.
- The `rename` operation validates that the proposed new name does not
  collide with any existing symbol before writing.
- Staleness is measured at call time and embedded in every MCP response as
  `_meta.codehub/staleness` so agents can surface it without an extra round-trip.
