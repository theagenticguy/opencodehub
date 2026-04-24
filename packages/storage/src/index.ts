export { DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
export type {
  BulkLoadStats,
  CochangeLookupOptions,
  CochangeRow,
  CochangeStore,
  EmbeddingGranularity,
  EmbeddingRow,
  IGraphStore,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  SymbolSummaryRow,
  SymbolSummaryStore,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "./interface.js";
export { readStoreMeta, writeStoreMeta } from "./meta.js";
export {
  DB_FILE_NAME,
  META_DIR_NAME,
  META_FILE_NAME,
  REGISTRY_FILE_NAME,
  resolveDbPath,
  resolveMetaFilePath,
  resolveRegistryPath,
  resolveRepoMetaDir,
} from "./paths.js";
export { generateSchemaDDL, type SchemaOptions } from "./schema-ddl.js";
export { assertReadOnlySql, SqlGuardError } from "./sql-guard.js";
