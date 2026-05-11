# @opencodehub/sarif

SARIF v2.1.0 helpers for OpenCodeHub. Merges, enriches, and validates
SARIF outputs from multiple scanners into a single canonical result set.

## Surface

```ts
import { mergeSarif, enrichSarif, validateSarif } from "@opencodehub/sarif";

const merged = mergeSarif([semgrepSarif, betterleaksSarif, osvSarif]);
const enriched = enrichSarif(merged, { repoRoot: "/path/to/repo" });
const valid = await validateSarif(enriched); // validates against OASIS schema
```

- **`mergeSarif`** — deduplicates runs by tool name, merges result arrays,
  preserves all `ruleId` / `level` / `location` metadata.
- **`enrichSarif`** — adds `relatedLocations`, `fingerprints`, and
  `partialFingerprints` from the OpenCodeHub graph.
- **`validateSarif`** — runs the OASIS SARIF 2.1.0 JSON schema via `ajv`
  (with draft-2019-09 support).

## Design

- The `fixtures/` directory contains real SARIF outputs captured from each
  bundled scanner; the schema validation test runs against them on every build.
- Uses `zod` for internal data shapes; the public API returns plain objects
  typed against `@types/sarif`.
