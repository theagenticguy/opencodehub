export { DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
export {
  GraphDbBindingError,
  GraphDbStore,
  type GraphDbStoreOptions,
  NotImplementedError,
} from "./graphdb-adapter.js";
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

import { DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
import { GraphDbStore, type GraphDbStoreOptions } from "./graphdb-adapter.js";
import type { IGraphStore } from "./interface.js";

/**
 * Options for {@link openStore}. `backend` resolves the adapter:
 *   - `"duck"` — always use `DuckDbStore` (default on M3 phase-1).
 *   - `"lbug"` — always use `GraphDbStore` (graph-db backend, opt-in).
 *   - `"auto"` or omitted — read the `CODEHUB_STORE` env var; `"duck"` or
 *     unset → `DuckDbStore`, `"lbug"` → `GraphDbStore`. Any other value is
 *     a hard error (spec 004 §S-M3-1).
 *
 * Keep the return type as `IGraphStore` so callers never reach into the
 * concrete adapter surface from the factory.
 */
export interface OpenStoreOptions {
  readonly path: string;
  readonly backend?: "duck" | "lbug" | "auto";
  readonly duckOptions?: DuckDbStoreOptions;
  readonly graphDbOptions?: GraphDbStoreOptions;
}

const ENV_VAR = "CODEHUB_STORE";

type ResolvedBackend = "duck" | "lbug";

/**
 * Resolve the concrete backend id. Exported separately so tests can assert
 * env-var behaviour without spinning up a real store instance.
 */
export function resolveStoreBackend(
  backend: OpenStoreOptions["backend"],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBackend {
  if (backend === "duck" || backend === "lbug") return backend;
  const raw = env[ENV_VAR];
  if (raw === undefined || raw === "" || raw === "duck") return "duck";
  if (raw === "lbug") return "lbug";
  throw new Error(`Invalid ${ENV_VAR}=${JSON.stringify(raw)}; expected "duck" or "lbug".`);
}

/**
 * Factory that returns the selected `IGraphStore` implementation. The
 * signature is `async` so that a future revision can perform asynchronous
 * bootstrapping (native-binding probing, version-handshake) without a
 * breaking API change. In this AC the factory only constructs — callers
 * still own the `open()` lifecycle call so failures are attributable to
 * the lifecycle boundary rather than the factory.
 */
export async function openStore(opts: OpenStoreOptions): Promise<IGraphStore> {
  const backend = resolveStoreBackend(opts.backend);
  if (backend === "lbug") {
    return new GraphDbStore(opts.path, opts.graphDbOptions);
  }
  return new DuckDbStore(opts.path, opts.duckOptions);
}
