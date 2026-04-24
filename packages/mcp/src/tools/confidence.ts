/**
 * Confidence-breakdown aggregation for MCP edge-based responses.
 *
 * Every `context` and `impact` response now carries a `confidenceBreakdown`
 * summarising the provenance quality of the underlying edges. The three
 * buckets map directly onto the confidence-demote phase:
 *
 *   - `confirmed` — confidence >= 0.95 AND reason starts with a known LSP
 *     provenance prefix. These are oracle-confirmed by a compiler-grade
 *     language server (pyright, tsserver, gopls, rust-analyzer).
 *   - `heuristic` — 0.2 < confidence < 0.95. Tree-sitter / tier-1 / tier-2
 *     inference that the LSP oracle has not confirmed (either no coverage
 *     for the language, or the LSP was skipped).
 *   - `unknown` — confidence <= 0.2. Heuristic edges that the demote phase
 *     explicitly flagged as contradicted (`+lsp-unconfirmed`) or placeholders
 *     from the parser.
 *
 * The breakdown is a pure read-side aggregation — callers feed in the edges
 * already surfaced by the enclosing tool. It never mutates edges.
 */

import type { CodeRelation } from "@opencodehub/core-types";
import { LSP_PROVENANCE_PREFIXES } from "@opencodehub/core-types";

export interface ConfidenceBreakdown {
  readonly confirmed: number;
  readonly heuristic: number;
  readonly unknown: number;
}

/** Shape we accept from SQL rows without forcing full `CodeRelation` hydration. */
export interface EdgeConfidenceSource {
  readonly confidence: number;
  readonly reason?: string | undefined;
}

const CONFIRMED_FLOOR = 0.95;
const UNKNOWN_CEILING = 0.2;

export function computeConfidenceBreakdown(
  edges: readonly EdgeConfidenceSource[],
): ConfidenceBreakdown {
  let confirmed = 0;
  let heuristic = 0;
  let unknown = 0;
  for (const e of edges) {
    if (e.confidence >= CONFIRMED_FLOOR && hasLspProvenance(e.reason)) {
      confirmed += 1;
    } else if (e.confidence > UNKNOWN_CEILING) {
      heuristic += 1;
    } else {
      unknown += 1;
    }
  }
  return { confirmed, heuristic, unknown };
}

/**
 * Convenience overload for callers that already have hydrated `CodeRelation`
 * instances. Accepts the `CodeRelation` array and re-uses the same aggregation
 * path by narrowing to the two fields we actually consume.
 */
export function computeConfidenceBreakdownFromRelations(
  relations: readonly CodeRelation[],
): ConfidenceBreakdown {
  return computeConfidenceBreakdown(
    relations.map((r) => ({ confidence: r.confidence, reason: r.reason })),
  );
}

function hasLspProvenance(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  for (const prefix of LSP_PROVENANCE_PREFIXES) {
    if (reason.startsWith(prefix)) return true;
  }
  return false;
}
