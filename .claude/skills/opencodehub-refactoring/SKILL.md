---
name: opencodehub-refactoring
description: "Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: \"Rename this function\", \"Extract this into a module\", \"Refactor this class\", \"Move this to a separate file\"."
---

# Refactoring with OpenCodeHub

## When to Use

- "Rename this function safely."
- "Extract this into a module."
- "Split this service."
- "Move this to a new file."
- Any task involving renaming, extracting, splitting, or restructuring code.

## Workflow

```
1. mcp__opencodehub__impact({ name: target, direction: "upstream" })   → All dependents
2. mcp__opencodehub__context({ name: target })                         → Incoming / outgoing / processes
3. mcp__opencodehub__rename({ ..., dry_run: true })                    → Preview every edit
4. Review confidence tags on each edit (graph vs. text-search)
5. mcp__opencodehub__rename({ ..., dry_run: false })                   → Apply
6. mcp__opencodehub__detect_changes                                    → Verify the diff matches the plan
7. Run tests for the affected processes
```

> If the context envelope warns the index is stale, run `codehub analyze` first — a stale graph produces incomplete rename plans.

## Checklists

### Rename a symbol

```
- [ ] mcp__opencodehub__impact({ name, direction: "upstream" }) — enumerate all dependents
- [ ] mcp__opencodehub__rename({ name, new_name, dry_run: true })
      (pass `file_path` and/or `kind` to disambiguate when the name is ambiguous)
- [ ] Review edits: graph edges (high confidence, LSP-backed where available)
      vs. text_search edits (review line-by-line — config files, docs, tests)
- [ ] Cross-check the dry-run edit count against impact's d=1 count —
      gaps mean a dynamic reference the rename missed
- [ ] mcp__opencodehub__rename({ ..., dry_run: false }) — apply
- [ ] mcp__opencodehub__detect_changes({ scope: "unstaged" }) — confirm scope
- [ ] Run tests for every affected process
```

### Extract a module

```
- [ ] mcp__opencodehub__context({ name: target }) — see every external ref
- [ ] mcp__opencodehub__impact({ name: target, direction: "upstream" }) — callers outside the new module
- [ ] Define the new public surface (exports only what external callers use)
- [ ] Move code; update imports
- [ ] mcp__opencodehub__detect_changes — verify scope
- [ ] Run tests for the affected processes
- [ ] Re-run codehub analyze so the next agent sees the new module boundary
```

### Split a function or service

```
- [ ] mcp__opencodehub__context({ name: target }) — understand outgoing calls
- [ ] Group outgoing calls by responsibility (the seams for the split)
- [ ] mcp__opencodehub__impact({ name: target, direction: "upstream" }) — map callers to update
- [ ] Create the new functions / services
- [ ] Update callers
- [ ] mcp__opencodehub__detect_changes — verify scope
- [ ] Run tests
```

## Tools

### `mcp__opencodehub__rename` — multi-file coordinated rename

```
mcp__opencodehub__rename({
  name: "validateUser",
  new_name: "authenticateUser",
  repo: "my-app",
  dry_run: true                 // default: true
})

→ edits: [{
    file_path,
    line,
    old_text,
    new_text,
    confidence,       // 0.95+ = graph-backed (ideally LSP-confirmed); lower = text_search
    source            // "graph" | "text_search"
  }]
→ summary: {total, by_source: {graph, text_search}}
```

**Rule**: always review `text_search` edits line-by-line. They are the ones that hit dynamic references (config JSON, doc comments, test fixtures) where a rename may or may not be correct. Graph-backed edits on LSP-confirmed edges are safe to apply in bulk.

Disambiguation: when `name` matches more than one symbol, pass `file_path` and optionally `kind` to pick the target. A future wave will add `symbol_uid` for a direct UID-only path.

### `mcp__opencodehub__impact` — enumerate dependents before renaming

```
mcp__opencodehub__impact({
  name: "validateUser",
  direction: "upstream",
  depth: 2,
  repo: "my-app"
})

→ byDepth.d1: direct callers — every one needs updating
→ confidenceBreakdown: {confirmed, heuristic, unknown}
```

If `unknown > 0`, the demote phase contradicted a heuristic edge. That edge may not be a real call — inspect before updating.

### `mcp__opencodehub__detect_changes` — verify the post-refactor diff

```
mcp__opencodehub__detect_changes({ scope: "unstaged", repo: "my-app" })

→ changed_symbols: [...]
→ affected_processes: [...]
→ risk_level: LOW | MEDIUM | HIGH | CRITICAL
```

Always run this **after** applying the rename. Any symbol you did not expect to change is a miss.

### `mcp__opencodehub__sql` — custom reference query

All files referencing a symbol (useful when rename misses dynamic refs):

```sql
SELECT DISTINCT caller.file_path
FROM relations r
JOIN nodes caller ON caller.id = r.from_id
JOIN nodes target ON target.id = r.to_id
WHERE r.type IN ('CALLS', 'REFERENCES', 'IMPORTS')
  AND target.name = 'validateUser'
ORDER BY caller.file_path;
```

## Risk Rules

| Risk factor                       | Mitigation                                                              |
| --------------------------------- | ----------------------------------------------------------------------- |
| Many callers (> 5)                | Let `rename` do the mechanical work — do not hand-edit                  |
| Cross-module references           | Run `detect_changes` after applying; watch for missed imports           |
| String / dynamic references       | Use `sql` with `type = 'REFERENCES'` + text_search edits                |
| Public / exported API             | Version and deprecate; mirror symbol names in a transition layer        |
| Heuristic edges (confirmed = 0)   | Cross-check by reading source; LSP did not weigh in                     |

## Example: Rename `validateUser` to `authenticateUser`

```
1. mcp__opencodehub__impact({ name: "validateUser", direction: "upstream", repo: "my-app" })
   → d=1: loginHandler, apiMiddleware, tests/auth.test.ts
   → affected_processes: [LoginFlow, TokenRefresh]
   → confidenceBreakdown: {confirmed: 3, heuristic: 0, unknown: 0}

2. mcp__opencodehub__rename({
     name: "validateUser", new_name: "authenticateUser",
     repo: "my-app", dry_run: true
   })
   → 12 edits across 8 files
   → summary: {graph: 10, text_search: 2}
   → text_search edits: config/routes.json (line 14), docs/auth.md (line 33)

3. Review text_search edits: config/routes.json references validateUser by
   string name — apply the rename manually, the JSON schema allows it.
   docs/auth.md is prose, safe to rewrite.

4. mcp__opencodehub__rename({ ..., dry_run: false })
   → Applied 12 edits across 8 files.

5. mcp__opencodehub__detect_changes({ scope: "unstaged", repo: "my-app" })
   → changed_symbols: [authenticateUser, loginHandler, apiMiddleware, ...]
   → affected_processes: [LoginFlow, TokenRefresh]
   → risk_level: MEDIUM

6. Run LoginFlow + TokenRefresh integration tests. Re-run codehub analyze
   so the graph picks up the new name.
```
