---
name: SageMaker embedder backend — AWS SDK + testable seam pattern
description: Pattern for adding a new Embedder backend to @opencodehub/embedder that invokes an AWS service. Covers dynamic-import + credential soft-fail, structural runtime typing for testability, mixed sync/async return to preserve call-site shape, and modelId stamping for index compatibility.
type: knowledge
tags: embedder, aws-sdk, sagemaker, bedrock, dynamic-import, credential-soft-fail, backend-switch, structural-typing
modules:
  - packages/embedder/src/sagemaker-embedder.ts
  - packages/embedder/src/index.ts
  - packages/ingestion/src/pipeline/phases/summarize.ts
---

# Pattern: adding a new Embedder backend that calls an AWS service

Context: opencodehub's `@opencodehub/embedder` package exposes an `Embedder`
interface (`dim`, `modelId`, `embed`, `embedBatch`, `close`) with three
backends as of session-8564bf: ONNX (local), HTTP (OpenAI-compatible), and
SageMaker Runtime. Future backends (Bedrock Titan, self-hosted TEI on a
different protocol, etc.) should follow the same shape.

## The contract

One file per backend: `packages/embedder/src/<name>-embedder.ts`, exporting:

1. `interface <Name>EmbedderConfig { ... }` — never imports SDK types. Expose
   an optional `runtime?: <Name>RuntimeLike` test seam.
2. `async function open<Name>Embedder(cfg): Promise<Embedder>` — returns an
   `Embedder` that conforms to the shared interface.
3. `function read<Name>EmbedderConfigFromEnv(): <Name>EmbedderConfig | null`
   — returns `null` when env vars are absent so callers fall through.

## Dynamic import + credential soft-fail

Match the repo's Bedrock pattern at
`packages/ingestion/src/pipeline/phases/summarize.ts:411-439`. The key: AWS
credential chain failures must not crash the process, they must surface as
`EmbedderNotSetupError` so `tryOpenHttpEmbedder` / `tryOpenEmbedder` callers
can degrade to a different backend or BM25.

```ts
try {
  const mod = await import("@aws-sdk/client-<service>");
  runtime = new mod.<Service>Client({ region, maxAttempts });
} catch (err) {
  if (isMissingCredentialsError(err)) {
    throw new EmbedderNotSetupError(
      `<Backend>: AWS credentials are not configured...`,
      { cause: err as Error },
    );
  }
  throw err;
}
```

Copy `isMissingCredentialsError` verbatim — it checks the name field for
`CredentialsProviderError | NoCredentialsError | ExpiredTokenException`
plus four well-known message substrings. The repo convention is to match
on duck-typed shapes rather than importing `@smithy/types`, so test fakes
that merely set `name` still work.

Credentials can also fail at first `send()`, not only at client
construction (expired SSO, for example). Wrap every `send()` call in a
second `isMissingCredentialsError` branch that also throws
`EmbedderNotSetupError` — the soft-fail has to work on both paths.

## Structural runtime typing for testability

Do not import the SDK's `<Service>Client` type into your config interface.
Instead declare a narrow structural type in your backend file:

```ts
export interface <Name>RuntimeLike {
  send(command: { readonly input: { ... } }): Promise<{ readonly Body?: Uint8Array }>;
}
```

Two benefits: (1) tests inject a fake runtime without pulling the SDK's
surface into the test file; (2) you sidestep ESM/CJS dual-package friction
that can appear when test runners resolve SDK types differently from the
build.

Export the interface from `packages/embedder/src/index.ts` alongside the
backend's config and factory so tests can import it cleanly.

## Test-time bypass of the SDK class

With `cfg.runtime` supplied, skip the dynamic import entirely and
construct a plain carrier class inline:

```ts
if (cfg.runtime !== undefined) {
  runtime = cfg.runtime;
  InvokeCommand = class {
    readonly input: InvokeInput;
    constructor(input: InvokeInput) { this.input = input; }
  };
}
```

The real SDK's `Command` classes carry only the `.input` property that
`client.send()` reads, so a structural shim is sufficient. No SDK module
is loaded in unit tests — they run in-process without network / credential
state.

## Mixed sync/async return from `tryOpenHttpEmbedder`

Adding an async backend to an existing synchronous factory is a shape
migration. Keep the existing HTTP/sync path intact and let the new async
path return `Promise<Embedder>` from the same function:

```ts
export function tryOpenHttpEmbedder(options = {}):
  Embedder | Promise<Embedder> | null
```

All three call sites (`packages/mcp/src/tools/query.ts:455`,
`packages/cli/src/commands/query.ts:122`,
`packages/ingestion/src/pipeline/phases/embeddings.ts:454`) already do
`const e = mod.tryOpenHttpEmbedder(); if (e !== null) return e;` inside
an `async` function — `async` functions auto-await a returned promise.
Only synchronous `.embed()` callers (e.g. the http-embedder unit test)
need an added `await`. Two-line churn across the callsite surface.

## modelId stamping for index compatibility

Every backend stamps `modelId` distinctly so a backend switch is visible
in the index's `embeddings.model` column:

- ONNX: `gte-modernbert-base/fp32` (or `/int8`)
- HTTP: whatever `CODEHUB_EMBEDDING_MODEL` passes through
- SageMaker: `gte-modernbert-base/sagemaker:<endpoint-name>`

A rebuild-on-switch refusal check is deferred (see `debt.md`), but the
distinct stamp alone makes drift observable at the `Embedder.modelId`
interface. Re-use the same convention for future backends — never let two
backends produce the same modelId unless they produce bit-identical
vectors.

## Batching with ≤N chunks and 413 split-retry

Endpoint batch caps (SageMaker TEI: 64 inputs / 16384 tokens) are enforced
in `embedBatch` via a trivial `for (i = 0; i < texts.length; i += MAX_BATCH)`
loop. Do not implement client-side token accounting in v1 — rely on the
endpoint's validation error (`ValidationException` / HTTP 413) and fall
back to a single-text re-chunk. One round-trip wasted on the rare oversize
batch is cheaper than a tokenizer dependency in every install.

## Checklist for a new backend

1. New file `packages/embedder/src/<name>-embedder.ts` (<200 LOC).
2. Add SDK dep to `packages/embedder/package.json` at the same version as
   existing AWS SDKs in the workspace (one-version-across-the-monorepo).
3. Re-export `open<Name>Embedder`, `read<Name>EmbedderConfigFromEnv`, the
   config type, and the `RuntimeLike` interface from `index.ts`.
4. Wire into `openEmbedder` with a new optional option and a branch before
   the HTTP branch.
5. Wire into `tryOpenHttpEmbedder` precedence — new backend first, HTTP
   second, `null` last.
6. Honor the `offline` guard — remote backends throw in offline mode.
7. Unit tests with injected `runtime`, gated integration test, README
   section.

Reference implementation in git history at session-8564bf:
`packages/embedder/src/sagemaker-embedder.ts`.
