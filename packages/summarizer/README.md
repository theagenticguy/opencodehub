# @opencodehub/summarizer

Structured, citation-grounded summaries of callable code symbols, generated
by Haiku 4.5 on Bedrock and validated by a strict Zod 4 contract. Consumed
by OpenCodeHub's retrieval stack — each summary is embedded field-by-field
and fused with graph + code embeddings at query time so natural-language
questions ("where does auth token refresh happen?") match against the
described behavior, not just identifier tokens.

## Contract

The output shape is defined in [`src/schema.ts`](./src/schema.ts) and
enforced by `SymbolSummary.safeParse`. Fields:

| Field | Shape | What it's for |
|---|---|---|
| `purpose` | 30-400 chars, must not start with "This function/method/class" | Verb-led behavior statement; drives `purpose` embedding for "what does this do" queries |
| `inputs` | `InputSpec[]` with `name` / `type` / `description` | Semantic (not just type-system) description of each parameter |
| `returns` | `{ type, type_summary, details }` split so constructors don't trip length caps | Describes the return contract; for `None` returns, describes the mutation the call produces |
| `side_effects` | `string[]`, each item must contain one of `reads/writes/emits/raises/mutates` | The operational contract surface — what this symbol does to the world |
| `invariants` | `string[] \| null` — optional caller-side preconditions | Contracts enforced by the code, not general advice |
| `citations` | `Citation[]` — at least one per populated field | Line ranges grounding every claim; used by a staleness detector to drop drifted summaries |

## Usage

```ts
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { summarizeSymbol } from "@opencodehub/summarizer";

const client = new BedrockRuntimeClient({ region: "us-east-1" });

const result = await summarizeSymbol(client, {
  source: "<source text>",
  filePath: "src/foo.py",
  lineStart: 42,
  lineEnd: 98,
  docstring: "<docstring>",
  enclosingClass: "FooClass",
});

console.log(result.summary.purpose);
console.log(`attempts=${result.attempts} cacheRead=${result.usageByAttempt[0].cacheRead}`);
```

## Integration

- **Ingestion call site:** `packages/ingestion/src/pipeline/phases/summarize.ts`
  invokes `summarizeSymbol` once per high-confidence callable (SCIP-backed
  Function / Method / Class), gated by `--summaries` + budget + offline flags.
  Results land in the `symbol_summaries` DuckDB table (see
  `packages/storage/src/schema-ddl.ts`); they never mutate graph nodes or edges.
- **Retrieval site:** `packages/ingestion/src/pipeline/phases/embeddings.ts`
  fuses each summary into the symbol-tier embedding (`signature + summary +
  body`), so natural-language queries match against described behavior at
  vector-search time.

## Bedrock specifics

- **Model:** `global.anthropic.claude-haiku-4-5-20251001-v1:0` (override via
  `SummarizeOptions.modelId`).
- **Prompt caching:** two `cachePoint` blocks engage caching — one after the
  system prompt, one after the tool spec. Haiku 4.5 on Bedrock requires a
  **4,096-token** cacheable prefix; `src/prompt.ts` is sized to ~5,050 tokens
  to clear the floor with margin.
- **Structured output:** the tool's `inputSchema` is the JSON Schema
  exported from Zod via `z.toJSONSchema`. `toolChoice` forces the model to
  respond through the tool, so free-form prose is not possible.
- **ReAct retry:** on `safeParse` failure, the client feeds the error list
  back through a `toolResult(status: "error")` content block and re-calls
  Converse. Max 3 attempts by default. The retry is load-bearing: in spike
  testing, strict validators caught real issues (`side_effects` items
  missing a required verb, citations falling outside the source span), and
  Haiku recovered on attempt 2 given the structured error.

## Reference spikes

See [`reference/`](./reference/) for the three spikes that established the
wire-level behavior — the Anthropic SDK failure, the boto3 Converse port
that fixed caching, and the TypeScript / Zod 4 / SDK v3 port that this
package was extracted from.
