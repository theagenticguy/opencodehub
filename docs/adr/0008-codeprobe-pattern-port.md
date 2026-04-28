# ADR 0008 — Port the codeprobe `/document` pattern (Phase 0–E orchestration)

- Status: accepted
- Date: 2026-04-27
- Authors: Laith Al-Saadoon + Claude
- Branch: `feat/artifact-factory`

## Context

ADR 0007 committed to shipping an artifact factory inside the Claude Code
plugin. The orchestration pattern — how Claude drives the skill → precompute →
parallel subagents → assembler flow — is the hard part. It is also already
solved.

`codeprobe` (sibling OSS project at `../codeprobe/`) ships a
`/document` skill that produces 33 cross-linked Markdown files in 45–90 s via
8 parallel subagents, with a deterministic `.docmeta.json` sidecar that powers
`--refresh`. The pattern is:

- **Phase 0 (pre-flight, inline in the skill)** — read the 14 enumerated data
  artifacts plus 3 GitNexus cypher queries, persist their combined context to
  `<output-dir>/.context.md` (200-line cap) and `<output-dir>/.gitnexus-prefetch.md`.
  Subagents read these files instead of re-calling tools.
- **Phase AB (6 subagents in parallel, single message with 6 Agent tool calls)** —
  each reads the two shared-context files first, then writes its section-specific
  files.
- **Phase CD (2 subagents in parallel)** — diagrams + migration.
- **Phase E (inline deterministic assembler)** — regex over backtick source
  citations builds a co-occurrence index, appends `See also:` footers, writes
  `README.md` + `.docmeta.json`.

The pattern resolves the three hardest problems in generative documentation:
**prompt dedup at fan-out** (filesystem, not copy-paste), **determinism of
structure** (Phase E is LLM-free), and **refresh without full regen** (mtime
comparison against declared `data_sources`).

## Decision

Adopt codeprobe's four-phase pattern for OpenCodeHub's `codehub-document` skill
with three deliberate adaptations.

### Adaptation 1 — six subagents, not eight

codeprobe runs 8 doc-* subagents. OpenCodeHub's supply-chain tools
(`verdict`, `list_findings`, `license_audit`, `list_dead_code`,
`list_findings_delta`) pre-digest a lot of analysis output, so we
consolidate into six:

| Subagent | Replaces / consumes |
|---|---|
| `doc-architecture` | codeprobe's `doc-architecture` |
| `doc-reference` | codeprobe's `doc-reference` + exports from SCIP |
| `doc-behavior` | codeprobe's `doc-behavior` + route/tool inventories |
| `doc-analysis` | codeprobe's `doc-technical-debt` + `doc-analysis`, driven by `verdict` / `risk_trends` / `owners` / `list_dead_code` |
| `doc-diagrams` | codeprobe's `doc-diagrams` |
| `doc-cross-repo` | **new** — group mode only. Consumes `group_contracts` + `group_query`. |

### Adaptation 2 — group mode is a first-class topology

codeprobe is single-repo only. Our Phase 0 writer emits context either to
`.codehub/` (single-repo) or `.codehub/groups/<name>/` (group mode). Phase AB
fans out 4 subagents per repo in group mode — batched by role if the
cardinality exceeds Claude Code's concurrent-subagent ceiling (~10 per
message, per brainstorm 004 and spec 001 AC-5-1). Phase E builds a
cross-repo link graph in addition to the single-repo See-also footers.

### Adaptation 3 — the assembler contract

codeprobe's Phase E regex matches backtick citations in `path:LOC` form.
We extend the grammar to also match `repo:path:LOC` for group mode, and
the `.docmeta.json` schema adds a `cross_repo_refs[]` array. See ADR 0009
for the full output contract.

### Pattern invariants we preserve verbatim

- Phase 0 writes two files on disk; subagents read them before touching
  any MCP tool.
- Every subagent prompt follows codeprobe's 8-section scaffold: frontmatter,
  output files, input specification, process, document format rules, tool
  usage guide, fallback paths, quality checklist.
- Phase E is **deterministic Markdown assembly, no LLM call**. Regex → join →
  footer → manifest.
- `.docmeta.json` is the source of truth for `--refresh`. Mtime comparison
  against `section.sources[]` decides what to regenerate.
- No YAML frontmatter on generated outputs. H1 is the identifier.
- Generated docs have backtick source citations (`` `path:LOC` `` or
  `` `repo:path:LOC` ``).

## Consequences

### Positive

- **Proven pattern.** codeprobe has run it in production. Risk is
  adaptation, not invention.
- **Prompt dedup is a filesystem property, not a prompt-engineering
  property.** Per-subagent prompts stay small; the context lives in
  `.context.md` + `.prefetch.md`.
- **Determinism where it matters.** Phase E is regex + join. Same inputs,
  same cross-links. Prose is LLM-generated (non-deterministic), but
  structure and citations are deterministic.
- **Group mode comes for free** once the topology is named. The unique
  codehub wedge (`group_contracts` + `group_query`) fits as a single
  additional subagent.

### Negative

- **Subagent tool sprawl.** Each doc-* carries 6–10 MCP tools plus
  Read/Write/Grep/Glob. Context-bloat-from-tool-metadata is the realistic
  failure mode, not bad prompts. Mitigation is baked into the subagent
  prompts: each opens with "do not re-call tools whose digest is in
  `.prefetch.md`" plus a Tool Usage Guide table.
- **Parallel subagent ceiling.** Claude Code caps concurrent Agent calls
  at ~10 per message. Groups of 3+ repos require role-batched dispatch
  (all `doc-architecture` first, then `doc-behavior`, etc.). Verified
  against the current Claude Code release when `codehub-document --group`
  ships.

### Neutral

- **codeprobe stays the pattern source.** We cite it in subagent prompts
  and the skill README. Pattern divergences are recorded here and in ADR
  0009.

## References

- `docs/adr/0007-artifact-factory.md` — the parent decision
- `docs/adr/0009-artifact-output-conventions.md` — output contract
- `.erpaval/brainstorms/004-opencodehub-subagent-prompts.md` — per-agent 8-section scaffolds
- `.erpaval/brainstorms/005-opencodehub-output-conventions.md` — citation grammar + `.docmeta.json` schema
- `../codeprobe/src/codeprobe/bootstrap/templates/claude-plugin/skills/document/SKILL.md` — pattern source
- `../codeprobe/src/codeprobe/bootstrap/templates/claude-plugin/agents/doc-*.md` — 8-section scaffold reference
