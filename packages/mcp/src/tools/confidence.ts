/**
 * Confidence-breakdown aggregation for MCP edge-based responses.
 *
 * Every `context` and `impact` response now carries a `confidenceBreakdown`
 * summarising the provenance quality of the underlying edges. The buckets map
 * directly onto the confidence-demote phase:
 *
 *   - `confirmed` — confidence >= 0.95 AND reason starts with a first-party
 *     `scip:` provenance prefix. These are oracle-confirmed by a compiler-grade
 *     first-party indexer (scip-python, scip-typescript, scip-go, …).
 *   - `scipUnofficial` — reason starts with a `scip-unofficial:` (Tier 1.5)
 *     prefix. These come from third-party / pre-alpha SCIP indexers (php, dart)
 *     that are SCIP-shaped and deterministic but NOT first-party oracles. They
 *     are surfaced as their own tier so a consumer can tell a first-party edge
 *     from a pre-alpha one (AC-A3) — they are NOT folded into `confirmed`.
 *   - `heuristic` — 0.2 < confidence < 0.95 AND not a Tier-1.5 edge. Tree-sitter
 *     / tier-1 / tier-2 inference the oracle has not confirmed.
 *   - `unknown` — confidence <= 0.2. Heuristic edges the demote phase explicitly
 *     flagged as contradicted (`+scip-unconfirmed`) or parser placeholders.
 *
 * The breakdown is a pure read-side aggregation — callers feed in the edges
 * already surfaced by the enclosing tool. It never mutates edges.
 */

import type { CodeRelation } from "@opencodehub/core-types";
import {
  SCIP_PROVENANCE_PREFIXES,
  SCIP_UNOFFICIAL_PROVENANCE_PREFIXES,
} from "@opencodehub/core-types";

export interface ConfidenceBreakdown {
  readonly confirmed: number;
  /** Tier 1.5 — reason starts with a `scip-unofficial:` prefix (php/dart). */
  readonly scipUnofficial: number;
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
  let scipUnofficial = 0;
  let heuristic = 0;
  let unknown = 0;
  for (const e of edges) {
    if (e.confidence >= CONFIRMED_FLOOR && hasLspProvenance(e.reason)) {
      // First-party oracle. Checked first so a first-party edge can never be
      // miscounted as Tier 1.5.
      confirmed += 1;
    } else if (hasScipUnofficialProvenance(e.reason)) {
      // Tier 1.5 (php/dart). Keyed off the `scip-unofficial:` reason prefix, NOT
      // the numeric confidence — so a Tier-1.5 edge surfaces as its own tier
      // regardless of where its mid-confidence value sits in the heuristic band.
      // A demoted Tier-1.5 edge (confidence <= 0.2, `+scip-unconfirmed`) still
      // falls through to `unknown` below because its reason no longer leads with
      // the bare prefix — but a clean Tier-1.5 edge counts here.
      scipUnofficial += 1;
    } else if (e.confidence > UNKNOWN_CEILING) {
      heuristic += 1;
    } else {
      unknown += 1;
    }
  }
  return { confirmed, scipUnofficial, heuristic, unknown };
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
  for (const prefix of SCIP_PROVENANCE_PREFIXES) {
    if (reason.startsWith(prefix)) return true;
  }
  return false;
}

/** True iff `reason` starts with a Tier-1.5 `scip-unofficial:` prefix (php/dart). */
function hasScipUnofficialProvenance(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  for (const prefix of SCIP_UNOFFICIAL_PROVENANCE_PREFIXES) {
    if (reason.startsWith(prefix)) return true;
  }
  return false;
}
