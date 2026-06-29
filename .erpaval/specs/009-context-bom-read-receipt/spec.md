# Spec 009 — Context BOM (the agent's read-receipt)

**Status:** Draft · **Author:** Bonk + Laith · **Date:** 2026-06-29
**Branch:** `spec/009-context-bom-read-receipt` (off `main` @ `36e1ee1`)
**Roadmap origin:** M-W-F roadmap run 2026-06-29, Move 1 (pursue-first).

---

## 1. Diagnosis (why now)

The most-starred MCP code-graph rival, `DeusData/codebase-memory-mcp` (CBM,
20,808★ verified 2026-06-29, MIT), shipped SLSA L3 + Sigstore cosign +
CycloneDX SBOM over the weekend. That moves the compliance/provenance
vocabulary OCH has owned into the highest-traction competitor's README —
but CBM's provenance is over its **binary**, not over the context it feeds
the model. No tool in the field signs *what the agent actually read*.

OCH's current `packHash` (on `main`, `packages/pack/src/manifest.ts`) hashes
the **8 output artifacts** of the BOM (manifest, skeleton, file-tree, deps,
ast-chunks, xrefs, findings, licenses). It does not emit a record of the
**source input set** — the exact files and byte ranges that were read out of
the repo to build that pack. An auditor cannot answer "which bytes of my
source did the agent see?" from a packHash alone; they can only confirm the
output artifacts reproduce.

The raw material already exists and is **populated in production**: `FileNode`
(`packages/core-types/src/nodes.ts`) carries `{ filePath, contentHash,
lineCount, language }` for every indexed file, and `buildFileTree`
(`packages/pack/src/file-tree.ts`) already reads exactly these, sorted by
`path ASC`, byte-stable. We are not computing new data — we are **promoting an
existing internal record into a signed, queryable, compliance-shaped BOM item**.

> **Grounding correction (Explore phase, F1/F3).** The original draft anchored
> on `AstChunk` byte ranges. Two facts overrode that: (1) `generatePack` only
> receives `chunkerFiles` in the determinism *test* fixture — production
> `runPackEngine` never sets it, so `ast-chunks.jsonl` is empty in prod (a
> latent bug, flagged not fixed here). (2) There is no per-source-file SPDX
> license anywhere on the graph; `buildLicenses` classifies *dependency*
> licenses. So the receipt anchors on **File nodes** (always populated), byte
> ranges are **best-effort** (emitted only when chunker data is present), and
> per-file license is **deferred to roadmap Move 5**.

`code-pack --prove` / `codehub replay` do **not** exist on `main` — they live
in open omnibus PR #243 (+6071/−161, 69 files, Docker + receipts + MCP
conformance + SCIP/LSP breadth). This spec is deliberately **scoped narrower
than #243** and independent of it: it adds one BOM item and one read-path,
no Docker, no MCP rewrite, no signing infrastructure. If #243 lands first,
`--prove`'s attestation subject simply gains a second digest (the
context-BOM hash); if this lands first, #243's `--prove` picks it up. The two
do not conflict.

## 2. Guiding policy

Stop selling the adjective ("deterministic") and the dead differentiator
("we have a graph"). Ship the one object nobody else produces: **a signed,
re-derivable, license-aware record of the exact source bytes the agent
consumed** — a read-receipt for the context window.

The contract this establishes: *given the same `(commit, budget, tokenizer,
pins)`, the set of source files and byte ranges read to build the pack is
byte-identical and third-party re-derivable* — independent of whether the
output artifacts' formatting ever changes.

## 3. Coherent action (what we build)

### 3.1 New BOM item: `context-bom`

A 9th BOM item, `context-bom.json`, emitted by a new builder
`packages/pack/src/context-bom.ts`. It is a CycloneDX-1.6 document
(`bomFormat: "CycloneDX"`, `specVersion: "1.6"`, `version: 1`, static
`$schema`) whose `components` are the **source files the pack indexed** —
one component per `FileNode`, sorted by path ASC:

| Field | Source | Notes |
|---|---|---|
| `type` | `"file"` | CycloneDX component type (required) |
| `name` | `FileNode.filePath` (repo-relative POSIX) | required; one component per file |
| `bom-ref` | `FileNode.filePath` | stable path-derived ref (deterministic, not random) |
| `hashes[].alg/content` | `SHA-256` + `FileNode.contentHash` | omitted when `contentHash` absent |
| `properties[opencodehub:lineCount]` | `FileNode.lineCount` | stringified |
| `properties[opencodehub:language]` | `FileNode.language` | omitted when absent |
| `properties[opencodehub:byteRanges]` | merged `[startByte,endByte)` spans from `AstChunk` **when chunker data is present** | best-effort; absent in the prod-default empty-chunker case (F1) |

Per-file SPDX license is **out of scope** (F3 — no per-file license on the
graph; deferred to Move 5). The document is canonicalized with the **same
RFC 8785 `canonicalJson`** machinery the manifest uses, so it is byte-identical
across runs and its own SHA-256 (`contextBomHash`) is stable. Determinism-fatal
fields (`serialNumber`, `metadata.timestamp`, any run-id) are never emitted.

### 3.2 Manifest binds the context-BOM

`PackManifest` gains one field, `contextBomHash: string` (sha256 hex of the
canonical `context-bom.json`). Because `packHash` is computed over the
manifest's canonical form, **the context-BOM hash is transitively covered by
`packHash`** — tamper with one read byte-range and `packHash` changes. This
is the binding that makes the read-receipt part of the reproducibility
contract rather than a detached sidecar. `schemaVersion` bumps `1 → 2`.

`BomItem.kind` union gains `"context-bom"`; the item is appended to the BOM
file list in `generatePack`.

### 3.3 Read path: `codehub pack --explain-context`

A read-only CLI flag on the existing `code-pack` command that prints (or
emits `--json`) a human summary of the context-BOM: file count, total bytes
read, total tokens, top-N files by token contribution, and any
`NOASSERTION` / copyleft license flags. No new command, no server, no
hard-rail break — it reads the `context-bom.json` already written to `outDir`.

### 3.4 Out of scope (deliberately)

- **Signing / cosign / in-toto** — that is #243's `--prove`. This spec emits
  the *content*; #243 (or a later spec) signs it.
- **MCP tool surface** — no new MCP tool this increment. (A future
  `context_receipt` query tool is a follow-on once the format is proven.)
- **AI-authorship attribution** — that is roadmap Move 5 (per-symbol git
  authorship + contamination), a separate spec. Move 1 ships the *file/byte*
  receipt; Move 5 layers symbol provenance on top.
- **HTTP / verify-serve** — explicitly not this spec (hard-rail #2 holds).

## 4. EARS requirements

- **R1** WHEN `generatePack` assembles a pack, the system SHALL emit a 9th
  BOM item `context-bom.json` listing one CycloneDX `file` component per
  indexed `FileNode`, sorted by path ASC, each carrying its SHA-256
  `contentHash` (when present), `lineCount`, and `language`.
- **R2** WHEN two packs are generated from the same `(commit, budget,
  tokenizer, pins)`, the system SHALL produce byte-identical `context-bom.json`
  (same `contextBomHash`).
- **R3** WHEN any file hash, line count, or byte-range in the context-BOM
  differs, the system SHALL produce a different `packHash` (transitive
  binding via the manifest preimage).
- **R4** WHERE a `FileNode` lacks `contentHash`, the system SHALL omit the
  `hashes` array for that component rather than emit a placeholder hash
  (a fabricated hash would be a false provenance claim).
- **R5** WHEN a user runs `codehub code-pack --explain-context [--json]`, the
  system SHALL print a summary (file count, total lines, files-with-hash count,
  per-language breakdown) read from the on-disk `context-bom.json` without
  re-running the pack.
- **R6** WHERE the AST chunker produced no byte-range data (the production
  default today, F1), the system SHALL still emit a complete context-BOM over
  File nodes and SHALL omit the `byteRanges` property rather than emit empty
  ranges.
- **R7** The `context-bom.json` SHALL validate against CycloneDX 1.6
  (`bomFormat: "CycloneDX"`, `specVersion: "1.6"`, every `components[]` entry
  well-formed with `type` + `name`).

## 5. Reversibility / blast radius

- **Additive.** New file `context-bom.ts`, one new builder call in
  `index.ts`, one new manifest field, one CLI flag. No existing BOM item
  changes shape.
- **Schema bump `1 → 2`** is the only contract change; gated by a
  `pack-determinism.test.ts` golden-hash update. Old packs (schema 1) remain
  readable; `--explain-context` no-ops with a clear message on a schema-1 pack.
- **No native deps, no new runtime deps** — reuses `sha256Hex`/`canonicalJson`
  from `core-types` and the existing `licenses` builder output.

## 6. Acceptance / done

1. `mise run build && mise run typecheck && mise run test` green (all 3 CI legs).
2. New `context-bom.test.ts`: determinism (R2), transitive binding (R3),
   `NOASSERTION` path (R4), degraded path (R6), CycloneDX shape (R7).
3. `pack-determinism.test.ts` golden hashes updated for schema 2.
4. `codehub pack --explain-context` on this repo prints a non-empty receipt;
   `--json` validates as CycloneDX 1.6.
5. `banned-strings` + `licenses` + `sarif-validate` CI checks pass.
6. One PR, squash-merge, scope `pack`. Body cites this spec + roadmap Move 1.

## 7. Files touched (estimate)

| File | Change |
|---|---|
| `packages/pack/src/context-bom.ts` | **new** — builder + canonical serializer |
| `packages/pack/src/context-bom.test.ts` | **new** — R2/R3/R4/R6/R7 |
| `packages/pack/src/types.ts` | `BomItem.kind` += `context-bom`; `PackManifest.contextBomHash`; `schemaVersion: 2` |
| `packages/pack/src/manifest.ts` | thread `contextBomHash` into preimage + snake_case wire |
| `packages/pack/src/index.ts` | build + write `context-bom.json`, append BOM item |
| `packages/pack/src/manifest.test.ts` | schema-2 assertions |
| `packages/pack/src/pack-determinism.test.ts` | golden-hash refresh |
| `packages/cli/src/commands/code-pack.ts` | `--explain-context [--json]` read path |
| `packages/cli/src/commands/code-pack.test.ts` | flag coverage |

Net: ~2 new files, ~7 touched. Self-contained, one reviewer, no #243 dependency.
