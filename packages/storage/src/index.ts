export { assertReadOnlyCypher, CypherGuardError } from "./cypher-guard.js";
export { DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
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
  BackendKind,
  BulkLoadStats,
  CochangeLookupOptions,
  CochangeRow,
  CochangeStore,
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
  SymbolSummaryStore,
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
  resolveDbPath,
  resolveMetaFilePath,
  resolveRegistryPath,
  resolveRepoMetaDir,
} from "./paths.js";
export { generateSchemaDDL, type SchemaOptions } from "./schema-ddl.js";
export { assertReadOnlySql, SqlGuardError } from "./sql-guard.js";

import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DuckDbStore, type DuckDbStoreOptions } from "./duckdb-adapter.js";
import { GraphDbStore, type GraphDbStoreOptions } from "./graphdb-adapter.js";
import type {
  OpenStoreOptions as ApiOpenStoreOptions,
  BackendKind,
  IGraphStore,
  ITemporalStore,
  OpenStoreResult,
} from "./interface.js";
import { describeArtifacts } from "./paths.js";

/**
 * Combined options accepted by {@link openStore}. Backwards-compatible
 * superset of the spec-level {@link ApiOpenStoreOptions}: keeps the
 * `duckOptions` / `graphDbOptions` adapter-specific bag so existing
 * callers (analyze CLI, ingestion harness) can continue passing through
 * the precise per-backend tuning while AC-A-9 finishes the auto-detect
 * resolver.
 */
export interface OpenStoreOptions extends ApiOpenStoreOptions {
  readonly duckOptions?: DuckDbStoreOptions;
  readonly graphDbOptions?: GraphDbStoreOptions;
}

const ENV_VAR = "CODEHUB_STORE";

/** Backends concretely implemented in-tree today. */
type ResolvedBackend = "duck" | "lbug";

/**
 * Resolve the concrete backend id from the env-only signal. Exported as
 * a sync function so unit tests can assert env-var behaviour without
 * spinning up the dynamic-import probe.
 *
 * Resolution rules (env-only):
 *   - explicit `backend === "duck" | "lbug"` → honored.
 *   - `backend === "auto"` (or `undefined`):
 *       - `CODEHUB_STORE=duck` (or unset / empty) → `"duck"` (legacy default).
 *       - `CODEHUB_STORE=lbug` → `"lbug"`.
 *       - any other value → throw.
 *
 * The async sibling {@link resolveStoreBackendAsync} adds the AC-A-9
 * binding-availability probe: when env is unset, it calls
 * `import("@ladybugdb/core")` and prefers `"lbug"` on success. The sync
 * resolver here intentionally returns `"duck"` for `auto+unset` because
 * the dynamic import cannot complete synchronously; callers that need
 * the auto-probe behaviour route through {@link resolveStoreBackendAsync}.
 */
export function resolveStoreBackend(
  backend: OpenStoreOptions["backend"],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBackend {
  if (backend === "duck" || backend === "lbug") return backend;
  if (backend !== undefined && backend !== "auto") {
    throw new Error(
      `openStore: backend=${JSON.stringify(backend)} is reserved for community ` +
        `adapters and not implemented in-tree. Use "duck" or "lbug".`,
    );
  }
  const raw = env[ENV_VAR];
  if (raw === undefined || raw === "" || raw === "duck") return "duck";
  if (raw === "lbug") return "lbug";
  throw new Error(`Invalid ${ENV_VAR}=${JSON.stringify(raw)}; expected "duck" or "lbug".`);
}

/**
 * Module-scope cache for the `@ladybugdb/core` availability probe.
 * The probe is performed at most once per process. The cache holds the
 * in-flight promise so concurrent callers share the single import.
 */
let _lbugProbeCache: Promise<boolean> | null = null;

/** One-shot stderr-advisory guards. Reset only by re-importing this module. */
let _lbugFallbackWarned = false;
let _dualArtifactWarned = false;

/**
 * Probe `@ladybugdb/core` availability via dynamic `import()`. The probe
 * never throws — failure (binding missing on this platform, version
 * mismatch, etc.) resolves to `false` and the caller falls back to
 * `"duck"`.
 *
 * The first invocation triggers the import and caches the resulting
 * promise; subsequent invocations return the cached promise so the
 * import runs at most once per process. Test-only callers can pass a
 * `probe` override to {@link resolveStoreBackendAsync} to bypass the
 * cache entirely.
 */
function probeLbugBinding(): Promise<boolean> {
  if (_lbugProbeCache === null) {
    _lbugProbeCache = import("@ladybugdb/core").then(
      () => true,
      () => false,
    );
  }
  return _lbugProbeCache;
}

/**
 * Test-only escape hatch: reset the probe cache + advisory guards so
 * unit tests can rerun resolution from a clean slate. Not exported on
 * the public package surface.
 *
 * @internal
 */
export function _resetStoreResolverCache(): void {
  _lbugProbeCache = null;
  _lbugFallbackWarned = false;
  _dualArtifactWarned = false;
}

/**
 * Emit a one-shot stderr advisory when running interactively or when
 * `OCH_VERBOSE=1` is set. CI runs (no TTY, no opt-in) stay quiet so the
 * default-fallback path does not pollute build logs.
 */
function shouldEmitAdvisory(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["OCH_VERBOSE"] === "1") return true;
  return Boolean(process.stderr.isTTY);
}

/**
 * Async backend resolver — the AC-A-9 default-flip entry point. Honors
 * the explicit env var first, then probes `@ladybugdb/core` when the
 * caller asked for `"auto"` and `CODEHUB_STORE` is unset.
 *
 * The probe runs at most once per process via {@link probeLbugBinding};
 * subsequent calls hit the cached result. On binding failure the resolver
 * resolves to `"duck"` and emits a one-shot stderr advisory (gated by
 * TTY / `OCH_VERBOSE=1`) so CI runs stay quiet but interactive devs see
 * why the graph backend did not engage.
 *
 * @param probe - Test-only injectable probe; defaults to the cached
 *                module-scope `import("@ladybugdb/core")`.
 */
export async function resolveStoreBackendAsync(
  backend: OpenStoreOptions["backend"],
  env: NodeJS.ProcessEnv = process.env,
  probe: () => Promise<boolean> = probeLbugBinding,
): Promise<ResolvedBackend> {
  // Explicit backend → honored synchronously, no probe.
  if (backend === "duck" || backend === "lbug") return backend;
  if (backend !== undefined && backend !== "auto") {
    throw new Error(
      `openStore: backend=${JSON.stringify(backend)} is reserved for community ` +
        `adapters and not implemented in-tree. Use "duck" or "lbug".`,
    );
  }
  // Env var wins over the probe — explicit user intent.
  const raw = env[ENV_VAR];
  if (raw === "duck") return "duck";
  if (raw === "lbug") return "lbug";
  if (raw !== undefined && raw !== "") {
    throw new Error(`Invalid ${ENV_VAR}=${JSON.stringify(raw)}; expected "duck" or "lbug".`);
  }
  // auto + unset → probe.
  const lbugAvailable = await probe();
  if (lbugAvailable) return "lbug";
  if (!_lbugFallbackWarned && shouldEmitAdvisory(env)) {
    _lbugFallbackWarned = true;
    process.stderr.write(
      "[opencodehub] @ladybugdb/core binding not available — falling back to DuckDB. " +
        `Set ${ENV_VAR}=duck to silence this advisory.\n`,
    );
  }
  return "duck";
}

/**
 * Dual-artifact detection — when both `graph.duckdb` and `graph.lbug`
 * exist as siblings in the same directory, prefer the newer-mtime one
 * over the resolved backend's choice. This handles the M7 transition
 * where a user re-analyzes with `CODEHUB_STORE=lbug` but the older
 * DuckDB artifact is still on disk: the newer file is the source of
 * truth, regardless of which backend the env var picked.
 *
 * Returns the (possibly overridden) resolved backend. Emits a one-shot
 * stderr advisory when an override fires.
 *
 * Pure stat call — no read of either artifact. The check is skipped
 * for `:memory:` paths (DuckDB's in-memory mode) since there is no
 * filesystem to inspect.
 */
export async function detectDualArtifacts(
  graphFile: string,
  temporalFile: string,
  backend: ResolvedBackend,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedBackend> {
  // In-memory or non-filesystem paths short-circuit.
  if (graphFile === ":memory:" || temporalFile === ":memory:") return backend;
  const dir = dirname(graphFile);
  const duckPath = join(dir, describeArtifacts("duck").graphFile);
  const lbugPath = join(dir, describeArtifacts("lbug").graphFile);
  // Cheap: stat both. If either is missing the dual-artifact case does
  // not apply.
  const [duckStat, lbugStat] = await Promise.all([
    stat(duckPath).catch(() => null),
    stat(lbugPath).catch(() => null),
  ]);
  if (duckStat === null || lbugStat === null) return backend;
  // Both files exist. Pick the newer mtime.
  const winner: ResolvedBackend = duckStat.mtimeMs > lbugStat.mtimeMs ? "duck" : "lbug";
  if (winner !== backend && !_dualArtifactWarned && shouldEmitAdvisory(env)) {
    _dualArtifactWarned = true;
    process.stderr.write(
      `[opencodehub] both ${basename(duckPath)} and ${basename(lbugPath)} found in ${dir}; ` +
        `using ${winner === "duck" ? basename(duckPath) : basename(lbugPath)} ` +
        "(newer mtime). Remove the stale artifact to silence this advisory.\n",
    );
  }
  return winner;
}

/**
 * Compose paired graph + temporal artifact paths. DuckDB-only deployments
 * collapse to a single file (the same path serves both views via one
 * connection). Graph-db pairings (`@ladybugdb/core` backend) split the
 * graph and temporal artifacts into siblings inside the same `.codehub/`
 * directory:
 *
 *   - graph artifact → `<dir>/graph.lbug` (renamed from the input filename
 *     so the on-disk extension matches the engine that owns the file).
 *   - temporal artifact → `<dir>/temporal.duckdb` (sibling DuckDB file).
 *
 * The input `path` is the legacy graph-DB file path (typically
 * `<repo>/.codehub/graph.duckdb`); we keep that contract for callers that
 * cannot yet tell the two backends apart and rewrite the filename when
 * the resolved backend is `lbug`. Filename selection is delegated to
 * {@link describeArtifacts} in `paths.ts` so two-store deployments share
 * a single source of truth.
 */
function composeArtifactPaths(
  backend: ResolvedBackend,
  path: string,
): { graphFile: string; temporalFile: string } {
  if (backend === "duck") {
    return { graphFile: path, temporalFile: path };
  }
  const dir = dirname(path);
  const { graphFile, temporalFile } = describeArtifacts(backend);
  return {
    graphFile: join(dir, graphFile),
    temporalFile: join(dir, temporalFile),
  };
}

/**
 * Factory that returns a composed graph + temporal {@link OpenStoreResult}.
 * Per AC-A-3 (architecture-revised.md §AC-A-3):
 *
 *   - `backend: "duck"` → a single `DuckDbStore` instance is returned as
 *     BOTH the `graph` and `temporal` views over the same connection.
 *     No second file. Closing once is sufficient (`close()` is
 *     idempotent on the underlying adapter).
 *   - `backend: "lbug"` → a `GraphDbStore` instance backs the `graph`
 *     view at `<dir>/graph.lbug`; a separate `DuckDbStore` over the
 *     sibling `<dir>/temporal.duckdb` backs the `temporal` view.
 *     `OpenStoreResult.close()` closes both in deterministic order
 *     (graph first, then temporal).
 *
 * The factory only constructs — callers still own the `open()` lifecycle
 * call so failures are attributable to the lifecycle boundary rather
 * than the factory. Use {@link OpenStoreResult.close} to release both
 * adapters; closing in deterministic order guarantees parity-test
 * lifecycle cleanup symmetry.
 */
export async function openStore(opts: OpenStoreOptions): Promise<OpenStoreResult> {
  // AC-A-9: async resolver — runs the cached `@ladybugdb/core` probe
  // when the caller asked for `"auto"` and `CODEHUB_STORE` is unset.
  // Explicit backend / env var paths skip the probe.
  const initialBackend: ResolvedBackend = await resolveStoreBackendAsync(opts.backend);
  // Compose the canonical artifact paths for the initial backend, then
  // run dual-artifact detection. When both `graph.duckdb` and
  // `graph.lbug` coexist as siblings, the newer-mtime file wins —
  // this handles the M7 transition where a user re-analyzed under one
  // backend but the older artifact from the other backend is still on
  // disk.
  const initialPaths = composeArtifactPaths(initialBackend, opts.path);
  const backend = await detectDualArtifacts(
    initialPaths.graphFile,
    initialPaths.temporalFile,
    initialBackend,
  );
  const { graphFile, temporalFile } =
    backend === initialBackend ? initialPaths : composeArtifactPaths(backend, opts.path);

  const duckOptions: DuckDbStoreOptions = {
    ...(opts.duckOptions ?? {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.embeddingDim !== undefined ? { embeddingDim: opts.embeddingDim } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  if (backend === "duck") {
    // Both graph and temporal views resolve to the same instance over a
    // single DuckDB connection. The class implements both interfaces so
    // structural typing is satisfied without two wrapper objects.
    const store = new DuckDbStore(graphFile, duckOptions);
    return {
      backend: "duck" satisfies BackendKind,
      graph: store satisfies IGraphStore,
      temporal: store satisfies ITemporalStore,
      graphFile,
      temporalFile,
      close: async () => {
        await store.close();
      },
    };
  }

  // backend === "lbug" — graph-db backed graph + DuckDB-backed temporal.
  const graphDbOptions: GraphDbStoreOptions = {
    ...(opts.graphDbOptions ?? {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.embeddingDim !== undefined ? { embeddingDim: opts.embeddingDim } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const graph = new GraphDbStore(graphFile, graphDbOptions);
  const temporal = new DuckDbStore(temporalFile, duckOptions);
  return {
    backend: "lbug" satisfies BackendKind,
    graph: graph satisfies IGraphStore,
    temporal: temporal satisfies ITemporalStore,
    graphFile,
    temporalFile,
    close: async () => {
      // Close graph first, temporal second — symmetric with open ordering
      // would be the inverse, but graph adapters tend to hold native
      // pool handles that benefit from prompt release.
      await graph.close();
      await temporal.close();
    },
  };
}
