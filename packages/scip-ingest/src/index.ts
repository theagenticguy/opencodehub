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
 *   4. Consumers (the `scip-index` ingestion phase) convert
 *      DerivedEdge → CodeRelation with
 *        `reason = "scip:<indexer-name>@<version>"` and
 *        `confidence = 1.0`, fulfilling the oracle-edge contract that
 *      `confidence-demote` and downstream consumers expect.
 */

export type { DerivedEdge, DerivedIndex, DerivedRelation, DerivedSymbol } from "./derive.js";
export { buildSymbolDefIndex, deriveEdges, deriveIndex } from "./derive.js";
export type {
  ScipDocument,
  ScipIndex,
  ScipOccurrence,
  ScipRange,
  ScipRelationship,
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
export type { ScipIndexerName } from "./provenance.js";
export { scipProvenanceReason } from "./provenance.js";
export type {
  CommandPlan,
  DotnetProbe,
  IndexerKind,
  IndexerResult,
  RunIndexerOptions,
} from "./runners/index.js";
export {
  buildCommand,
  detectLanguages,
  hostedScipBinDirs,
  runIndexer,
  withCodehubBinOnPath,
} from "./runners/index.js";
