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

## The stdio-only rail — what is intentionally absent

This server runs on **stdio and stdio only** (`codehub mcp` spawns it as a
child process; the parent agent owns the credentials and the lifecycle).
That single decision makes a whole category of MCP transport machinery
**deliberately absent**. If you are tempted to "helpfully" add any of the
following, stop — the rail forbids it, and adding it is a regression, not
an improvement:

- **No `Mcp-Method` / `Mcp-Name` request headers.** These are
  **Streamable-HTTP-only** routing/identification headers. There is no HTTP
  layer here — the transport is a pipe — so there are no headers to set or
  read. Method dispatch happens over JSON-RPC `method` strings on the
  stdio stream, not HTTP headers.
- **No OAuth / EMA / ID-JAG / token exchange.** Authorization on stdio is
  **ambient**: the spawning agent already has the user's filesystem and
  environment credentials, and the child inherits them. There is no remote
  origin to authenticate to and no bearer token to mint, exchange, or
  refresh. Wiring an OAuth flow onto a child process the user already owns
  adds attack surface for zero security gain.
- **No session IDs.** Streamable-HTTP needs a session ID to correlate many
  stateless HTTP requests back to one logical connection. A stdio pipe *is*
  the session — one process, one connection, lifetime-bound to the pipe —
  so there is nothing to correlate. The 2026-07-28 protocol model is
  stateless per-request (`io.modelcontextprotocol/*` keys in `_meta`,
  `packages/mcp/src/protocol-version.ts`), which reinforces this: the
  server remembers no handshake state, so there is no session to key.
- **No tool-description signing.** The spec mandates no signature on tool
  descriptions, and on a trusted local pipe there is no man-in-the-middle
  to defend against. The descriptions are read straight from the registered
  tools.

The corollary: **do not add an HTTP/SSE transport, a daemon mode, a
session store, or auth middleware to this package.** If a future use case
genuinely needs remote transport, that is a separate package with its own
rail — not a flag on this one.

## 2026-07-28 RC protocol framing

The 2026-07-28 spec revision is wired application-side (the installed
`@modelcontextprotocol/sdk@1.29.0` is still on `2025-11-25`), in
`packages/mcp/src/discover.ts` + `protocol-version.ts`:

- **`server/discover`** advertises server identity, the supported protocol
  versions (`["2026-07-28"]`, lex-sorted), and the live registered tools
  (the real 29, name-sorted). Two calls are byte-identical.
- **`ping`, `logging/setLevel`, `notifications/roots/list_changed` are
  gone.** `ping` is de-registered from the SDK default; the other two are
  never installed under our capability posture. Log level is now read
  per-request from `io.modelcontextprotocol/logLevel` in `_meta`, not from
  a stateful `logging/setLevel` round-trip.
- **`tools/list`, `resources/list`, and resource reads carry `ttlMs` +
  `cacheScope`** (`ttlMs: 3_600_000`, `cacheScope: "shared"`) — the catalog
  is static within a server version, so the hints are generous and
  shareable. These are `ttlMs` + `cacheScope`, **not** `etag` (the RC
  corrected that earlier proposal).

## Tools

29 tools registered in `packages/mcp/src/server.ts`. Implementation
files live under `packages/mcp/src/tools/<id>.ts`. Every tool is
**read-only with respect to user source** — no tool edits the working
tree. `server/discover` advertises this live set (plus server identity
and the supported protocol versions) at the protocol layer; the test in
`packages/mcp/src/server.test.ts` pins the count at exactly 29.

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
  pool to amortise DuckDB cold starts across many tool calls
  (`packages/mcp/src/connection-pool.ts`).
- **Lazy analysis** — heavy work (scan, code-pack, verdict) shells out
  via `analysis-bridge` rather than running in the MCP process so a
  hung scanner cannot stall the server (`packages/mcp/src/analysis-bridge.ts`).

See ADR 0012 for the `repo_uri`-as-typed-attribute rationale and the
root `CLAUDE.md` for the AMBIGUOUS_REPO retry contract.
