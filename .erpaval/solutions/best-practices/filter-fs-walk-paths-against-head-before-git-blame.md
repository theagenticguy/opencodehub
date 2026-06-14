---
title: Intersect filesystem-walk paths with HEAD-tracked set before git blame
track: knowledge
category: best-practices
module: packages/ingestion/src/pipeline/phases
component: ownership phase / scan phase
severity: info
tags: [git-blame, ownership, untracked-files, init-noise, first-run-ux]
applies_when:
  - "A phase runs `git blame` per file over a list sourced from a filesystem walk"
  - "The walk honors .gitignore but still includes untracked files (init output, generated)"
  - "Users see noisy per-file `fatal: no such path '<x>' in HEAD` warnings"
pattern: |
  The ingestion scan phase enumerates files via a filesystem walk (honoring
  .gitignore), which INCLUDES untracked files — e.g. everything `codehub init`
  writes (.mcp.json, .claude/skills/*, .codex/, opencodehub.policy.yaml). The
  ownership phase then runs `git blame --porcelain -- <path>` per file; blame
  fails on untracked paths with `fatal: no such path in HEAD`, and the onWarn
  handler logs one line each (~45 on a fresh init+analyze) — alarming first-run noise.

  Fix: capture the HEAD-tracked path set once via `git ls-files -z` (same
  spawn-git pattern already used for `git ls-tree` submodule enumeration in
  scan.ts), expose it as an OPTIONAL field on ScanOutput
  (`trackedPaths?: ReadonlySet<string>`), and in the ownership phase intersect the
  blame list against it when defined. Optional ⇒ undefined means "unknown, don't
  filter" so non-git repos keep current behavior; an EMPTY set is distinct and
  meaningful (git repo, zero tracked files). `git ls-files -z` emits
  POSIX-separated repo-relative paths, matching ScannedFile.relPath with no
  re-normalization. Leave the onWarn handler intact so genuine blame failures on
  TRACKED files still surface.
example_files:
  - packages/ingestion/src/pipeline/phases/scan.ts
  - packages/ingestion/src/pipeline/phases/ownership.ts
---

# Why this matters

Untracked files have no blame/ownership by definition — blaming them is guaranteed
to fail and the warnings are pure noise that erodes trust in a tool's first
impression. Filtering at the source (the tracked-path set) is cheaper and cleaner
than swallowing errors per-file, and it preserves real signal: a blame failure on a
*tracked* file is a genuine problem worth surfacing.

# Example

```ts
// scan.ts — mirror the existing listGitSubmodules spawn pattern
async function listGitTrackedPaths(repoPath: string): Promise<ReadonlySet<string> | undefined> {
  // git ls-files -z → POSIX-relative tracked paths; undefined on non-git/non-zero exit
}
// ownership.ts — after filterOutSubmodules, before batchBlame
const paths = scan.trackedPaths !== undefined
  ? sortedPaths.filter((p) => scan.trackedPaths!.has(p))
  : sortedPaths;
```
Verified on bonk: 0 `blame failed` lines (was ~45) with the freshly written init
files present. Relates to [[fixed-offset-asset-resolvers-break-on-bundle-collapse]]
(init writes the .claude/ tree that triggers this).
