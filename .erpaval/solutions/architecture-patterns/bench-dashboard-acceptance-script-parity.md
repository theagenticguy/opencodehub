---
name: A dashboard that parses banner-text from a script must mirror the script's banners verbatim
description: Bench/dashboard tools that index gates/jobs by exact-title match against a script's banner output drift silently when the script grows new gates — both files must be edited together
type: architecture-patterns
---

`packages/cli/src/commands/bench.ts` indexes gate rows by exact-string
match against `scripts/acceptance.sh` banners (`N/17: <title>`). When
the script grew from 9 to 17 gates and changed a few existing banner
titles ("graphHash determinism" → "determinism (double-run graphHash)"),
the dashboard didn't follow. Result: 8 gates never advance past
"pending" and post-stream get stamped "skipped — script crashed" by the
crash-fallback path; another 3 displayed under stale titles. Operators
saw 9/17 gates with confusing detail strings.

The original code shape:

```ts
export const MVP_GATES: readonly { id: string; title: string }[] = [
  { id: "install", title: "pnpm install --frozen-lockfile" },
  // ... 8 more, with stale titles
];

export function applyLine(rows: GateRow[], rawLine: string): void {
  const banner = /^\d+\/\d+:\s+(.*)$/.exec(line);
  if (banner) {
    const idx = rows.findIndex((r) => r.title === banner[1]);  // exact match
    if (idx >= 0) currentGateIdx = idx;
  }
}
```

**Why:** the dashboard is a thin presenter over the script's stdout. Any
banner text not in `MVP_GATES` is silently dropped. There is no compile-
time signal — the build is green, the unit tests are green, only the
runtime UX degrades. The same gap also caught `[SKIP]` markers: the
original `applyLine` matched `[PASS]`/`[FAIL]` but not `[SKIP]`, so
gracefully-degrading gates rendered as "skipped — script crashed" via
the crash-fallback path with a misleading detail string.

**How to apply:**

1. **Treat banner titles as a contract** between the script and the
   dashboard. Edit both files in the same commit.
2. **Add a roster-shape test.** Assert `MVP_GATES.length === 17` AND
   `MVP_GATES.map(g => g.title)` matches the banner sequence the script
   emits. The test pulls the banner list from the script directly with
   `grep -oE '^echo "\d+/\${TOTAL_GATES}: (.+)"$' scripts/acceptance.sh`
   so the assertion follows the source of truth.
3. **Match every marker the script emits.** If the script emits `[PASS]`,
   `[FAIL]`, AND `[SKIP]`, the parser must handle all three. The
   crash-fallback path must NOT fire for legitimate skips.
4. **Order matters when index = listr2 row.** `MVP_GATES` order must
   match script execution order — the dashboard advances rows by index
   as banners stream in.

Anti-pattern: a "we'll keep them in sync manually" comment without an
enforcement test. The 9-gate / 17-gate drift sat in `main` undetected
because no CI surface failed when the script grew. Surfacing it
required an operator to run `codehub bench` and notice the visual
mismatch.

Cross-link: the `dogfood-prepush-hook-caught-cli-spec-mismatch` durable
lesson covers a related pattern — the dogfood pre-push hook on this
exact PR was where this bug was first surfaced (Bug #4 in
UPSTREAM_BUGS.md, 2026-05-10 smoke).
