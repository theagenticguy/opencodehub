# @opencodehub/wiki

Markdown wiki renderer for OpenCodeHub. Generates architecture, API
surface, dependency map, ownership map, and risk atlas documents from the
live graph store.

## Surface

```ts
import { renderWiki } from "@opencodehub/wiki";

await renderWiki({
  store,          // StorageAdapter from @opencodehub/storage
  repoRoot: "/path/to/repo",
  outDir: "/path/to/repo/.codehub/wiki",
  views: ["architecture", "api-surface", "dependency-map", "ownership-map", "risk-atlas"],
});
```

- **`architecture`** — community clusters, process boundaries, and the top
  inter-cluster edges.
- **`api-surface`** — all exported symbols with their type signatures and
  inbound reference counts.
- **`dependency-map`** — external packages with version, license tier, and
  known CVE count.
- **`ownership-map`** — top contributors per file/cluster derived from the
  `temporal` phase's co-change data.
- **`risk-atlas`** — risk-tier heatmap over all files, sourced from the
  `risk-snapshot` phase.

## Design

- Symbol summaries are generated via `@opencodehub/summarizer` (Claude
  Haiku 4.5 on Bedrock Converse) when `--summaries` is on; otherwise the
  wiki renders without prose descriptions.
- All output files are written atomically via `write-file-atomic`.
- The `codehub wiki` CLI command calls `renderWiki` with sane defaults and
  writes output to `<repo>/.codehub/wiki/`.
