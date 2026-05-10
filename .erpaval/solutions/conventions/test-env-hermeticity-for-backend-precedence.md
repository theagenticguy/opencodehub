---
name: Tests for backend-precedence libraries must wipe all env keys in the precedence chain, not just the one they assert
description: When an SDK picks a backend by env presence (CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT, CODEHUB_EMBEDDING_URL, ...), tests of "backend X is picked when only X's env is set" must scope-stash every key in the chain, not only the local one
type: conventions
---

`packages/embedder/src/http-embedder.test.ts:441,458` asserted that
`tryOpenHttpEmbedder` returns `null` when its specific env var is unset.
The test only stashed `CODEHUB_HOME`. With
`CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` exported in the operator's shell,
the higher-precedence SageMaker backend short-circuited, the assertion
flipped, and the test failed — but only on the specific dev box where
the operator was working through SageMaker integration.

The fix: a `sanitizeEmbeddingEnv()` helper that snapshots and wipes
every `CODEHUB_EMBEDDING_*` key plus `CODEHUB_HOME`, restored on
teardown via `beforeEach`/`afterEach`:

```ts
function sanitizeEmbeddingEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CODEHUB_EMBEDDING_") || k === "CODEHUB_HOME") {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}
```

**Why:** the backend-precedence pattern is a chain — env-X-set → backend-X,
else env-Y-set → backend-Y, else fallback. A test that asserts about
backend Y must explicitly clear backend-X's env, otherwise the assertion
silently tests the wrong code path under any operator who happens to
have backend-X configured. The failure is non-reproducible on a clean
laptop, fires on a dev box with the higher-precedence env exported.
This is exactly the env-leak class that bedevils CI-vs-local divergence
debugging.

**How to apply:**

1. **Identify the precedence chain.** For OCH embedder:
   `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` → `CODEHUB_EMBEDDING_URL` →
   `CODEHUB_EMBEDDING_*` (HTTP options) → `CODEHUB_HOME` (local ONNX).
   Any test that asserts about backend selection must wipe the entire
   chain, not just one key.
2. **Stash with a prefix glob, not a fixed key list.** `Object.keys`
   filtered by `startsWith("CODEHUB_EMBEDDING_")` catches keys added
   later (e.g. a future `CODEHUB_EMBEDDING_AZURE_*`) without revisiting
   every test.
3. **Wire it as `beforeEach`/`afterEach`, not per-case try/finally.**
   Easier to audit; harder to forget on the next case.
4. **Apply defensively to sibling describe blocks.** Even cases that
   don't care about the env can be poisoned by stale state from a prior
   test that mutated `process.env`. Hermetic test suites don't pay a
   cost for being defensive.

Anti-pattern: per-case `originalKey = process.env[KEY]; ... finally
process.env[KEY] = originalKey` for a single key. The single-key save
worked when there was one env var; with a chain, every test that misses
a sibling key in the chain becomes flaky on operator boxes.

Cross-link: pairs with the existing `sagemaker-embedder-backend.md`
durable lesson — that one covers the SDK-side dynamic-import + soft-fail
pattern; this one covers the test-side env-hermeticity pattern that
that pattern requires.
