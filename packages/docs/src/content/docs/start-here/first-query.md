---
title: Your first query
description: Walk through query, context, and impact against a local index.
sidebar:
  order: 40
---

All three commands below run locally against the index at `.codehub/`.
None of them open sockets once the index is built (add `--offline` to
`analyze` to also prove zero network during indexing).

## Hybrid search: `query`

`codehub query` fuses BM25 lexical search with HNSW vector search (when
embeddings are present) to find symbols related to a natural-language
concept.

```bash title="find symbols related to an auth flow"
node packages/cli/dist/index.js query "auth token refresh"
```

Expected shape (abridged):

```
process: auth.refresh_token  — 7 steps, 4 files
  1. refreshToken (src/auth/handler.ts:42)
  2. validateRefreshToken (src/auth/validate.ts:18)
  3. ...

process: oauth.rotate_session — 5 steps, 3 files
  1. rotateSession (src/oauth/rotate.ts:12)
  2. ...
```

Results are grouped by **process** (an execution flow the indexer
detected during clustering), not a flat symbol list. Use `--limit`,
`--bm25-only`, or `--granularity file` to change the shape.

## 360-degree context: `context`

`codehub context <symbol>` returns callers, callees, and the processes
the symbol participates in.

```bash title="context for a single symbol"
node packages/cli/dist/index.js context PaymentProcessor
```

Expected shape:

```
PaymentProcessor (Class, src/payments/processor.ts:24)
  callers:
    - checkout.charge (src/checkout/charge.ts:88)
    - subscriptions.renew (src/subscriptions/renew.ts:56)
  callees:
    - validateCard, stripeClient.createCharge, auditLog.write
  processes:
    - payments.checkout (12 steps)
    - payments.renewal (8 steps)
  ACCESSES edges:
    - ProcessorConfig (read), AuditLog (write)
```

Pass `--json` to get the structured envelope that the MCP `context`
tool returns.

## Blast radius: `impact`

`codehub impact <symbol>` reports how many symbols, files, and
processes depend on the target, plus a **risk tier** (`LOW` / `MEDIUM`
/ `HIGH` / `CRITICAL`).

```bash title="depth-2 blast radius"
node packages/cli/dist/index.js impact validateUser --depth 2
```

Expected shape:

```
impact(target = validateUser, depth = 2)
  direct callers: 14
  transitive callers (depth 2): 37
  affected processes: 3
  risk tier: HIGH
  confidence: 0.82
```

`--direction up` restricts to dependents (who calls me), `--direction
down` restricts to dependencies (who do I call), and `--direction both`
(the default) returns both in one response.

## Next

- [MCP tools overview](/opencodehub/mcp/overview/) for the full server
  capabilities.
- [Using with Claude Code](/opencodehub/guides/using-with-claude-code/)
  to let the agent run these tools for you.
