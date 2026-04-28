# ADR 0008 — The four-phase document pattern (Phase 0–E orchestration)

- Status: accepted
- Date: 2026-04-27
- Authors: Laith Al-Saadoon + Claude
- Branch: `feat/artifact-factory`

## Context

ADR 0007 committed to shipping an artifact factory inside the Claude Code
plugin. The orchestration pattern — how Claude drives the skill → precompute →
parallel subagents → assembler flow — is the hard part. It is also solvable
from prior art: a single-repo documentation skill in another project has
already validated the shape. We port that shape here with three adaptations.

The pattern is:

- **Phase 0 (pre-flight, inline in the skill)** — read the relevant graph
  artifacts plus a small number of structured queries, persist their combined
  context to `<output-dir>/.context.md` (200-line cap) and
  `<output-dir>/.prefetch.md` (a JSON ledger of tool calls with response
  digests). Subagents read these files instead of re-calling tools.
- **Phase AB (N subagents in parallel, single message with N Agent tool calls)** —
  each reads the two shared-context files first, then writes its
  section-specific files.
- **Phase CD (small number of subagents in parallel)** — diagrams plus
  specialty sections (e.g. cross-repo in group mode).
- **Phase E (inline deterministic assembler)** — regex over backtick source
  citations builds a co-occurrence index, appends `See also:` footers, writes
  `README.md` + `.docmeta.json`.

The pattern resolves the three hardest problems in generative documentation:
**prompt dedup at fan-out** (filesystem, not copy-paste), **determinism of
structure** (Phase E is LLM-free), and **refresh without full regen** (mtime
comparison against declared `data_sources`).

## Decision

Adopt the four-phase pattern for OpenCodeHub's `codehub-document` skill with
three deliberate adaptations.

### Adaptation 1 — six subagents

OpenCodeHub's supply-chain tools (`verdict`, `list_findings`, `license_audit`,
`list_dead_code`, `list_findings_delta`) pre-digest a lot of analysis output,
so we land on six subagents instead of a larger fan-out:

| Subagent | Scope |
|---|---|
| `doc-architecture` | System overview, module map, data flow |
| `doc-reference` | Public API, CLI surface, MCP tool surface |
| `doc-behavior` | Processes, state machines |
| `doc-analysis` | Risk hotspots, ownership, dead code (driven by `verdict` / `risk_trends` / `owners` / `list_dead_code`) |
| `doc-diagrams` | Mermaid diagrams (component, sequence, dependency) |
| `doc-cross-repo` | **Group mode only.** Consumes `group_contracts` + `group_query`. |

### Adaptation 2 — group mode is a first-class topology

Single-repo documentation is the bootstrap case; group mode is the wedge.
Our Phase 0 writer emits context either to `.codehub/` (single-repo) or
`.codehub/groups/<name>/` (group mode). Phase AB fans out 4 subagents per
repo in group mode — batched by role if the cardinality exceeds Claude Code's
concurrent-subagent ceiling (~10 per message, per brainstorm 004 and
spec 001 AC-5-1). Phase E builds a cross-repo link graph in addition to the
single-repo See-also footers.

### Adaptation 3 — the assembler contract

The base pattern's Phase E regex matches backtick citations in `path:LOC`
form. We extend the grammar to also match `repo:path:LOC` for group mode,
and the `.docmeta.json` schema adds a `cross_repo_refs[]` array. See ADR
0009 for the full output contract.

### Pattern invariants we preserve

- Phase 0 writes two files on disk; subagents read them before touching
  any MCP tool.
- Every subagent prompt follows an 8-section scaffold: frontmatter,
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

- **Proven pattern.** The shape has run in production elsewhere; our risk
  is adaptation, not invention.
- **Prompt dedup is a filesystem property, not a prompt-engineering
  property.** Per-subagent prompts stay small; the context lives in
  `.context.md` + `.prefetch.md`.
- **Determinism where it matters.** Phase E is regex + join. Same inputs,
  same cross-links. Prose is LLM-generated (non-deterministic), but
  structure and citations are deterministic.
- **Group mode comes for free** once the topology is named. The unique
  OpenCodeHub wedge (`group_contracts` + `group_query`) fits as a single
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

- **Pattern divergences are recorded** in this ADR and in ADR 0009.
  Internal prompt templates and references document the adaptations
  without naming the external prior art.

## References

- `docs/adr/0007-artifact-factory.md` — the parent decision
- `docs/adr/0009-artifact-output-conventions.md` — output contract
- `.erpaval/brainstorms/004-opencodehub-subagent-prompts.md` — per-agent 8-section scaffolds
- `.erpaval/brainstorms/005-opencodehub-output-conventions.md` — citation grammar + `.docmeta.json` schema
