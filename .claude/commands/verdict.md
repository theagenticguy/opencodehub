---
description: 5-tier PR verdict for the current branch
argument-hint: "[base-ref]"
allowed-tools: ["mcp__opencodehub__verdict", "Bash(codehub verdict:*)", "Bash(git:*)"]
---

Produce a 5-tier merge verdict for the current branch against `main` (or the base ref passed in `$ARGUMENTS`).

Steps:
1. Resolve the base ref: use `$ARGUMENTS` if non-empty, else `main`.
2. Call `mcp__opencodehub__verdict` with `{ base: "<baseRef>", head: "HEAD" }`. If the MCP tool is unavailable in this session, fall back to `codehub verdict --base <baseRef> --head HEAD` via Bash.
3. Summarize the response in this shape:
   - **Tier**: one of `auto_merge` | `single_review` | `dual_review` | `expert_review` | `block`.
   - **Top drivers**: bullet list of the 3 strongest signals that pushed the tier (high-impact symbols, failing checks, risky hotspots, missing coverage, etc.).
   - **Blockers** (only if tier is `block`): the specific findings that must be resolved.
   - **Next action**: the single concrete step the author should take (merge, request review from X, add tests for Y, fix finding Z).

Keep the output under 15 lines. Link to files with `path:line` — no prose paraphrase of the code.
