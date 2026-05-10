---
name: Parallel docs-refresh subagents must be told that ADR text is the carve-out where spec coordinates ARE allowed
description: When a docs-refresh subagent inherits the "no spec-coordinate leakage" rule from durable lessons, it will scrub ADR text by default — but PR #74 carved out docs/adr/* as the place where coordinates ARE the durable rationale; brief explicitly
type: best-practices
---

OCH PR #74 (`f09d804 chore(repo): scrub ERPAVal spec coordinates from
source`) explicitly retained spec coordinates in `docs/adr/*` as
"permanent decision rationale". The durable lesson
`no-spec-coordinate-leakage-into-source.md` documents the scrub but
does NOT crisply state the carve-out. When a parallel docs-refresh
subagent reads the durable lesson and is told "no spec-coordinate
leakage", it scrubs ADRs too — undoing PR #74's deliberate carve-out.

Observed in OCH session 6c091d (2026-05-10 v1 upstream bug sweep): the
docs-refresh subagent stripped `AC-A-1`, `AC-A-2`, `AC-A-6 a/b/c/d`,
`AC-A-7`, `AC-A-9`, `AC-A-11` from ADR 0013-m7 and `AC-C-3`, `AC-C-5`,
`E-C-3`, `W-A-2` from ADR 0014. Required a follow-up
`docs(docs): restore ADR-permanent spec coordinates per PR #74 policy`
commit on the same branch.

**Why:** the durable lesson's scope says "production source, JSDoc,
inline comments, CLI flag help, MCP tool option descriptions, test
names" — but the ADR carve-out lives only in PR #74's body. Subagents
read the lesson, not the PR archive. The carve-out is invisible to a
fresh agent.

**How to apply:**

1. **Brief docs subagents explicitly.** When seeding a docs-refresh
   subagent prompt, include both rules:
   - "No spec-coordinate prefixes in production source (per durable
     lesson)."
   - "ADR text is the carve-out: spec coordinates in `docs/adr/*` are
     intentional permanent rationale per PR #74. Do NOT scrub them
     there."
2. **Update the lesson itself.** Edit
   `solutions/best-practices/no-spec-coordinate-leakage-into-source.md`
   to add a "Scope" section that names `docs/adr/*` as the carve-out,
   so future subagents reading the lesson see the constraint without
   needing PR archaeology.
3. **Sweep with a scope-aware regex.** When auditing leakage, exclude
   `docs/adr/*` from the sweep:
   `rg -n 'AC-[A-Z]-[0-9]' packages/ scripts/`
   not
   `rg -n 'AC-[A-Z]-[0-9]'` (which would falsely flag ADRs).
4. **The reverse case is also valid.** `docs/adr/0014-*` originally
   listed `.erpaval/specs/...` and `.erpaval/sessions/...` as
   References — those paths are gitignored and rot once the packet
   graduates. Replacing them with code-path citations IS correct, even
   in ADR text. The carve-out is for spec-coordinate prefixes, not for
   pointers to gitignored paths.

Anti-pattern: writing a generic "scrub spec coords everywhere" rule and
then surprised when ADR rationale gets vacuumed. The leakage rule
exists to prevent rot; ADR rationale doesn't rot because the ADR is
the rationale.

Cross-link:
[no-spec-coordinate-leakage-into-source](no-spec-coordinate-leakage-into-source.md) — the original rule.
PR #74 (`f09d804`) — the carve-out's authoritative source.
