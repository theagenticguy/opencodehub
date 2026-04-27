/**
 * Canonical oracle-edge reason strings for SCIP-derived edges.
 *
 * Consumers (confidence-demote, summarize, mcp/confidence, cli/analyze)
 * match `reason.startsWith("scip:<indexer>@")` against
 * `SCIP_PROVENANCE_PREFIXES` from `@opencodehub/core-types`. This helper
 * builds the string so writers cannot drift from readers.
 */

export type ScipIndexerName =
  | "scip-typescript"
  | "scip-python"
  | "scip-go"
  | "rust-analyzer"
  | "scip-java";

export function scipProvenanceReason(indexer: ScipIndexerName, version: string): string {
  const v = version.trim() || "unknown";
  return `scip:${indexer}@${v}`;
}
