---
description: Top contributors for a symbol or file
argument-hint: "<symbol-or-path>"
allowed-tools: ["mcp__opencodehub__owners"]
---

Identify the top contributors for the target symbol or file so the user knows who to pull into review.

Target: $ARGUMENTS

Steps:
1. Call `mcp__opencodehub__owners` with `{ target: "$ARGUMENTS" }`.
2. Render a table with the top 3 contributors and these columns:
   - **Author** (name + email, as returned).
   - **Commits** touching this target.
   - **Last touched** (ISO date of their most recent commit).
   - **Lines changed** (sum of additions + deletions).
3. Below the table, note which author is the current code-owner candidate: the most recent author whose commit count is within 30 percent of the top contributor's count. If there is no clear winner, say "No single owner — recommend dual review."

If the tool returns zero contributors, report "No git history for $ARGUMENTS" and stop.
