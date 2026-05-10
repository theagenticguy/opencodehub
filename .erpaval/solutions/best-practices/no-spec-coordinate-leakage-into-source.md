---
name: ERPAVal spec coordinates (CL-*, AC-*, M-*, W-*) MUST NOT leak into production source or comments
description: Specifier prefixes from EARS specs and the ERPAVal classifier vocabulary are session-local bookkeeping; production code, comments, JSDoc, and CLI/MCP option descriptions must not reference them
type: feedback
---

ERPAVal specs use a structured vocabulary — `AC-A-1`, `AC-C-3`, `M3-1`,
`W-A-2`, `E-C-3`, `CL-VALIDATE`, `S-A-2`, `architecture-revised.md
§AC-A-7` — to coordinate work across the orchestrator and Act
subagents. These prefixes are useful inside ERPAVal artifacts:
`.erpaval/specs/`, `.erpaval/sessions/<id>/`, ADR validation tables,
commit messages, PR bodies. They are NOT useful in production source.

Observed leakage on Track C cleanup (2026-05-09): the orchestrator and
multiple Act subagents seeded `AC-C-3:`, `AC-C-2:`, `AC-A-1:`, `AC-A-6c:`,
`AC-A-9:` into JSDoc, inline comments, MCP tool option descriptions
(visible to every MCP client), and CLI flag help (visible to every
`codehub query --help` user). Counts after Wave C.1 + my Wave C.2 first
pass: ~45 source references to AC-A-* (legacy from Track A — already
on main via PR #71), 14 source references to AC-C-* introduced this
session before sweep.

**Why:** session-local coordinates rot. Six months after the AC graduates
into a release, the spec packet is in `.erpaval/sessions/session-<hex>/`
which is gitignored — readers of the source can't follow the citation.
The MCP option description "Bypass the embedder fingerprint check
(AC-C-3)." leaks ERPAVal vocabulary into the MCP tool surface, which
LLM clients then pick up and start citing back; the leakage compounds.

**How to apply:**

- **Source comments / JSDoc:** name the underlying invariant, behavior,
  or contract. "Refuse when the persisted embedder modelId differs from
  the current one" is forever; "AC-C-3 refusal" is until the AC merges
  and then forgets itself.
- **Variable names, function names, type fields:** never carry the prefix.
  `forceBackendMismatch` (good) not `acC3ForceBackendMismatch` (never).
- **CLI help / MCP descriptions / tool descriptions:** describe the
  user-visible contract. The user does not know what an AC is. Strip.
- **ADR text:** ADRs MAY cite AC-* coordinates because the ADR is the
  permanent home of the decision rationale and links to the spec packet.
  But cite once, in a "References" section, not inline throughout the
  decision body.
- **Commit messages and PR descriptions:** AC citations are great here.
  Reviewers grep for them; release-please may include them in the
  changelog.
- **Test names and fixture names:** prefer the behavior under test
  ("graphHash parity: medium-with-empty-keywords ([] vs absent)") over
  the AC ("AC-C-2: graphHash..."). The behavior survives renames; AC
  numbers don't.
- **Sweep before commit.** Run `rg -n "AC-[A-Z]-[0-9]" packages/ scripts/`
  against your branch before PR-open. Anything that hits is a
  candidate for rephrase. If the comment NEEDS to cite the AC, use a
  short reference at the end like "(AC-C-5)" rather than leading with
  it.
- **Sweep scope is `packages/` and `scripts/`, NOT `docs/adr/*`.** PR #74
  (`f09d804`) carved out `docs/adr/*` as the explicit place where
  coordinates ARE permanent decision rationale. A docs-refresh subagent
  that sees the sweep regex without the scope qualifier will scrub
  ADRs by default — DO NOT. Brief docs subagents explicitly that ADR
  text retains coordinates. See the
  `parallel-docs-subagent-overscrubs-adrs.md` lesson for the failure
  mode.
- **The test fakes are the trap.** When a Wave subagent edits a test
  fake, it tends to add `// AC-XXX: stubs ...` because it's writing
  the comment WITH the AC packet open in front of it. Sweep test files
  the same way as source files.

**Why it's worth a hook:** the leakage is mechanical and silent. A
PostToolUse hook on Edit/Write that scans the diff for `^[\\s*/]*AC-[A-Z]-[0-9]+`
in `packages/**` (excluding `.erpaval/`, `.md` ADRs, and commit-message
files) and either blocks the write or appends a stderr advisory would
catch every recurrence at the source. Until that hook exists, the
discipline is on the orchestrator + reviewer.

**Carry-forward debt:** Track A merged with extensive `AC-A-*`
references throughout `packages/storage/`, `packages/mcp/`, and
`packages/cli/`. They are on main and any Track-after-A branch picks
them up. A standalone `chore(repo): scrub spec coordinates from
source` cleanup PR is the right venue — not Track C, not Track D.
That PR can ship in its own session because the cleanup is mechanical
and reviewable in one window.
