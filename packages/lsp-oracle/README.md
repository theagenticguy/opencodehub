# @opencodehub/lsp-oracle

Pyright-langserver driven LSP oracle for Python reference /
implementation / incoming-call queries. Spawns `pyright-langserver` as a
subprocess, speaks raw LSP JSON-RPC over stdio, and exposes the three
queries downstream ingestion consumers actually need.

## Why this exists

OpenCodeHub's Python analyzer extracts callable symbols by walking the
tree-sitter AST. AST extraction is fast and language-agnostic but has
two blind spots:

1. **It can't resolve cross-module references.** An AST pass sees
   `client.invoke(...)` and knows the token `invoke`, but not which
   class's `invoke` method that resolves to once `client` is typed.
2. **It has no incoming-calls primitive.** You can record outgoing
   references from each function body, but recovering "who calls `X`"
   requires a type-aware reverse index.

A language server does both — that's literally what "Find All References"
and "Call Hierarchy" are for in IDEs. `@opencodehub/lsp-oracle` is the
adapter that lets the ingestion pipeline call those IDE features from
Node, without importing pyright-specific types past this boundary.

## Install

```bash
pnpm add @opencodehub/lsp-oracle
```

The `pyright` npm package is a direct dependency (pinned to `1.1.390` —
the version the spike validated), so there's no separate install step
for the language server.

## Usage

```ts
import { PyrightClient } from "@opencodehub/lsp-oracle";

const client = new PyrightClient({ workspaceRoot: "/path/to/repo" });
await client.start();

try {
  const callers = await client.queryCallers({
    filePath: "src/foo.py",     // relative to workspaceRoot
    line: 42,                   // 1-indexed
    character: 8,               // 1-indexed
    symbolKind: "method",       // one of "class" | "method" | "function" | "property"
    symbolName: "Agent.invoke_async",
  });
  // callers: Array<{ file, line, character, enclosingSymbolName?, source }>

  const refs = await client.queryReferences({
    filePath: "src/foo.py",
    line: 42,
    character: 8,
  });

  const impls = await client.queryImplementations({
    filePath: "src/foo.py",
    line: 42,
    character: 8,
  });
} finally {
  await client.stop();
}
```

### What the client handles for you

- **Subprocess lifecycle.** `start()` spawns pyright, performs the LSP
  handshake, and waits (up to `indexWaitMs`, default 15s) for the initial
  workspace index to finish. `stop()` is idempotent and force-kills after
  a 5s grace period if pyright hangs on shutdown.
- **Content-Length framing + JSON-RPC correlation.** Concurrent requests
  route back to the correct promise by monotonic numeric ID. Out-of-order
  responses work.
- **didOpen per file.** Before any query against a file, the client reads
  the file and sends `textDocument/didOpen`. Pyright won't answer queries
  against URIs it hasn't been told about.
- **Constructor redirect.** When you query callers of a `Foo.__init__`
  method and pyright returns nothing, the client locates the enclosing
  `class Foo` header and re-queries there. Pyright attaches ctor
  references to the class symbol, not `__init__`; consumers should not
  have to know this Python quirk.
- **callHierarchy fallback to references.** If
  `prepareCallHierarchy` returns empty for a symbol, the client falls
  back to `textDocument/references`. Results are tagged with
  `source: "references"` on each `CallerSite` so consumers can downweight
  the provenance in edge scoring.
- **Python env detection.** Looks for `${workspaceRoot}/.venv/bin/python`
  then `.../venv/bin/python`. If neither exists, pyright runs against its
  bundled stdlib — still useful for same-repo resolution, but cross-module
  references into third-party packages won't resolve. `client.getStatus()`
  reports `pythonResolutionMode` so you can attach it to edge provenance.

## What's NOT in this package

- **No graph ingestion.** The ingestion pipeline owns querying symbols,
  batching requests, and writing edges — this package only answers the
  LSP questions.
- **No caching.** Ingestion caches results per-symbol keyed on source
  hash; this client re-queries pyright on every call.
- **No non-Python languages.** basedpyright, ruff-lsp,
  jedi-language-server would need their own adapters. The `FrameDecoder`
  and `JsonRpcDispatcher` classes are reusable; `PyrightClient` is not.

## Reference spikes

See [`reference/`](./reference/) for the two Python spikes that
established wire-level behavior — spike 01 (multilspy + jedi, abandoned
because jedi's call-hierarchy is broken) and spike 02 (raw LSP stdio +
pyright 1.1.390, which this package ports to TypeScript). The spike 02
JSON output (`/tmp/spike-pyright-oracle-report.json`) is the reference
`scripts/validate-lsp-oracle.ts` compares the TS client against.

## Validation

The repository's `scripts/validate-lsp-oracle.ts` runs the same 15-symbol
comparison against sdk-python that the Python spike used. Acceptance
criterion: the TS client produces reference counts within ±5% of the
Python spike per symbol. Run it after making changes to the LSP code:

```bash
pnpm exec tsx scripts/validate-lsp-oracle.ts
```

If `/tmp/spike-pyright-oracle-report.json` doesn't exist, the validation
script will run the Python spike first to regenerate it.
