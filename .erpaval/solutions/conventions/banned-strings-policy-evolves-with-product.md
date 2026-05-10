---
name: "Banned-strings policy must evolve when a banned literal becomes the product"
description: A banned-string allowlist that worked during decision-making becomes a barrier when the decision ships and the banned name becomes the official product term. Re-evaluate per release; remove literals when they cease to be prior-art references.
type: conventions
---

OCH's `scripts/check-banned-strings.sh` originally banned `ladybug` to
prevent prior-art prose from leaking in while the team evaluated graph
backends. After M3 (graph-DB phase 1) and M7 (default-flip), LadybugDB
became the actual default backend. The banned-strings policy still
held: `LadybugDB` in prose was a CI fail.

The workaround agents reached for: write `the graph-database backend`
or `@ladybugdb/core` (the package, allowlisted) instead of the bare
product name. This produced awkward prose:

> The default backend is the graph-database backend for the graph
> half + DuckDB for temporal.

vs the polished form after the policy update:

> The default backend is LadybugDB for the graph half + DuckDB for
> temporal.

The policy was correctly aggressive when the team was deciding what to
vendor. It was incorrectly aggressive once the decision shipped and
the product name needed to be plain in end-user docs.

**Why:** "Banned literal" is an aggressive guardrail. It assumes the
literal is never legitimate. That assumption holds during clean-room
evaluation (you don't want to inadvertently copy from a product
you're studying). It breaks once you adopt the product — the same
literal IS your product term.

**How to apply:**

- **At every release, audit `scripts/check-banned-strings.sh`** against
  the actual product. Has any banned literal become the product? If
  yes, remove it (and its allowlist regex if any).
- **Don't conflate "rejected as prior art" with "permanently banned."**
  Decision history goes in ADRs (`docs/adr/`), not in a CI guardrail.
  Once a vendoring decision is made, the literal's status flips from
  "watch out" to "use plainly."
- **If a literal must remain banned but is occasionally legitimate,
  prefer per-path exclusions over per-literal allowlists.** Already
  done in OCH for `docs/adr/` (path-excluded — ADRs document
  history). The path-exclusion is more robust than the
  literal-allowlist because it honors the editorial role of the file.
- **Update the script's comment block** when removing a banned
  literal. Future maintainers should read why a literal was once
  banned and why it isn't anymore.

In OCH, the same audit removed `kuzu` (legitimate as a historical
lineage citation: "LadybugDB is the open-source successor to the
pre-1.0 Kuzu codebase") and noted in the script comment that
`@ladybugdb/...` (npm package form) and `lbug` (env-var/file-extension
form) need no allowlist because they don't appear in the banned set
anymore.

Counter-example: `STEP_IN_PROCESS`, `heuristicLabel`, `codeprobe`,
`STEP_IN_FLOW`, `duckpgq` are still banned because OCH does NOT use
those — they ARE prior-art references the project deliberately
doesn't copy from. The policy only removes literals that became the
product.
