# New code-pack BOM items must anchor on graph nodes, not chunker data

**Category:** architecture-patterns · **Track:** knowledge
**Discovered:** session-3b8ca0 (spec 009 — context-bom read-receipt)

## The trap

`generatePack` (`packages/pack/src/index.ts`) reads
`internal.chunkerFiles ?? []`. `chunkerFiles` is supplied **only** by the
`pack-determinism.test.ts` fixture — the production CLI (`runPackEngine` in
`packages/cli/src/commands/code-pack.ts`) calls `generate(...)` **without**
it. So in production today, `buildAstChunks` runs on an empty file list and
`ast-chunks.jsonl` is written empty. Any new BOM feature that derives data
from `AstChunk` (path, startByte, endByte, tokenCount) is therefore **empty
in real packs** while looking fully populated in unit tests.

## The rule

When adding a code-pack BOM item, anchor it on data that `codehub analyze`
populates into the graph store — `File` nodes carry `filePath`, `contentHash`
(sha256), `lineCount`, `language` and ARE present in production (proven by
`buildFileTree`, which reads exactly these). Treat chunker-derived fields
(byte ranges, token counts) as **best-effort / optional** — emit them only
when present, never make them load-bearing for the item's completeness.

## Latent bug flagged (not fixed in 009)

Production `ast-chunks.jsonl` is empty because the CLI never wires
`chunkerFiles` into `generatePack`. Fixing it means reading raw file bytes in
`runPackEngine` and passing them through `internal.chunkerFiles`. Out of scope
for the receipt spec; worth its own change. Until then, byte-range coverage in
the context-bom is zero in production — by design, and the builder degrades
cleanly (omits the `byteRanges` property).

## How to verify

Build the CLI, `analyze` a tiny real git repo, `code-pack` it, and inspect the
on-disk artifact — do NOT trust the unit fixture, which injects chunker data
production never has.
