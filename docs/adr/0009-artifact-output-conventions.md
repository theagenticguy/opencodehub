# ADR 0009 — Artifact output conventions (paths, citations, `.docmeta.json`, Mermaid)

- Status: accepted
- Date: 2026-04-27
- Authors: Laith Al-Saadoon + Claude
- Branch: `feat/artifact-factory`

## Context

ADR 0007 committed to shipping four artifact-generation skills. ADR 0008
locked the orchestration pattern. This ADR records the **output contract**
every generated artifact must satisfy — the on-disk shape, the citation
grammar, the `.docmeta.json` schema, and the diagram conventions.

Without a single authoritative contract, Phase E's deterministic assembler
has no regex to run against, `--refresh` cannot compare section mtimes to
source-artifact mtimes, and cross-repo `See also` footers are impossible
to compute.

## Decision

### Directory layout

**Single-repo mode** (default, no `--group`):

```
.codehub/
├── .context.md                 # Phase 0 shared context (200-line cap)
├── .prefetch.md                # Phase 0 tool-call digest ledger
└── docs/
    ├── README.md               # Landing page — written by Phase E
    ├── .docmeta.json           # Manifest (schema below)
    ├── architecture/
    │   ├── system-overview.md
    │   ├── module-map.md
    │   └── data-flow.md
    ├── reference/
    │   ├── public-api.md
    │   ├── cli.md              # Conditional (CLI package present)
    │   └── mcp-tools.md        # Conditional (MCP package present)
    ├── behavior/
    │   ├── processes.md
    │   └── state-machines.md   # Conditional
    ├── analysis/
    │   ├── risk-hotspots.md
    │   ├── ownership.md
    │   └── dead-code.md
    └── diagrams/
        ├── architecture/components.md
        ├── behavioral/sequences.md
        └── structural/dependency-graph.md
```

**Group mode** (`--group <name>` or autodetected at a group root):

Each member repo keeps its own single-repo tree at `<repo>/.codehub/docs/`.
The group tree adds cross-repo artifacts only:

```
.codehub/groups/<group-name>/
├── .context.md
├── .prefetch.md
└── docs/
    ├── README.md
    ├── .docmeta.json
    └── cross-repo/
        ├── portfolio-map.md
        ├── contracts-matrix.md
        └── dependency-flow.md
```

**`codehub-contract-map` standalone** writes to
`.codehub/groups/<name>/contracts.md` (gitignored) or `docs/<group>/contracts.md`
when invoked with `--committed`.

### Gitignored by default, `--committed` opt-in

The `.codehub/` tree is gitignored by default. The `--committed` flag on
every artifact skill writes under `docs/codehub/` (or the user-supplied
path) without adding a `.gitignore` entry. Regeneration stays safe by
default; users who want version-controlled artifacts make an active choice.

This is an exception-free rule in v1 — ADRs were the earlier proposed
exception, but `codehub-adr` moved to P1 backlog so the issue is deferred.

### Citation grammar

Every factual claim in a generated artifact carries an inline
backtick-wrapped citation. Two forms, both recognized by Phase E:

- **Single-repo**: `` `<path>:<LOC>` `` or `` `<path>:<start>-<end>` ``. File-level cites append ` (N LOC)`.
- **Group-qualified**: `` `<repo>:<path>:<LOC>` `` — **mandatory** in any file under `cross-repo/` or `contracts.md`.

#### The Phase E assembler regex

```
(?P<repo>[a-zA-Z0-9_-]+:)?(?P<path>[^\s`:]+\.[a-zA-Z0-9]+)(?::(?P<start>\d+)(?:-(?P<end>\d+))?)?(?:\s*\((?P<loc>\d+)\s*LOC\))?
```

One regex for every citation form keeps the assembler ~40 lines of
deterministic code. Matches are scanned only between backtick pairs.

### `.docmeta.json` schema

Written by Phase E at the end of every run. Drives `--refresh` and
`codehub status` staleness reporting.

```json
{
  "$schema": "https://opencodehub.dev/schemas/docmeta-v1.json",
  "generated_at": "2026-04-27T18:12:04Z",
  "codehub_graph_hash": "sha256:a1b2c3…",
  "mode": "single-repo" ,
  "repo": "opencodehub",
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

`cross_repo_refs[]` is emitted only in group mode.
`staleness_at` is copied from the `_meta.codehub/staleness` envelope on the
last MCP response the assembler observed.

### Cross-reference rules

- **Within a single repo**: if two docs share ≥ 2 citations to the same
  source files, Phase E appends `## See also` (3–5 links) to both.
  Threshold enforced by the assembler.
- **Group mode**: `cross-repo/*` files additionally receive a
  `## See also (other repos in group)` section linking into sibling repos'
  generated docs via relative paths rooted at the group directory.
- **Link form**: Markdown reference-style links, not inline URLs — keeps
  footers tidy when lists grow.
- **Dedup**: a sibling path appears at most once across both footer
  sections.

### Mermaid conventions

One diagram type per artifact. Diagrams capped at 20 nodes; overflow goes
into a legend table, never into the diagram.

| Diagram | Type | Lives in |
|---|---|---|
| Dependency graph | `flowchart LR` | `diagrams/structural/dependency-graph.md` |
| Component view | `classDiagram` | `diagrams/architecture/components.md` |
| Top process | `sequenceDiagram` | `diagrams/behavioral/sequences.md` |
| State machine | `stateDiagram-v2` | `behavior/state-machines.md` (conditional) |
| Data flow | `flowchart TB` | `architecture/data-flow.md` |

No SVG or PNG generation. Mermaid in fenced ```mermaid blocks only.

### Determinism guarantees

- **Deterministic**: file list, directory layout, section ordering,
  diagram node set, citation targets, `.docmeta.json` structure. Given
  the same `codehub_graph_hash`, two runs produce the same *structure*.
- **Non-deterministic**: prose sentences, diagram edge ordering within a
  node (Mermaid renderers stable but LLM-emitted source ordering is not),
  choice of which 3 processes to render as sequence diagrams among ties.
- **Explicit call-out**: every generated `README.md` landing page
  includes a one-line "Prose is LLM-generated; structure is graph-derived"
  note so reviewers treat the diff accordingly.

### `--refresh` algorithm

Deterministic, per-section. Avoids regenerating unchanged sections.

1. Load `.docmeta.json`.
2. Fetch current `codehub_graph_hash` from `list_repos`. If it matches
   the manifest's hash exactly, skip to step 5.
3. For each `section`:
   - Compute `max(mtime(source))` across `sources[]` (via `stat`).
   - If `max(source_mtime) > section.mtime`: mark section stale.
4. Collect the union of stale sections and their `section.agent` owners.
   Dispatch only the owning subagents; pass them a `sections_to_refresh`
   list so they write only those files.
5. Re-run Phase E over the full tree (cross-reference assembly is cheap
   and idempotent).

Source-mtime comparison is tolerant of the common case where
`codehub analyze` updates the graph but touches only a few files.
Falling back to a full regen when `graph_hash` churns avoids subtle
staleness when node IDs shift.

### Staleness signals

- **`codehub status`** reads `.docmeta.json.codehub_graph_hash` and
  compares against the live graph hash; reports `docs stale at <path>`
  when different. Bolts into the existing status command at
  `packages/cli/src/commands/status.ts`; no new command surface.
- **Phase E writes `staleness_at`** from the last MCP
  `_meta.codehub/staleness` envelope observed during assembly.
- **PostToolUse hook** (per spec 001 AC-2-8) emits a non-blocking
  `systemMessage` suggesting `/codehub-document --refresh` when the
  graph hash changes and `.docmeta.json` exists.

## Consequences

### Positive

- **Single authoritative contract.** The Phase E assembler, the `--refresh`
  algorithm, and the staleness hook all read `.docmeta.json` against one
  schema.
- **Citations are regex-inverse-indexable.** No AST, no parser, no LLM call
  for cross-referencing.
- **Gitignored default is low-friction.** Users who don't want to commit
  generated docs never have to configure anything.
- **Mermaid-only keeps docs LLM-consumable.** Every diagram round-trips
  through Claude Code's paste-as-Markdown flow without binary assets.

### Negative

- **Deterministic structure + non-deterministic prose** is a subtle
  contract. Reviewers may mistake prose variance for a generation bug.
  Mitigated by the one-line disclaimer on every `README.md`.
- **The 20-node Mermaid cap truncates very large graphs.** Overflow
  legend tables are readable but less scannable than a rendered diagram.
  Accepted tradeoff — Mermaid rendering past 40 nodes is unreliable
  across viewers.

### Neutral

- **ADR staleness exception dropped for v1.** `codehub-adr` is P1 backlog;
  when it ships, the `--committed` default will flip so the ADR
  convention (ADRs must be in git) is respected.

## References

- `docs/adr/0007-artifact-factory.md` — parent decision
- `docs/adr/0008-codeprobe-pattern-port.md` — orchestration pattern
- `.erpaval/brainstorms/005-opencodehub-output-conventions.md` — original design memo
- `.erpaval/specs/001-claude-code-artifact-surface/spec.md` — AC-4-3 (`.docmeta.json`), AC-3-4 (contract-map output), AC-7-2 (analyze-completion hint)
- `/Users/lalsaado/Projects/codeprobe/src/codeprobe/bootstrap/templates/claude-plugin/skills/document/references/cross-reference-spec.md` — pattern source
