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
  | "scip-java"
  | "scip-clang"
  | "scip-ruby"
  | "scip-dotnet"
  | "scip-kotlin"
  | "scip-php"
  | "scip-dart";

export function scipProvenanceReason(indexer: ScipIndexerName, version: string): string {
  const v = version.trim() || "unknown";
  return `scip:${indexer}@${v}`;
}

/**
 * Third-party / pre-alpha SCIP indexers that are NOT first-party (CSC-governed)
 * oracles. Their edges carry the distinct **`scip-unofficial:` (Tier 1.5)**
 * provenance class so a reader can tell a pre-alpha indexer's edge apart from a
 * first-party `scip:` (Tier-1, oracle-confirmed) edge.
 */
export type ScipUnofficialIndexerName = "scip-php" | "scip-dart";

/**
 * Build a Tier-1.5 provenance reason: `scip-unofficial:<indexer>@<version>`.
 * Mirrors {@link scipProvenanceReason} but emits the `scip-unofficial:` prefix
 * so writers (php/dart runners) cannot drift from readers
 * (`SCIP_UNOFFICIAL_PROVENANCE_PREFIXES` in `@opencodehub/core-types`). An edge
 * built here MUST NOT match `SCIP_PROVENANCE_PREFIXES` — it is NOT an oracle.
 */
export function scipUnofficialProvenanceReason(
  indexer: ScipUnofficialIndexerName,
  version: string,
): string {
  const v = version.trim() || "unknown";
  return `scip-unofficial:${indexer}@${v}`;
}
