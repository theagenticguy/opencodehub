/**
 * `@opencodehub/summarizer` — structured symbol summaries via Bedrock
 * Converse + Zod 4.
 *
 * The summarizer is one leg of the code-retrieval stack: each callable
 * symbol ingested by `@opencodehub/ingestion` gets a strict, citation-
 * grounded summary here, which is then embedded and fused with graph +
 * code embeddings at query time. See `reference/` for the two spike
 * scripts (boto3/Pydantic in Python, SDK-v3/Zod in TypeScript) that
 * validated the wire-level shape and prompt-caching behavior on Bedrock.
 */

export {
  type AttemptUsage,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MODEL_ID,
  type SummarizeInput,
  type SummarizeOptions,
  SummarizerError,
  type SummarizerResult,
  summarizeSymbol,
  TOOL_NAME,
} from "./client.js";

export { buildUserText, SUMMARIZER_PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.js";
export {
  buildToolInputSchema,
  Citation,
  formatZodError,
  InputSpec,
  ReturnSpec,
  SymbolSummary,
  type SymbolSummaryT,
  validateCitationLines,
} from "./schema.js";
