---
description: Impact-and-context probe on a symbol
argument-hint: "<symbolName>"
allowed-tools: ["mcp__opencodehub__context", "mcp__opencodehub__impact"]
---

Run an impact-and-context probe on the target symbol to brief the user before they touch it.

Target: $ARGUMENTS

Steps:
1. Call `mcp__opencodehub__context` with `{ name: "$ARGUMENTS" }` to gather callers, callees, and the execution flows this symbol participates in.
2. Call `mcp__opencodehub__impact` with `{ target: "$ARGUMENTS", direction: "upstream", depth: 3 }` to compute the blast radius.
3. Summarize in exactly 5 lines:
   - What it does (1 line, derived from the signature and surrounding comments).
   - Who calls it (top 3 direct callers with file:line).
   - What it depends on (top 3 direct callees).
   - Blast radius (total affected symbols, affected execution flows).
   - Risk tier (LOW | MEDIUM | HIGH | CRITICAL) and the one-line reason.

If either MCP call returns an empty result, say so explicitly and stop — do not pad the summary.
