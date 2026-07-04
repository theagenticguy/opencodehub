# @opencodehub/mcp

Model Context Protocol server for OpenCodeHub. Wraps the analysis +
storage layer and exposes it to coding agents over stdio.

## Surface

```bash
codehub mcp   # spawn the stdio server
```

- Transport is stdio only — no HTTP, no SSE, no daemon
  (`packages/cli/src/commands/mcp.ts`).
- `list_repos` is the discovery entry point. Per-repo tools accept an
  optional `repo` (registry name) or `repo_uri` alias (Sourcegraph-style
  URI like `github.com/org/repo`, `local:<hash>` for unpublished repos);
  with one repo registered both are optional.
- When ≥ 2 repos are registered and neither is supplied, the tool
  returns an `AMBIGUOUS_REPO` error envelope with `choices[]` (capped at
  10) so the caller can retry deterministically (see root `CLAUDE.md`).
- Every response carries a `next_steps` array and a
  `_meta.codehub/staleness` entry when the index may be behind HEAD
  (`packages/mcp/src/staleness.ts`).

## Tools

28 tools registered in `packages/mcp/src/server.ts`. Implementation
files live under `packages/mcp/src/tools/<id>.ts`. Every tool is
**read-only with respect to user source** — no tool edits the working
tree.

| Group       | Tools                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Discovery   | `list_repos`, `query`, `context`, `signature`, `route_map`, `tool_map`                                     |
| Impact      | `impact`, `api_impact`, `detect_changes`, `shape_check`                                                    |
| Snapshot    | `pack_codebase`, `project_profile`, `dependencies`, `owners`, `risk_trends`                                |
| Findings    | `scan`, `verdict`, `list_findings`, `list_findings_delta`, `license_audit`                                 |
| Dead code   | `list_dead_code`                                                                                            |
| Group       | `group_list`, `group_query`, `group_status`, `group_contracts`, `group_cross_repo_links`, `group_sync`     |
| Raw query   | `sql`                                                                                                      |

## Design

- **Single source of truth** — registration order in `server.ts` IS the
  surface. `tool_map` introspects the live server so agents can list
  tools without out-of-band documentation
  (`packages/mcp/src/tools/tool-map.ts`).
- **Structured errors over prose** — every error returns
  `structuredContent.error = { error_code, jsonrpc_code, ... }` so a
  caller can branch on `error_code` instead of regex-matching
  (`packages/mcp/src/error-envelope.ts`).
- **Repo resolution is centralised** — `repoResolver` and the
  AMBIGUOUS_REPO envelope are wired through every per-repo tool so
  ambiguity is reported once, consistently
  (`packages/mcp/src/repo-resolver.ts`).
- **Connection pooling** — the graph store is held in a per-process
  pool to amortise SQLite cold starts across many tool calls
  (`packages/mcp/src/connection-pool.ts`).
- **Lazy analysis** — heavy work (scan, code-pack, verdict) shells out
  via `analysis-bridge` rather than running in the MCP process so a
  hung scanner cannot stall the server (`packages/mcp/src/analysis-bridge.ts`).

See ADR 0012 for the `repo_uri`-as-typed-attribute rationale and the
root `CLAUDE.md` for the AMBIGUOUS_REPO retry contract.
