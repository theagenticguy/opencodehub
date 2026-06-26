/**
 * F2LLM query-prefix helper.
 *
 * F2LLM-v2-80M is an asymmetric retrieval model: QUERY text is wrapped in an
 * `Instruct: {instruction}\nQuery: {query}` template, while DOCUMENT text is
 * embedded raw. Applying the prefix to documents (or omitting it on queries)
 * degrades retrieval. This module is the single source of truth for the
 * instruction string and the wrapping format so the query path
 * (`embedQuery`) and any backend that prefixes caller-side stay in lockstep.
 *
 * The instruction string is the one validated in the POC ranking parity
 * harness (`export/verify_ranking.py`).
 */

/** The retrieval instruction prepended to every query (F2LLM contract). */
export const F2LLM_QUERY_INSTRUCTION =
  "Given a code search query, retrieve the most relevant code snippet.";

/**
 * Wrap raw query text in the F2LLM `Instruct:`/`Query:` template. Documents
 * must NOT be passed through this — embed them raw.
 */
export function buildQueryText(query: string): string {
  return `Instruct: ${F2LLM_QUERY_INSTRUCTION}\nQuery: ${query}`;
}
