# Summarizer reference spikes

These are the three spikes that established the contract and wire-level
behavior for `@opencodehub/summarizer`. They are preserved here as
documentation — not runtime code — so the design record stays close to the
package it motivated.

| File | Stack | What it proved |
|---|---|---|
| `spike-01-anthropic-sdk-bedrock.py` | `anthropic.AnthropicBedrock` + Pydantic v2 | First end-to-end validation of the Pydantic-schema-as-tool-input + ReAct retry pattern. Caught the early "banned prefix" + "side-effects verb" validators firing correctly on Haiku 4.5. Left one open question: `cacheReadInputTokens` reported 0 across all calls. |
| `spike-02-boto3-converse.py` | `boto3` Bedrock Runtime Converse + Pydantic v2 | Dropped the Anthropic SDK adapter and talked to Converse directly. Proved caching engages when the cacheable prefix clears Haiku 4.5's **4,096-token** floor (not 1,024 as Anthropic's first-party docs imply). Measured 72.7% cache efficiency on call 2. Exposed a contract bug: the original `returns.description` max_length=200 was too tight for constructor-heavy symbols. |
| `spike-03-sdk-v3-zod4-converse.ts` | AWS SDK v3 `@aws-sdk/client-bedrock-runtime` + Zod 4 | TypeScript port of spike 02. Confirmed Zod 4's built-in `z.toJSONSchema` emits Draft 2020-12 that Bedrock accepts without conversion. Verified `.strict()` + `superRefine` replicates Pydantic's `extra="forbid"` + `model_validator(mode="after")`. Split `returns.description` into `returns.type_summary` (10-80) + `returns.details` (20-400) and hit **2/2 first-attempt validity** (vs 0/2 in spike 02). Same 72.6% cache efficiency on call 2 — wire parity with boto3 confirmed. |

## Key facts the spikes established

- **Haiku 4.5 on Bedrock caches at a 4,096-token floor, not 1,024.** The
  Anthropic first-party docs quote 1,024; Bedrock enforces 4,096 specifically
  for Haiku 4.5. Caching silently no-ops below the floor.
- **Converse API is the right primitive.** `cachePoint` content blocks
  inside `system` and `toolConfig.tools` are the only way to get cache
  observability; the Anthropic SDK's Bedrock adapter didn't plumb it through
  in our tests.
- **ReAct retry via `toolResult(status: "error")` is load-bearing.** Strict
  validators routinely catch real issues (verb requirement on side_effects,
  banned-prefix on purpose, citation coverage on populated fields). Haiku
  recovers on attempt 2 given structured error feedback.
- **Rich system prompts double as cache padding.** The three-example rubric
  in `src/prompt.ts` is ~5,050 tokens — it clears the 4,096 floor AND pushed
  first-attempt validity from 0/2 (no examples) to 2/2 (three examples).

## Running the spikes

The Python spikes use PEP 723 inline deps and run under `uv`:

```bash
AWS_PROFILE=bedrock-a AWS_REGION=us-east-1 uv run packages/summarizer/reference/spike-02-boto3-converse.py
```

The TS spike runs under `tsx` from the repo root (SDK v3 + Zod 4 are already
workspace-root devDeps):

```bash
AWS_PROFILE=bedrock-a AWS_REGION=us-east-1 pnpm exec tsx packages/summarizer/reference/spike-03-sdk-v3-zod4-converse.ts
```

## When to come back here

Read the spikes when:

- Bedrock ships a new Haiku minor and you suspect the cache floor changed.
- You're adding a new validator to `src/schema.ts` and want to see how
  existing ones were stress-tested.
- You need to debug "why isn't caching working" — spike 01 is the record
  of how the failure looks on the wire.
- You want to port the summarizer contract to a new model (Opus, Sonnet,
  a non-Anthropic Bedrock model) — the spikes are the minimum-viable
  harness for checking schema + caching + retry end-to-end.
