/**
 * `codehub analyze [path]` — index a repository.
 *
 * Flow:
 *   1. Resolve `repoPath` (default `process.cwd()`).
 *   2. Read the registry. If `!force` and the recorded `lastCommit` matches
 *      the pipeline's fresh commit, emit an "up to date" message and return
 *      without doing work.
 *   3. Otherwise run `runIngestion(repoPath, {...})`, then open a writable
 *      DuckDbStore at `<repo>/.codehub/graph.duckdb`, `createSchema()`,
 *      `bulkLoad()`, and `setMeta()`.
 *   4. Update the registry and, unless suppressed, stamp AGENTS.md + CLAUDE.md.
 *   5. Print a one-line summary.
 *
 * The `--offline` flag is a hard promise: the ingestion pipeline never opens
 * a network socket, and embeddings are a no-op for MVP. We log the promise so
 * reviewers can audit call sites.
 */

import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SCHEMA_VERSION } from "@opencodehub/core-types";
import { pipeline } from "@opencodehub/ingestion";
import {
  DuckDbStore,
  resolveDbPath,
  resolveRepoMetaDir,
  writeStoreMeta,
} from "@opencodehub/storage";
import { writeAgentContextFiles } from "../agent-context.js";
import { type RepoEntry, readRegistry, upsertRegistry } from "../registry.js";

export interface AnalyzeOptions {
  readonly force?: boolean;
  /**
   * When true, the embeddings phase embeds every callable/declaration symbol
   * and the result is upserted into the DuckDB `embeddings` table. Requires
   * `codehub setup --embeddings` to have installed weights; if weights are
   * missing the phase logs a warning and skips — analyze never aborts.
   */
  readonly embeddings?: boolean;
  /** Which embedder variant to use. Defaults to `fp32` when embeddings=true. */
  readonly embeddingsVariant?: "fp32" | "int8";
  /** Override the embedder model directory (mostly useful for tests). */
  readonly embeddingsModelDir?: string;
  readonly offline?: boolean;
  readonly verbose?: boolean;
  readonly skipAgentsMd?: boolean;
  /**
   * When true, emit `.codehub/sbom.cyclonedx.json` and
   * `.codehub/sbom.spdx.json` from Dependency nodes. Off by default so
   * `codehub analyze` stays quiet for repos where supply-chain docs are
   * out of scope.
   */
  readonly sbom?: boolean;
  /**
   * When true, run the coverage overlay phase which detects lcov /
   * cobertura / jacoco / coverage.py reports and populates
   * `coveragePercent` + `coveredLines` on File nodes. Off by default.
   */
  readonly coverage?: boolean;
  /** Test hook: override the home dir used for the registry. */
  readonly home?: string;
}

export interface AnalyzeSummary {
  readonly repoPath: string;
  readonly repoName: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly graphHash: string;
  readonly durationMs: number;
  readonly upToDate: boolean;
  readonly warnings: readonly string[];
}

export async function runAnalyze(path: string, opts: AnalyzeOptions = {}): Promise<AnalyzeSummary> {
  const started = Date.now();
  const repoPath = resolve(path);
  const repoName = basename(repoPath);

  if (opts.offline) {
    log("codehub analyze: offline mode (no network calls will be made)");
  }
  if (opts.embeddings) {
    log(
      "codehub analyze: --embeddings enabled " +
        "(requires `codehub setup --embeddings` to have installed weights)",
    );
  }

  // Fast path: if the registry knows about this repo and the commit hasn't
  // moved, short-circuit without re-ingesting.
  if (!opts.force) {
    const fastPath = await checkFastPath(repoName, repoPath, opts);
    if (fastPath !== undefined) {
      log(
        `codehub analyze: ${repoName} already up to date at ${fastPath.lastCommit ?? "unknown"} ` +
          `(${fastPath.nodeCount} nodes, ${fastPath.edgeCount} edges)`,
      );
      return {
        repoPath,
        repoName,
        nodeCount: fastPath.nodeCount,
        edgeCount: fastPath.edgeCount,
        graphHash: "",
        durationMs: Date.now() - started,
        upToDate: true,
        warnings: [],
      };
    }
  }

  // Load a prior graph projection for the incremental-scope phase when the
  // CLI was not invoked with --force. The projection is a thin wrapper
  // around the prior DuckDB index (File nodes + IMPORTS / EXTENDS /
  // IMPLEMENTS edges). `loadPreviousGraph` silently returns undefined if
  // the store does not exist or cannot be opened; incremental-scope then
  // reports mode="full" with reason="no-prior-graph".
  const incrementalFrom = opts.force === true ? undefined : await loadPreviousGraph(repoPath);

  const pipelineOptions: Parameters<typeof pipeline.runIngestion>[1] = {
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.offline !== undefined ? { offline: opts.offline } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
    ...(opts.embeddings !== undefined ? { embeddings: opts.embeddings } : {}),
    ...(opts.embeddingsVariant !== undefined ? { embeddingsVariant: opts.embeddingsVariant } : {}),
    ...(opts.embeddingsModelDir !== undefined
      ? { embeddingsModelDir: opts.embeddingsModelDir }
      : {}),
    ...(opts.sbom !== undefined ? { sbom: opts.sbom } : {}),
    ...(opts.coverage !== undefined ? { coverage: opts.coverage } : {}),
    ...(incrementalFrom !== undefined ? { incrementalFrom } : {}),
  };
  const result = await pipeline.runIngestion(repoPath, pipelineOptions);

  for (const warning of result.warnings) {
    log(`codehub analyze: ${warning}`);
  }

  // Persist to DuckDB under <repo>/.codehub/graph.duckdb.
  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath);
  try {
    await store.open();
    await store.createSchema();
    await store.bulkLoad(result.graph);
    // Persist embeddings emitted by the `embeddings` phase (if any). The
    // phase returns an empty `rows` array when `opts.embeddings` is false
    // or when weights are missing, so this call is a cheap no-op in the
    // common case. We upsert AFTER bulkLoad so the replace-mode wipe
    // doesn't drop freshly-written embeddings.
    if (result.embeddings !== undefined && result.embeddings.rows.length > 0) {
      await store.upsertEmbeddings(result.embeddings.rows);
      log(
        `codehub analyze: upserted ${result.embeddings.rows.length} embeddings ` +
          `(${result.embeddings.embeddingsModelId})`,
      );
    }
    const indexedAt = new Date().toISOString();
    // Numeric provenance stats, if any. embeddingsHash is a string and is
    // persisted to the sidecar file instead of StoreMeta.stats (which is
    // Record<string, number>).
    const byKindStats: Record<string, number> =
      result.stats.byKind !== undefined ? { ...result.stats.byKind } : {};
    if (result.embeddings?.ranEmbedder) {
      byKindStats["embeddingsCount"] = result.embeddings.embeddingsInserted;
    }
    // Cache-health stats (W2-E.4): the parse-cache hit ratio and on-disk
    // size are surfaced to `codehub doctor` and `codehub status` via the
    // meta sidecar. Missing ratio (no parse phase) → omit the field so
    // pre-1.1 meta.json snapshots keep round-tripping byte-identically.
    const parseCache = result.stats.parseCache;
    const cacheDir = join(repoPath, ".codehub", "parse-cache");
    const cacheSize = await pipeline.computeCacheSize(cacheDir);
    const storeMeta = {
      schemaVersion: SCHEMA_VERSION,
      indexedAt,
      nodeCount: result.graph.nodeCount(),
      edgeCount: result.graph.edgeCount(),
      ...(result.stats.currentCommit !== undefined
        ? { lastCommit: result.stats.currentCommit }
        : {}),
      stats: byKindStats,
      ...(parseCache !== undefined ? { cacheHitRatio: parseCache.ratio } : {}),
      cacheSizeBytes: cacheSize.bytes,
    };
    await store.setMeta(storeMeta);
    await writeStoreMeta(repoPath, storeMeta);

    // Persist the scan-state sidecar so the next analyze invocation can feed
    // the incremental-scope phase via loadPreviousGraph(). We write this
    // alongside the DuckDB file under `<repo>/.codehub` so a clean of the
    // meta dir invalidates both the index and the incremental state together.
    if (result.scan !== undefined) {
      await writeScanState(
        repoPath,
        result.scan.files.map((f) => ({ relPath: f.relPath, contentSha: f.sha256 })),
      );
    }
  } finally {
    await store.close();
  }

  const entry: RepoEntry = {
    name: repoName,
    path: repoPath,
    indexedAt: new Date().toISOString(),
    nodeCount: result.graph.nodeCount(),
    edgeCount: result.graph.edgeCount(),
    ...(result.stats.currentCommit !== undefined ? { lastCommit: result.stats.currentCommit } : {}),
  };
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  await upsertRegistry(entry, registryOpts);

  if (!opts.skipAgentsMd) {
    try {
      await writeAgentContextFiles(repoPath);
    } catch (err) {
      log(`codehub analyze: failed to write AGENTS.md stanza: ${(err as Error).message}`);
    }
  }

  const durationMs = Date.now() - started;
  // Surface incremental-scope + cache-hit stats on a single operational line
  // so operators spot regressions without digging into meta.json.
  const incrementalLine =
    result.incrementalScope !== undefined
      ? ` [scope=${result.incrementalScope.mode}${
          result.incrementalScope.fullReindexBecause !== undefined
            ? `:${result.incrementalScope.fullReindexBecause}`
            : ""
        }, closure=${result.incrementalScope.closureFiles.length}/${result.incrementalScope.totalFiles}]`
      : "";
  const cacheLine =
    result.stats.parseCache !== undefined
      ? ` [cache=${(result.stats.parseCache.ratio * 100).toFixed(0)}% (${result.stats.parseCache.hits}/${result.stats.parseCache.hits + result.stats.parseCache.misses})]`
      : "";
  log(
    `codehub analyze: ${repoName} — ${entry.nodeCount} nodes, ${entry.edgeCount} edges, ` +
      `graph ${result.graphHash.slice(0, 8)}, ${durationMs} ms${incrementalLine}${cacheLine}`,
  );

  return {
    repoPath,
    repoName,
    nodeCount: entry.nodeCount,
    edgeCount: entry.edgeCount,
    graphHash: result.graphHash,
    durationMs,
    upToDate: false,
    warnings: result.warnings,
  };
}

/**
 * Build the {@link pipeline.PreviousGraph} projection expected by the
 * incremental-scope phase from the prior DuckDB index + scan-state sidecar.
 *
 * The projection carries:
 *   - file paths + scan-time content hashes, read from
 *     `.codehub/scan-state.json` (written at the tail of the prior run),
 *   - IMPORTS + EXTENDS + IMPLEMENTS edges recovered from the `relations`
 *     table by stripping each endpoint id back to its enclosing file path.
 *
 * Returns `undefined` when the store is missing, unreadable, or empty —
 * any of which downgrades incremental mode to a clean full reindex in the
 * phase without surfacing an error.
 */
async function loadPreviousGraph(repoPath: string): Promise<pipeline.PreviousGraph | undefined> {
  const scanState = await readScanState(repoPath);
  if (scanState === undefined) return undefined;
  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath);
  try {
    await store.open();
  } catch {
    return undefined;
  }
  try {
    interface EdgeRow {
      readonly from_id: string;
      readonly to_id: string;
      readonly type: string;
    }
    const edgeRows = (await store.query(
      "SELECT from_id, to_id, type FROM relations WHERE type IN ('IMPORTS', 'EXTENDS', 'IMPLEMENTS')",
    )) as unknown as readonly EdgeRow[];
    const importEdges: { importer: string; target: string }[] = [];
    const heritageEdges: { childFile: string; parentFile: string }[] = [];
    for (const edge of edgeRows) {
      const fromPath = fileFromNodeId(edge.from_id);
      const toPath = fileFromNodeId(edge.to_id);
      if (fromPath === undefined || toPath === undefined) continue;
      if (edge.type === "IMPORTS") {
        importEdges.push({ importer: fromPath, target: toPath });
      } else if (edge.type === "EXTENDS" || edge.type === "IMPLEMENTS") {
        heritageEdges.push({ childFile: fromPath, parentFile: toPath });
      }
    }
    return { files: scanState.files, importEdges, heritageEdges };
  } catch {
    return undefined;
  } finally {
    await store.close();
  }
}

/**
 * Extract the repo-relative file path from a `NodeId`. All node kinds embed
 * the file path as the second colon-delimited segment (`<Kind>:<path>:<q>`).
 */
function fileFromNodeId(id: string): string | undefined {
  const first = id.indexOf(":");
  if (first === -1) return undefined;
  const rest = id.slice(first + 1);
  const second = rest.indexOf(":");
  if (second === -1) return rest;
  return rest.slice(0, second);
}

/** Per-file record persisted to `.codehub/scan-state.json`. */
interface ScanStateFile {
  readonly relPath: string;
  readonly contentSha: string;
}
interface ScanStateFile_V1 {
  readonly schemaVersion: 1;
  readonly files: readonly ScanStateFile[];
}

async function readScanState(repoPath: string): Promise<ScanStateFile_V1 | undefined> {
  const stateFile = join(resolveRepoMetaDir(repoPath), "scan-state.json");
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((parsed as { files?: unknown }).files)
    ) {
      return undefined;
    }
    return parsed as ScanStateFile_V1;
  } catch {
    return undefined;
  }
}

async function writeScanState(repoPath: string, files: readonly ScanStateFile[]): Promise<void> {
  const target = join(resolveRepoMetaDir(repoPath), "scan-state.json");
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  // Sort by relPath for deterministic output — mirrors scan phase invariant.
  const sortedFiles = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const payload: ScanStateFile_V1 = { schemaVersion: 1, files: sortedFiles };
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
}

async function checkFastPath(
  repoName: string,
  repoPath: string,
  opts: AnalyzeOptions,
): Promise<RepoEntry | undefined> {
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const registry = await readRegistry(registryOpts);
  const hit = registry[repoName];
  if (!hit) return undefined;
  if (resolve(hit.path) !== repoPath) return undefined;
  // Without a recorded commit we cannot know whether the index is fresh.
  if (hit.lastCommit === undefined) return undefined;
  // The registry record alone is enough for MVP staleness. A more rigorous
  // check (compare to current HEAD) is the job of `codehub status`.
  return hit;
}

function log(message: string): void {
  // Using console.warn keeps stdout reserved for machine-readable output from
  // subcommands like `sql` and `query --json`.
  console.warn(message);
}
