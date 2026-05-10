---
title: Error codes
description: The fixed set of MCP error codes returned under structuredContent.error.
sidebar:
  order: 30
---

Every MCP tool that fails gracefully (i.e. the tool ran but the
operation could not complete) returns a uniform envelope under
`structuredContent.error` with `isError: true`. Protocol-level
failures (unknown tool name, malformed JSON-RPC) raise the SDK's
`McpError` instead and are not enumerated here.

The canonical list lives at
[`packages/mcp/src/error-envelope.ts`](https://github.com/theagenticguy/opencodehub/blob/main/packages/mcp/src/error-envelope.ts).

## Codes

| Code | When it fires | Typical remediation |
|---|---|---|
| `STALENESS` | The index lags `HEAD` far enough to mistrust results. | `codehub analyze` (or `--force`). |
| `INVALID_INPUT` | A tool argument failed schema validation. | Correct the call; check required fields. |
| `NOT_FOUND` | The target symbol, repo, or group does not exist. | Confirm the name; run `codehub list` for repos. |
| `DB_ERROR` | DuckDB returned an error during the query. | Check `codehub doctor`; inspect `.codehub/graph.duckdb`. |
| `SCHEMA_MISMATCH` | The index was produced by a different CLI version with an incompatible schema. | `codehub analyze --force` to rebuild. |
| `RATE_LIMITED` | A downstream service (embedder, summariser) rate-limited the request. | Retry with backoff; reduce concurrency. |
| `INTERNAL` | Catch-all for unhandled exceptions reaching the tool boundary. | File an issue with the error `message`. |
| `NO_INDEX` | The repo has no `.codehub/` directory. | `codehub analyze <path>`. |
| `AMBIGUOUS_REPO` | More than one repo is indexed and no `repo` argument was supplied. | Pass `repo` to the tool call. |

## Envelope shape

```json title="error envelope"
{
  "isError": true,
  "content": [
    { "type": "text", "text": "Error (AMBIGUOUS_REPO): ...\nHint: ..." }
  ],
  "structuredContent": {
    "error": {
      "code": "AMBIGUOUS_REPO",
      "message": "Multiple repos registered; specify `repo`.",
      "hint": "One of: acme-api, acme-web"
    }
  }
}
```

Clients should key on `structuredContent.error.code` to decide whether
to retry, disambiguate, or abort.
