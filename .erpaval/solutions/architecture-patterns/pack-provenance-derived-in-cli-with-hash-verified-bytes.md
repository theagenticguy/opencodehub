# Pack provenance is derived in the CLI, with hash-verified disk bytes

**Category:** architecture-patterns · **Track:** knowledge
**Discovered:** session-3b8ca0 (fixing the empty-ast-chunks / hollow-manifest bug)

## The bug this fixes

`runPackEngine` (`packages/cli/src/commands/code-pack.ts`) called
`generatePack` with only `{repoPath, outDir, budgetTokens, tokenizerId}` and
**none** of the `internal` provenance opts. `generatePack` defaults them to
empty (`commit ?? ""`, `chunkerFiles ?? []`, `grammarCommits ?? {}`), so every
real pack shipped `commit:""`, `repo_origin_url:null`, an **empty
`ast-chunks.jsonl`**, `pins.chonkie_version:"unknown"`, and `grammar_commits:{}`.
The determinism receipt was hollow in production while unit fixtures (which
inject `chunkerFiles`) looked complete. Empirically caught by dumping a real
manifest — not visible from tests.

## The fix / the pattern

`generatePack` is pure-ish; its docstring says "production store lookup is
wired by the CLI". So the CLI is where production inputs get derived, threaded
through the `internal` seam:

- **commit / repoOriginUrl** — read from the singleton `Repo` node
  (`commitSha` / `originUrl`) via `graph.listNodes({kinds:["Repo"]})`. Pure
  read of the indexed state; no `git` spawn at pack time.
- **chunkerFiles** — every `File` node's bytes, read from disk and
  **hash-verified**: only include a file when `sha256(diskBytes) ===
  FileNode.contentHash`. A drifted working-tree file is skipped, so the pack
  never chunks bytes that disagree with what `analyze` indexed. This is what
  keeps the byte-identity contract honest against a dirty tree.
- **grammarCommits** — `ingestion`'s exported `parse.grammarVersions()` (reads
  the vendored `vendor/wasms/manifest.json` via the shared walk-up resolver —
  do NOT re-resolve that path from the CLI bundle; the fixed-offset trap bites).

Derivation is the **fallback path**: only fills inputs the caller did not set,
so the pack unit fixtures that inject `chunkerFiles` keep their behavior. The
resolver is defensive — a graph without `listNodes` (a bare test stub) or
without a `Repo` node yields safe empties, never a throw; packing never fails
on absent provenance.

## Verify

`analyze` + double-pack a real git repo: assert `commit`/`origin` populated,
`ast-chunks.jsonl` non-empty, context-bom `byteRanges` present, AND the pack
byte-identical across two runs. The drift-skip is unit-tested by giving the
graph one matching + one wrong `contentHash` and asserting only the match
reaches `chunkerFiles`.

## Still open (flagged, not fixed)

`pins.chonkie_version` stays `"unknown"`: chonkie's `CodeChunker` loads and
produces real strict chunks, but `defaultLoadChonkie`'s `createRequire(
"@chonkiejs/core/package.json")` version probe returns undefined in the bundled
CLI. Cosmetic version-label gap in `ast-chunker.ts`, orthogonal to this wiring.
