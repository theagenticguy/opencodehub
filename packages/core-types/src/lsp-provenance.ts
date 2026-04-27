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
];

export const PROVENANCE_PREFIXES: readonly string[] = SCIP_PROVENANCE_PREFIXES;

/** @deprecated — use `SCIP_PROVENANCE_PREFIXES`. Retained transiently for
 *  any ecosystem consumer still importing the legacy name. */
export const LSP_PROVENANCE_PREFIXES: readonly string[] = SCIP_PROVENANCE_PREFIXES;
