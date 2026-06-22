export { assertReadOnlyCypher, CypherGuardError } from "./cypher-guard.js";
export { DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
export { classifyLicenseTier } from "./license.js";
export { getAllRelationTypes } from "./relations.js";
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
export { installSqliteRuntimeGuard } from "./sqlite-runtime.js";
export { SqliteStore, type SqliteStoreOptions } from "./sqlite-adapter.js";
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
import type { OpenStoreOptions as ApiOpenStoreOptions, OpenStoreResult } from "./interface.js";
import { SqliteStore, type SqliteStoreOptions } from "./sqlite-adapter.js";

/**
 * Combined options accepted by {@link openStore}. Superset of the spec-level
 * {@link ApiOpenStoreOptions} that adds the SQLite-adapter tuning bag. The
 * single-file store replaced the lbug + DuckDB pair (ADR 0017), so the former
 * `duckOptions` / `graphDbOptions` per-backend bags are gone.
 */
export interface OpenStoreOptions extends ApiOpenStoreOptions {
  /** SQLite-adapter tuning (journal mode, busy timeout). */
  readonly sqliteOptions?: SqliteStoreOptions;
}

/**
 * Resolve the single store file. The whole index now lives in ONE
 * `<dir>/store.sqlite` (WAL) — there is no graph.lbug / temporal.duckdb
 * split. The input `path` is the directory anchor (its dirname is the
 * `<repo>/.codehub/` parent); `:memory:` short-circuits for tests.
 */
function resolveStoreFile(path: string): string {
  if (path === ":memory:") return ":memory:";
  return join(dirname(path), "store.sqlite");
}

/**
 * Factory returning an {@link OpenStoreResult} whose `graph` and `temporal`
 * views are the SAME {@link SqliteStore} instance over one
 * `<dir>/store.sqlite` file. Because one object satisfies both
 * {@link IGraphStore} and {@link ITemporalStore}, every existing call site
 * (`store.graph.X()` / `store.temporal.Y()`) keeps working unchanged — both
 * now hit the same connection and file.
 *
 * The factory only constructs; callers own the `open()` lifecycle. Opening
 * the shared instance twice (once via `store.graph`, once via
 * `store.temporal`, as the CLI's open-store helper does) is safe — `open()`
 * is idempotent. `close()` closes the single handle once.
 */
export async function openStore(opts: OpenStoreOptions): Promise<OpenStoreResult> {
  const storeFile = resolveStoreFile(opts.path);

  const sqliteOptions: SqliteStoreOptions = {
    ...(opts.sqliteOptions ?? {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.embeddingDim !== undefined ? { embeddingDim: opts.embeddingDim } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  const store = new SqliteStore(storeFile, sqliteOptions);
  let closed = false;
  return {
    graph: store,
    temporal: store,
    graphFile: storeFile,
    temporalFile: storeFile,
    close: async () => {
      // Both views are one instance; close once even though callers may
      // invoke close() through the single envelope.
      if (closed) return;
      closed = true;
      await store.close();
    },
  };
}
