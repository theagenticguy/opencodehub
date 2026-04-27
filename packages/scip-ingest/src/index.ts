/**
 * `@opencodehub/scip-ingest` — decode SCIP indexes and produce
 * graph-ready CodeRelation edges.
 *
 * Pipeline shape (per language):
 *   1. Run the per-language SCIP indexer (see `./runners/*`) to produce
 *      a `.scip` file.
 *   2. `parseScipIndex(fsReadSync(path))` decodes the protobuf stream.
 *   3. `deriveIndex(index)` computes caller->callee edges via innermost-
 *      enclosing-range attribution (see `./derive.ts`).
 *   4. `materialize(edges)` produces blast-score metrics +
 *      reach-forward / reach-backward closures for the MCP retrieval
 *      pack.
 *   5. Consumers (the `scip-index` ingestion phase) convert
 *      DerivedEdge → CodeRelation with
 *        `reason = "scip:<indexer-name>@<version>"` and
 *        `confidence = 1.0`, fulfilling the oracle-edge contract that
 *      `confidence-demote` and downstream consumers expect.
 */

export type { DerivedEdge, DerivedIndex, DerivedSymbol } from "./derive.js";
export { deriveEdges, deriveIndex, findOccurrencesBySymbol } from "./derive.js";
export type {
  BlastMetrics,
  MaterializeOptions,
  MaterializeResult,
  ReachPair,
} from "./materialize.js";
export { materialize } from "./materialize.js";
export type {
  ScipDocument,
  ScipIndex,
  ScipOccurrence,
  ScipRange,
  ScipSymbolInformation,
  ScipToolInfo,
} from "./parse.js";
export {
  parseScipIndex,
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
  SCIP_ROLE_READ_ACCESS,
  SCIP_ROLE_WRITE_ACCESS,
} from "./parse.js";
export { scipProvenanceReason } from "./provenance.js";
export type { IndexerKind, IndexerResult, RunIndexerOptions } from "./runners/index.js";
export { detectLanguages, runIndexer } from "./runners/index.js";
