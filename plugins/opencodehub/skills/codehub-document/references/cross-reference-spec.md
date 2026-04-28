# cross-reference-spec — Phase E algorithm + `.docmeta.json` schema + `--refresh`

Phase E is **deterministic Markdown assembly**. No LLM call. Pure regex + join + write.

## Citation grammar

Every factual claim carries an inline backtick citation. Two forms, both recognized by the assembler:

- **Single-repo**: `` `<path>:<LOC>` `` or `` `<path>:<start>-<end>` ``. File-level cites append ` (N LOC)`.
- **Group-qualified**: `` `<repo>:<path>:<LOC>` `` — **mandatory** in any file under `cross-repo/` or `contracts.md`.

### The Phase E regex

```
(?P<repo>[a-zA-Z0-9_-]+:)?(?P<path>[^\s`:]+\.[a-zA-Z0-9]+)(?::(?P<start>\d+)(?:-(?P<end>\d+))?)?(?:\s*\((?P<loc>\d+)\s*LOC\))?
```

The assembler scans only between backtick pairs — never raw prose.

## Algorithm

1. **Walk** every `.md` file under the output tree (excluding the precompute files).
2. **Extract** every citation matching the regex between backtick pairs.
3. **Build** the co-occurrence index: `source_file → [docs_citing_it]`.
4. **For each doc**, compute its set of siblings: docs that share ≥ 2 common source citations.
5. **Rank** siblings by shared-citation count, then alphabetically. Take the top 3–5.
6. **Append** a `## See also` footer to every doc with ≥ 1 sibling. Use Markdown reference-style links, not inline URLs.
7. **Group mode**: for every `cross-repo/*.md` file, additionally append `## See also (other repos in group)` listing relative paths into sibling repos' generated docs (e.g., `../../billing/.codehub/docs/reference/public-api.md`).
8. **Dedup** sibling paths across both footer sections.
9. **Strip** any YAML frontmatter blocks on generated docs and record a `frontmatter_removed: [<path>]` entry in `.docmeta.json` (per spec AC-5-3).
10. **Write** `README.md` (landing page with the "Prose is LLM-generated; structure is graph-derived" disclaimer) and `.docmeta.json` (schema below).

## `.docmeta.json` schema

```json
{
  "$schema": "https://opencodehub.dev/schemas/docmeta-v1.json",
  "generated_at": "2026-04-27T18:12:04Z",
  "codehub_graph_hash": "sha256:a1b2c3…",
  "mode": "single-repo",
  "repo": "opencodehub",
  "group": null,
  "staleness_at": "2026-04-27T18:12:04Z",
  "sections": [
    {
      "path": "architecture/system-overview.md",
      "agent": "doc-architecture",
      "sources": [
        "packages/mcp/src/server.ts",
        "packages/mcp/src/index.ts"
      ],
      "mtime": "2026-04-27T18:11:58Z",
      "citation_count": 18,
      "mermaid_count": 1
    }
  ],
  "cross_repo_refs": [],
  "frontmatter_removed": []
}
```

Group mode populates `cross_repo_refs[]`:

```json
{
  "cross_repo_refs": [
    {
      "repo": "billing",
      "from_doc": "cross-repo/contracts-matrix.md",
      "to_doc": "../../../billing/.codehub/docs/reference/public-api.md",
      "contract_count": 4
    }
  ]
}
```

`staleness_at` is copied from the `_meta.codehub/staleness` envelope on the last MCP response the assembler observed.

## `--refresh` algorithm

1. Load `.docmeta.json` from the existing output tree.
2. Fetch the current `codehub_graph_hash` from `mcp__opencodehub__list_repos`. If it matches the manifest's hash exactly, skip to step 5.
3. For each `section` in the manifest:
   - Compute `max(mtime(source))` across `sections[i].sources[]` via `stat`.
   - If `max(source_mtime) > sections[i].mtime`: mark the section stale.
4. Collect the union of stale sections and their owners (`section.agent`). Dispatch only those subagents; pass them a `sections_to_refresh` list so they write only those files.
5. Always re-run Phase E over the full tree (cross-reference assembly is cheap and idempotent).

The algorithm is **tolerant of the common case** where `codehub analyze` updates the graph but touches only a few files. Falling back to a full regen when `graph_hash` churns avoids subtle staleness when node IDs shift.

## Determinism call-outs

- **Deterministic**: file list, directory layout, section ordering, diagram node set, citation targets, `.docmeta.json` structure.
- **Non-deterministic**: prose sentences, diagram edge ordering within a node, choice of which 3 processes get sequence diagrams among ties.

Generated `README.md` includes the one-line disclaimer: *"Prose is LLM-generated; structure is graph-derived. Phase E cross-references are deterministic."*

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `See also` footer points at a missing file | Phase AB wrote a partial file, Phase E saw the citation but the target was orphaned | Re-run `--refresh` on the owning section |
| A group-mode `cross-repo/` file has a plain `path:LOC` citation | `doc-cross-repo` slipped on the grammar rule | Update the subagent's Quality Checklist enforcement; add the bad line to the agent's prompt |
| `.docmeta.json.frontmatter_removed` is non-empty | A subagent emitted YAML frontmatter despite the rule | The assembler stripped it; no user action needed, but fix the subagent |
| `--refresh` regenerated everything unexpectedly | `graph_hash` changed (node IDs shifted) | Expected behavior on re-analyze; not a bug |
