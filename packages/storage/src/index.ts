export { assertReadOnlyCypher, CypherGuardError } from "./cypher-guard.js";
export { classifyLicenseTier, DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
export {
  GraphDbBindingError,
  GraphDbStore,
  type GraphDbStoreOptions,
  NotImplementedError,
} from "./graphdb-adapter.js";
export {
  type GraphDbSchemaOptions,
  generateSchemaDdl,
  getAllRelationTypes,
} from "./graphdb-schema.js";
export type {
  AncestorTraversalOptions,
  BulkLoadOptions,
  BulkLoadProgressEvent,
  BulkLoadStats,
  CochangeLookupOptions,
  CochangeRow,
  ConsumerProducerEdge,
  DescendantTraversalOptions,
  EmbeddingGranularity,
  EmbeddingRow,
  GraphDialect,
  IGraphStore,
  ITemporalStore,
  ListDependenciesOptions,
  ListEdgesByTypeOptions,
  ListEdgesOptions,
  ListEmbeddingsOptions,
  ListFindingsOptions,
  ListNodesByKindOptions,
  ListNodesByNameOptions,
  ListNodesOptions,
  ListRoutesOptions,
  OpenStoreResult,
  SearchQuery,
  SearchResult,
  SqlParam,
  Store,
  StoreMeta,
  SymbolSummaryRow,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "./interface.js";
export { readStoreMeta, writeStoreMeta } from "./meta.js";
export {
  describeArtifacts,
  META_DIR_NAME,
  META_FILE_NAME,
  REGISTRY_FILE_NAME,
  resolveGraphPath,
  resolveMetaFilePath,
  resolveRegistryPath,
  resolveRepoMetaDir,
} from "./paths.js";
export { generateSchemaDDL, type SchemaOptions } from "./schema-ddl.js";
export { assertReadOnlySql, SqlGuardError } from "./sql-guard.js";

import { dirname, join } from "node:path";
import { DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
import { GraphDbStore, type GraphDbStoreOptions } from "./graphdb-adapter.js";
import type { OpenStoreOptions as ApiOpenStoreOptions, OpenStoreResult } from "./interface.js";
import { describeArtifacts } from "./paths.js";

/**
 * Combined options accepted by {@link openStore}. Backwards-compatible
 * superset of the spec-level {@link ApiOpenStoreOptions} that adds the
 * `duckOptions` / `graphDbOptions` adapter-specific bag so existing
 * callers (analyze CLI, ingestion harness) can pass through precise
 * per-backend tuning.
 */
export interface OpenStoreOptions extends ApiOpenStoreOptions {
  readonly duckOptions?: DuckDbStoreOptions;
  readonly graphDbOptions?: GraphDbStoreOptions;
}

/**
 * Compose paired graph + temporal artifact paths. The graph artifact is
 * `<dir>/graph.lbug` (lbug owns this file); the temporal sidecar is
 * `<dir>/temporal.duckdb`.
 *
 * The input `path` is treated as the directory anchor — its dirname is
 * the `<repo>/.codehub/` parent, and the canonical filenames are
 * appended. `:memory:` is a special case for tests: both views resolve
 * to `:memory:` and no filesystem layout applies.
 */
function composeArtifactPaths(path: string): { graphFile: string; temporalFile: string } {
  if (path === ":memory:") {
    return { graphFile: ":memory:", temporalFile: ":memory:" };
  }
  const dir = dirname(path);
  const { graphFile, temporalFile } = describeArtifacts();
  return {
    graphFile: join(dir, graphFile),
    temporalFile: join(dir, temporalFile),
  };
}

/**
 * Factory that returns a composed graph + temporal {@link OpenStoreResult}.
 *
 * A `GraphDbStore` instance backs the `graph` view at `<dir>/graph.lbug`;
 * a separate `DuckDbStore` over the sibling `<dir>/temporal.duckdb`
 * backs the `temporal` view. `OpenStoreResult.close()` closes both in
 * deterministic order — graph first, temporal second.
 *
 * The factory only constructs — callers still own the `open()` lifecycle
 * call so failures are attributable to the lifecycle boundary rather
 * than the factory.
 */
export async function openStore(opts: OpenStoreOptions): Promise<OpenStoreResult> {
  const { graphFile, temporalFile } = composeArtifactPaths(opts.path);

  const graphDbOptions: GraphDbStoreOptions = {
    ...(opts.graphDbOptions ?? {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.embeddingDim !== undefined ? { embeddingDim: opts.embeddingDim } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const duckOptions: DuckDbStoreOptions = {
    ...(opts.duckOptions ?? {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  const graph = new GraphDbStore(graphFile, graphDbOptions);
  const temporal = new DuckDbStore(temporalFile, duckOptions);
  return {
    graph,
    temporal,
    graphFile,
    temporalFile,
    close: async () => {
      await graph.close();
      await temporal.close();
    },
  };
}
