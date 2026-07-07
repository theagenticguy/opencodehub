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
| `DB_ERROR` | The store returned an error during the query. | Check `codehub doctor` (it runs a `node:sqlite` import + WAL round-trip); inspect `.codehub/store.sqlite`. |
| `SCHEMA_MISMATCH` | The index was produced by a different CLI version with an incompatible schema. | `codehub analyze --force` to rebuild. |
| `RATE_LIMITED` | A downstream service (embedder) rate-limited the request. | Retry with backoff; reduce concurrency. |
| `INTERNAL` | Catch-all for unhandled exceptions reaching the tool boundary. | File an issue with the error `message`. |
| `NO_INDEX` | The repo has no `.codehub/` directory. | `codehub analyze <path>`. |
| `AMBIGUOUS_REPO` | More than one repo is indexed and neither `repo` nor `repo_uri` was supplied. | Retry with one of the `choices[].repo_uri` values. |
| `EMBEDDER_MISMATCH` | The store was indexed by a different embedder than the one currently configured. | Re-index with the configured embedder, or pass the documented force flag. |

The historical `GraphDbBindingError` (a failed native graph-binding
load) no longer exists. ADR 0019 removed both native storage bindings
and moved the whole index into one `store.sqlite` file via the built-in
`node:sqlite`, so there is no binding to fail.

## `AMBIGUOUS_REPO` envelope

`AMBIGUOUS_REPO` is the most common error a federated client encounters.
The structured envelope carries everything a caller needs to retry
deterministically.

```jsonc
{
  "isError": true,
  "content": [
    { "type": "text", "text": "Error (AMBIGUOUS_REPO): ...\nHint: ..." }
  ],
  "structuredContent": {
    "error": {
      "error_code": "AMBIGUOUS_REPO",
      "jsonrpc_code": -32602,
      "choices": [
        { "repo_uri": "github.com/org/api-svc", "default_branch": "main", "group": "platform" },
        { "repo_uri": "github.com/org/billing-svc", "default_branch": "main", "group": "platform" }
      ],
      "total_matches": 2,
      "hint": "Retry with repo_uri=<one of above>"
    }
  }
}
```

`choices[]` is capped at 10. When `total_matches > choices.length`,
the caller knows the list was truncated. Pick a `repo_uri` from the
list and retry the original call:

```jsonc
{ "tool": "context", "args": { "repo_uri": "github.com/org/api-svc", "symbol": "..." } }
```

`repo_uri` is the canonical first-class graph attribute promoted in
ADR 0012; every group tool emits it in the same form so its outputs
are valid `AMBIGUOUS_REPO` retry inputs.

## Generic envelope shape

For every other code, the envelope shape is:

```json title="error envelope"
{
  "isError": true,
  "content": [
    { "type": "text", "text": "Error (NO_INDEX): ...\nHint: ..." }
  ],
  "structuredContent": {
    "error": {
      "code": "NO_INDEX",
      "message": "Repo has no .codehub/ directory.",
      "hint": "Run `codehub analyze <path>`."
    }
  }
}
```

Clients should key on `structuredContent.error.code` (or
`error_code` in the `AMBIGUOUS_REPO` case) to decide whether to retry,
disambiguate, or abort.
