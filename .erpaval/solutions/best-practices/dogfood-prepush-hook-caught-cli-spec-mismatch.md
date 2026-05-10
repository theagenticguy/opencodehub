---
name: A dogfood pre-push hook catches CLI-spec mismatches on the first push
description: When you wire a CLI you own into your own pre-push hook, the hook becomes a tight feedback loop — the first push of the AC that adds the hook will surface any drift between the spec's invocation and the actual CLI surface, before CI sees it
type: knowledge
tags: [dogfood, lefthook, pre-push, ci-hooks, verdict, codehub, fast-feedback]
session: session-85faf1
ac: AC-D-5
---

## Context

Track D's AC-D-5 added a pre-push lefthook job:

```yaml
- name: verdict
  run: "{pnpm} codehub verdict --base origin/main --head HEAD --exit-code"
```

The spec lifted that exact invocation from the spec text — `--exit-code` was a load-bearing flag in the spec. The hook fired on the first `git push -u origin feat/v1-finalize-track-d` and immediately failed:

```
error: unknown option '--exit-code'
```

`codehub verdict --help` confirmed the flag does not exist. Reading the source, `verdict` already exits with non-zero on a `block` tier by default — process.exitCode is set automatically. The spec was wrong about the flag.

A second push surfaced a second bug: `codehub verdict` requires a graph index at `.codehub/graph.duckdb` or `graph.lbug`, and a fresh dev clone has neither. The hook hard-blocked the push instead of degrading gracefully.

Both fixes landed as `fix(ci):` follow-up commits BEFORE the PR opened, on the same branch, in the same session.

## Lesson

When you wire your own CLI into your own pre-push hook, the hook is a self-test. The first push of the AC that adds the hook is where you discover:

1. **Whether the flags the spec named are actually wired in the CLI.** Spec drift between EARS requirements and the runtime tool is silent until something runs the tool — and a pre-push hook runs it on every push by definition.

2. **Whether the hook degrades gracefully on every state of the developer's working tree.** A hook that hard-blocks pushes from a freshly-cloned repo (no `.codehub/` index yet) is a foot-gun even if it works correctly on a fully-set-up box.

The fix template for the second one is the same as `scripts/pack-determinism-audit.sh`'s SKIP shape:

```yaml
run: |
  if [ -f .codehub/graph.duckdb ] || [ -f .codehub/graph.lbug ]; then
    {pnpm} codehub verdict --base origin/main --head HEAD
  else
    echo "verdict skipped: no .codehub/ index — run 'mise run och:self-analyze' first"
  fi
```

## How to apply

- Always test a new pre-push hook by pushing the very commit that adds it. The first push is the truth-teller.
- Pattern: every dogfood gate that depends on a derived artifact (index, build output, cache) should mirror `scripts/pack-determinism-audit.sh`'s SKIP-with-message shape on absence — never hard-block a push for an artifact the developer hasn't been told to build.
- When a spec quotes a CLI invocation, sanity-check it against `<binary> <subcommand> --help` before trusting it. Specs lag CLIs; CLIs are the source of truth.

## Why this matters

The spec contract for AC-D-5 was D1-E-4: "lefthook pre-push MUST run `codehub verdict --base origin/main --head HEAD --exit-code`." That clause was wrong about the flag, and a non-dogfooded hook would have left the bug to CI on the next push, or the next dev's first push, or — worst case — a release-please run. Tight feedback caught it in 30 seconds at the cost of one fixup commit.

## References

- Implementation: PR #75 commits `4cf07a8` (initial), `55dc684` (drop `--exit-code`), `044ef43` (graceful-degrade guard).
- CLI shape: `packages/cli/src/commands/verdict.ts:42-65,140-145` — the `--exit-code` is set by default, no flag needed.
- Skip-pattern reference: `scripts/pack-determinism-audit.sh` lines 30-44.
