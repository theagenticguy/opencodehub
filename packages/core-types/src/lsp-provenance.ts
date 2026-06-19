/**
 * Oracle-edge provenance reason prefixes shared between the ingestion
 * confidence-demote phase, the summarize trust filter, the MCP
 * confidence-breakdown helper, and the analyze CLI's auto-cap.
 *
 * An edge is treated as "oracle-confirmed" when its `reason` starts with one
 * of these prefixes AND its confidence is at the oracle ceiling (1.0).
 * Prefixes are matched with `string.startsWith(...)`; the trailing `@`
 * segment is typically followed by a version identifier
 * (e.g. `scip:scip-typescript@0.4.0`).
 */
export const SCIP_PROVENANCE_PREFIXES: readonly string[] = [
  "scip:scip-typescript@",
  "scip:scip-python@",
  "scip:scip-go@",
  "scip:rust-analyzer@",
  "scip:scip-java@",
  "scip:scip-clang@",
  "scip:scip-ruby@",
  "scip:scip-dotnet@",
  "scip:scip-kotlin@",
];

/**
 * **Tier 1.5 (`scip-unofficial:`)** provenance prefixes — third-party /
 * pre-alpha SCIP indexers (php, dart) that are NOT first-party, CSC-governed
 * oracles. An edge whose `reason` starts with one of these is MID-confidence:
 * SCIP-shaped and deterministic, but NOT oracle-confirmed.
 *
 * This set is deliberately DISJOINT from {@link SCIP_PROVENANCE_PREFIXES} (which
 * stays first-party-only). A `scip-unofficial:` edge MUST NOT be treated as an
 * oracle confirmer by the confidence-demote phase, and MUST be surfaced as its
 * own tier (not merged into the first-party `confirmed` bucket) by the MCP
 * confidence-breakdown helper. Keeping the two arrays separate is what enforces
 * that split at every reader.
 */
export const SCIP_UNOFFICIAL_PROVENANCE_PREFIXES: readonly string[] = [
  "scip-unofficial:scip-php@",
  "scip-unofficial:scip-dart@",
];

export const PROVENANCE_PREFIXES: readonly string[] = SCIP_PROVENANCE_PREFIXES;
