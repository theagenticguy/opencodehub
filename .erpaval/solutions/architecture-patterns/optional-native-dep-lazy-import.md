---
title: Make a heavy native dep optional + lazy so a default install can prune it
tags: [onnxruntime, optionalDependencies, dynamic-import, native, install-size, embedder, type-only-import]
modules:
  - packages/embedder/package.json
  - packages/embedder/src/onnx-embedder.ts
first_applied: 2026-06-04
session: session-a99b0c
track: knowledge
category: architecture-patterns
---

# Make a heavy native dep optional + lazy so a default install can prune it

## Context

`onnxruntime-node` (~254 MB native binary) was a hard `dependency` of
`@opencodehub/embedder`, eagerly imported at module top-level — so it resolved
at install AND loaded on import, even though embeddings are OFF by default and
most users run BM25-only. Goal: a default install can omit it; it loads only
when embeddings are actually opened.

## The pattern (three coordinated moves)

1. **`dependencies` → `optionalDependencies`** in `package.json`. (Keep it OUT
   of `devDependencies` too — pnpm installs optional deps by default, so type
   resolution and tests still work in the workspace.)

2. **Top-level value import → top-level TYPE-only import.** Types are erased at
   compile, so this never triggers a runtime resolution:
   ```ts
   import type { InferenceSession, Tensor } from "onnxruntime-node";
   ```

3. **Dynamic `import()` at the use site**, threading any runtime *constructor*
   (here `Tensor`, used as `new Tensor(...)`) into the consumer:
   ```ts
   let InferenceSession, Tensor;
   try {
     ({ InferenceSession, Tensor } = await import("onnxruntime-node"));
   } catch (cause) {
     throw new EmbedderNotSetupError("onnxruntime-node is not installed …", { cause });
   }
   ```
   A class that previously closed over the imported `Tensor` value must now
   receive it via constructor param (`readonly #Tensor: typeof Tensor`) — the
   type-only import gives you the *type*, the dynamic import gives you the
   *value*.

## Gotchas

- **A bundler must mark it `external`.** If the consuming CLI is bundled
  (tsup/esbuild), add the optional dep to `external` so the bundler doesn't try
  to inline a `.node` binary. See [[tsup-collapse-monorepo-to-single-cli]].
- **`optionalDependencies` still install by default.** The real prune requires
  the END USER to pass `npm i --omit=optional` (or use a remote embedder). The
  lazy import guarantees it's never LOADED without embeddings, but "pruned on
  every install" is not automatic — document the flag.
- **Throw a typed, actionable error on the dynamic-import catch**, not a raw
  `ERR_MODULE_NOT_FOUND`. The user reached weight-load already (weights present)
  so the binding genuinely should be there; name the remediation.

## Verification

80/80 embedder tests pass; `dist/onnx-embedder.js` shows `await
import("onnxruntime-node")` with zero top-level require; BM25-only path runs
with the binding absent.
