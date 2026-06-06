# ADR 0018 — Cleanroom provenance of the route / tool / contract tool names

- Status: **Accepted** — 2026-06-05.
- Authors: Laith Al-Saadoon + Claude.
- Branch: `roadmap/docs-destale-cleanroom`.
- Supersedes nothing. Records the independent-derivation rationale for a
  set of MCP tool names so the provenance is on the record.

## Context

Six MCP tool names describe HTTP-route, MCP-tool, and cross-repo-contract
intelligence:

- `route_map` — enumerate detected HTTP routes and their handlers.
- `tool_map` — enumerate detected MCP tools and their handlers.
- `shape_check` — classify a route/tool's request/response shape.
- `api_impact` — blast radius scoped to API-surface symbols.
- `group_list` — enumerate named cross-repo groups.
- `group_sync` — recompute a group's cross-repo contract registry.

These names sit in the public MCP surface (`packages/mcp/src/server.ts`)
and are referenced from the README, `CLAUDE.md`, and the Claude Code
plugin. Because the names are short and domain-generic, it is worth
recording — once — that they were derived from the tools' observable
behavior plus ordinary software-engineering vocabulary, not adopted from
any third party's published interface.

## Decision

Document the provenance; **rename nothing**. Each name is a literal,
compositional description of what the tool returns:

| Name | Derivation |
|---|---|
| `route_map` | A *map* (listing) of *routes*. The route detectors live in `@opencodehub/frameworks`; the tool projects their output. |
| `tool_map` | A *map* of MCP *tools*, same detector family as `route_map`. |
| `shape_check` | A *check* of a request/response *shape* (the `ShapeStatus` classifier in `packages/analysis/src/shape.ts`). |
| `api_impact` | The existing `impact` blast-radius analysis, *scoped to the API surface*. The name is `api` + `impact`, both already in the vocabulary. |
| `group_list` | *List* the cross-repo *groups* — the `group_*` family's enumeration verb. |
| `group_sync` | *Sync* (recompute) a *group's* contract registry — the family's write verb. |

"map", "check", "impact", "list", "sync", "route", "tool", "shape",
"api", and "group" are generic engineering terms. The `noun_verb` /
`noun_map` shape is the same convention the rest of the surface already
uses (`detect_changes`, `list_repos`, `pack_codebase`, `risk_trends`).
No name encodes a third party's distinctive naming, abbreviation, or
internal taxonomy; each falls out of the tool's function and the
surrounding naming pattern.

## Status

- **Accepted**: 2026-06-05, on merge of the documentation de-stale sweep.
- **Superseded**: not planned. If a tool is renamed, this ADR is amended
  in the same change.

## References

- Code:
  - `packages/mcp/src/server.ts` — the tool registrations (28 tools).
  - `packages/frameworks/` — the route + MCP-tool detectors behind
    `route_map` / `tool_map` / `api_impact`.
  - `packages/analysis/src/shape.ts` — the `ShapeStatus` classifier
    behind `shape_check`.
  - `packages/analysis/src/group/` — the cross-repo contract extractors
    behind `group_list` / `group_sync`.
- Related ADRs:
  - ADR 0012 — Repo as a first-class graph node; the `group_*` family
    and the `repo_uri` handle.
