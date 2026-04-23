---
description: Graph-aware rename with dry-run preview
argument-hint: "<oldName> <newName>"
allowed-tools: ["mcp__opencodehub__rename", "Read"]
---

Rename a symbol across the graph safely. Always dry-run first, present the diff, and only apply on explicit confirmation.

Input: `$ARGUMENTS` — expected as `<oldName> <newName>` (space-separated). If either token is missing, stop and ask the user to re-issue with both names.

Steps:
1. Parse `$ARGUMENTS` into `oldName` and `newName`.
2. Call `mcp__opencodehub__rename` with `{ from: "<oldName>", to: "<newName>", dry_run: true }`.
3. Render the preview:
   - **Symbol**: `<oldName>` → `<newName>`.
   - **Files affected**: count, then a bulleted list of `path` with per-file edit counts (cap list at 20, note overflow).
   - **Call sites rewritten**: total count.
   - **Risks flagged**: any warnings from the tool (ambiguous overloads, external exports, shadowed locals) — bulleted. If none, write "None."
4. Stop and ask the user: "Apply this rename? (yes/no)". Do NOT call `rename` again with `dry_run: false` until the user replies `yes`.
5. On `yes`, call `mcp__opencodehub__rename` with `{ from: "<oldName>", to: "<newName>", dry_run: false }` and report the number of files written. On anything else, report "Cancelled — no files modified."
