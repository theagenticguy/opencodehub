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

import { spawn } from "node:child_process";
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
import { generateSkills } from "../skills-gen.js";

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
  /**
   * Hierarchical tiers to emit when `embeddings=true` (P03). Defaults to
   * `["symbol"]`. Pass `["symbol", "file", "community"]` for the full
   * hierarchical index — enables `codehub query --zoom` coarse-to-fine.
   */
  readonly embeddingsGranularity?: readonly ("symbol" | "file" | "community")[];
  /**
   * Number of parallel ONNX embedder workers. Defaults to 1 (legacy
   * single-threaded path). Values >= 2 fan inference out across a
   * Piscina pool; each worker holds its own ~300 MB ONNX session, so
   * scale with host memory in mind. Ignored under the HTTP backend.
   */
  readonly embeddingsWorkers?: number;
  /**
   * Chunks per `embedBatch()` call. Defaults to 32. Larger batches
   * amortize tokenizer + tensor-feed overhead but increase peak memory;
   * `1` restores the pre-refactor one-node-per-call pattern.
   */
  readonly embeddingsBatchSize?: number;
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
  /**
   * When true (the post-P04 default), the `summarize` phase walks LSP-
   * confirmed callable symbols and invokes Bedrock to generate structured
   * summaries within the resolved cost cap. Pass `false` (or
   * `CODEHUB_BEDROCK_DISABLED=1`) to force the phase off.
   */
  readonly summaries?: boolean;
  /**
   * Upper bound on Bedrock calls per run. Accepts either a non-negative
   * integer or the literal string `"auto"`. Default `"auto"` resolves to
   * `min(floor(scipConfirmedCallableCount × 0.1), 500)` at run time, using
   * a prior-run heuristic seeded from `store_meta.stats["embeddingsCount"]`
   * when available and falling back to 50 on first run. Any positive
   * integer caps the batch size at that value; `0` runs the phase in
   * dry-run mode.
   */
  readonly maxSummariesPerRun?: number | "auto";
  /**
   * Override the Bedrock model id used by the summarize phase. When
   * undefined, the phase uses `DEFAULT_MODEL_ID` from
   * `@opencodehub/summarizer`.
   */
  readonly summaryModel?: string;
  /**
   * When true, walk Communities with `symbolCount >= 5` after analyze
   * completes and emit one `SKILL.md` per cluster under
   * `<repo>/.codehub/skills/<slug>/`. Off by default — operators opt in.
   */
  readonly skills?: boolean;
  /**
   * When true, detectors that pattern-match on receiver identifiers drop
   * heuristic-only matches entirely — edges only emit when a receiver's
   * module origin was confirmed via the import graph or ts-morph
   * (DET-O-001). Off by default so legacy repos keep emitting.
   */
  readonly strictDetectors?: boolean;
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

  // Resolve the effective `summaries` flag. P04 flipped the default ON, so
  // `undefined` now means "on". The `CODEHUB_BEDROCK_DISABLED=1` env kill-
  // switch forces off regardless of the flag; `offline` is enforced later
  // inside the phase itself (the phase's own invariant).
  const summariesEnabled = resolveSummariesEnabled(opts.summaries, process.env);

  // Open a read-only store upfront so the `summarize` phase can probe the
  // prior summary rows before work is queued AND so we can inspect the
  // prior run's `storeMeta.stats` to resolve `--max-summaries auto`. We
  // keep the handle open for the duration of `runIngestion` and close it
  // in a finally block. `summaries` must be enabled for the adapter to
  // matter; skip the cost of a read-only open when the flag is off.
  const summaryCacheAdapter = summariesEnabled
    ? await openSummaryCacheAdapter(repoPath)
    : undefined;

  // Resolve `--max-summaries auto` against the prior run's callable count,
  // if any. `auto` bounds the cap at 10% of the SCIP-confirmed callable
  // symbols (capped at 500); on a cold first run the prior meta is absent
  // and we fall back to a conservative 50. `0` and positive integers pass
  // through unchanged. Unknown inputs (string without the "auto" literal)
  // are treated as "auto" for forward compatibility.
  const resolvedMaxSummaries = await resolveMaxSummariesCap(
    repoPath,
    opts.maxSummariesPerRun,
    summariesEnabled,
  );

  const pipelineOptions: Parameters<typeof pipeline.runIngestion>[1] = {
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.offline !== undefined ? { offline: opts.offline } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
    ...(opts.embeddings !== undefined ? { embeddings: opts.embeddings } : {}),
    ...(opts.embeddingsVariant !== undefined ? { embeddingsVariant: opts.embeddingsVariant } : {}),
    ...(opts.embeddingsModelDir !== undefined
      ? { embeddingsModelDir: opts.embeddingsModelDir }
      : {}),
    ...(opts.embeddingsGranularity !== undefined
      ? { embeddingsGranularity: opts.embeddingsGranularity }
      : {}),
    ...(opts.embeddingsWorkers !== undefined ? { embeddingsWorkers: opts.embeddingsWorkers } : {}),
    ...(opts.embeddingsBatchSize !== undefined
      ? { embeddingsBatchSize: opts.embeddingsBatchSize }
      : {}),
    ...(opts.sbom !== undefined ? { sbom: opts.sbom } : {}),
    ...(opts.coverage !== undefined ? { coverage: opts.coverage } : {}),
    summaries: summariesEnabled,
    maxSummariesPerRun: resolvedMaxSummaries,
    ...(opts.summaryModel !== undefined ? { summaryModel: opts.summaryModel } : {}),
    ...(opts.strictDetectors !== undefined ? { strictDetectors: opts.strictDetectors } : {}),
    ...(summaryCacheAdapter !== undefined
      ? { summaryCacheAdapter: summaryCacheAdapter.adapter }
      : {}),
    ...(incrementalFrom !== undefined ? { incrementalFrom } : {}),
  };
  let result: Awaited<ReturnType<typeof pipeline.runIngestion>>;
  try {
    result = await pipeline.runIngestion(repoPath, pipelineOptions);
  } finally {
    await summaryCacheAdapter?.close();
  }

  logWarnings(result.warnings, opts.verbose === true);

  // Persist to DuckDB under <repo>/.codehub/graph.duckdb.
  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath);
  try {
    await store.open();
    await store.createSchema();
    await store.bulkLoad(result.graph);
    // Persist cochange rows to the dedicated `cochanges` table. `bulkLoad` in
    // replace mode already truncated it, but `bulkLoadCochanges` does its own
    // DELETE inside the same transaction so the call is idempotent even on
    // upsert paths that keep the prior graph. Empty row sets collapse into a
    // cheap DELETE.
    if (result.cochange !== undefined) {
      await store.bulkLoadCochanges(result.cochange.rows);
    }
    // Persist freshly produced summary rows. The phase returns an empty
    // `rows` array in the common gated-off / dry-run case so this is a
    // cheap no-op. A non-empty payload means the operator explicitly ran
    // with `--summaries --max-summaries > 0` and accepted the Bedrock
    // cost; we persist under the same `.codehub/graph.duckdb`.
    if (result.summarize !== undefined && result.summarize.rows.length > 0) {
      await store.bulkLoadSymbolSummaries(result.summarize.rows);
      log(
        `codehub analyze: persisted ${result.summarize.rows.length} symbol summaries ` +
          `(promptVersion=${result.summarize.promptVersion})`,
      );
    }
    // Surface the summarize-phase counters whenever the flag was enabled —
    // even in dry-run (maxSummaries=0) mode — so operators can inspect how
    // many symbols WOULD have been summarized before unlocking Bedrock.
    if (summariesEnabled && result.summarize !== undefined) {
      const s = result.summarize;
      log(
        `codehub analyze: summarize — considered=${s.considered}, ` +
          `skippedUnconfirmed=${s.skippedUnconfirmed}, cacheHits=${s.cacheHits}, ` +
          `summarized=${s.summarized}, wouldHaveSummarized=${s.wouldHaveSummarized}, ` +
          `failed=${s.failed} [promptVersion=${s.promptVersion}]`,
      );
    }
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
    // Cache-health stats: the parse-cache hit ratio and on-disk size are
    // surfaced to `codehub doctor` and `codehub status` via the meta
    // sidecar. Missing ratio (no parse phase) → omit the field so pre-1.1
    // meta.json snapshots keep round-tripping byte-identically.
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

    // Opt-in skill generation. Walk Community nodes just persisted above and
    // emit one SKILL.md per cluster under `<repo>/.codehub/skills/`. Runs
    // against the still-open DuckDB handle so there's no re-open cost, and
    // any per-skill failure (read-only dir, permission denied, disk full)
    // logs-and-continues — analyze never aborts because of a skill write.
    if (opts.skills === true) {
      try {
        const emitted = await generateSkills(store, repoPath, { log });
        log(`codehub analyze: generated ${emitted} SKILL.md ${emitted === 1 ? "file" : "files"}`);
      } catch (err) {
        log(`codehub analyze: skill generation failed: ${(err as Error).message}`);
      }
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
 * Resolve the effective `summaries` flag, honoring the
 * `CODEHUB_BEDROCK_DISABLED=1` env kill-switch (SUM-S-001) and the P04
 * default-on contract (absent flag → enabled).
 *
 * Truth table (post-P04):
 *   - env var set + flag undefined  → false (kill-switch wins)
 *   - env var set + flag true       → false (kill-switch wins)
 *   - env var set + flag false      → false
 *   - env var unset + flag undefined → true  (default on)
 *   - env var unset + flag true     → true
 *   - env var unset + flag false    → false (explicit --no-summaries)
 *
 * Exported for unit tests; the production call site reads `process.env`.
 */
export function resolveSummariesEnabled(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  if (env["CODEHUB_BEDROCK_DISABLED"] === "1") return false;
  return flag !== false;
}

/**
 * Resolve `--max-summaries auto` / explicit numeric caps into a concrete
 * numeric budget the pipeline can consume.
 *
 * Pre-run heuristic (P04): `auto` bounds the cap at
 * `min(floor(scipConfirmedCallableCount × 0.1), 500)`. We cannot cheaply
 * compute that before the pipeline runs (LSP phases haven't yielded
 * yet), so we use the prior run's stored counts when available:
 *
 *   - If a DuckDB store is readable at the expected path, count nodes
 *     whose kind is Function/Method/Class. That count is the best proxy
 *     for "SCIP-confirmed callables" we can get before the parse phase.
 *   - If no prior store exists (fresh clone, first analyze), fall back
 *     to a conservative first-run cap of 50. The next invocation has
 *     the prior counts and can resolve `auto` accurately.
 *
 * Explicit numeric caps pass through unchanged; negative values clamp to
 * 0 (dry-run). When summaries are disabled we short-circuit to 0 so the
 * phase's cost-cap branch is hit regardless.
 *
 * Exported for unit tests; the production call site passes
 * `countPriorCallableSymbols` for the seed lookup.
 */
export async function resolveMaxSummariesCap(
  repoPath: string,
  raw: number | "auto" | undefined,
  summariesEnabled: boolean,
  seedLookup: (repoPath: string) => Promise<number | undefined> = countPriorCallableSymbols,
): Promise<number> {
  if (!summariesEnabled) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  // Default or explicit "auto" — consult prior graph counts.
  const seed = await seedLookup(repoPath);
  if (seed === undefined) {
    // First run: give Bedrock a bounded foothold so the operator sees
    // the feature light up without the phase sitting idle in dry-run.
    return 50;
  }
  return Math.min(Math.floor(seed * 0.1), 500);
}

/**
 * Count callable symbols (Function / Method / Class) recorded by the
 * prior run. Returns `undefined` when no prior DuckDB index exists or
 * the count query fails — callers treat that as "no prior run" and fall
 * back to the first-run heuristic.
 */
async function countPriorCallableSymbols(repoPath: string): Promise<number | undefined> {
  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath, { readOnly: true });
  try {
    await store.open();
  } catch {
    return undefined;
  }
  try {
    const rows = await store.query(
      "SELECT COUNT(*) AS n FROM nodes WHERE kind IN ('Function','Method','Class')",
    );
    const first = rows[0];
    if (!first) return undefined;
    const n = Number(first["n"] ?? 0);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  } finally {
    await store.close();
  }
}

/**
 * Open a read-only DuckDB store scoped to the `symbol_summaries` cache
 * probe. The returned object carries a cache adapter the `summarize`
 * phase uses to short-circuit candidates whose content hash already has
 * a row on disk, plus a `close()` the caller invokes to release the
 * native handle. Returns `undefined` when the store cannot be opened —
 * the phase degrades gracefully to "every candidate is a miss".
 */
async function openSummaryCacheAdapter(
  repoPath: string,
): Promise<{ adapter: pipeline.SummaryCacheAdapter; close: () => Promise<void> } | undefined> {
  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath, { readOnly: true });
  try {
    await store.open();
  } catch {
    return undefined;
  }
  return {
    adapter: {
      lookup: async (nodeId, contentHash, promptVersion) =>
        store.lookupSymbolSummary(nodeId, contentHash, promptVersion),
    },
    close: async () => {
      await store.close();
    },
  };
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

export async function checkFastPath(
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
  // Uncommitted changes in the working tree mean the recorded `lastCommit`
  // no longer reflects what's on disk — bypass the fast-path so analyze
  // re-runs against the edited files. If git can't answer (non-git dir,
  // git unavailable) `isWorkingTreeDirty` returns false and we fall
  // through to the HEAD-based check below, matching `readGitHead`'s
  // fallback posture.
  const dirty = await isWorkingTreeDirty(repoPath);
  if (dirty) return undefined;
  // Compare against the working tree's current HEAD so a `git pull`
  // invalidates the fast-path. If git isn't available (non-git dir,
  // shallow checkout without HEAD, etc.) fall back to treating the
  // registry record as authoritative — the user can always --force.
  const head = await readGitHead(repoPath);
  if (head !== undefined && head !== hit.lastCommit) return undefined;
  return hit;
}

async function readGitHead(repoPath: string): Promise<string | undefined> {
  return new Promise((resolveP) => {
    let stdout = "";
    let settled = false;
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolveP(undefined);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        const trimmed = stdout.trim();
        resolveP(trimmed.length > 0 ? trimmed : undefined);
      } else {
        resolveP(undefined);
      }
    });
  });
}

/**
 * Probe whether the working tree has uncommitted changes. Returns `true`
 * iff `git status --porcelain` exits 0 with non-empty stdout. Any spawn
 * error, non-zero exit, or git-unavailable case returns `false` so the
 * caller never blocks the fast-path on a git failure — mirroring
 * `readGitHead`'s "cannot determine" fallback.
 *
 * Exported so the CLI test suite can assert the fallback posture directly
 * without spawning a whole `runAnalyze` pipeline.
 */
export async function isWorkingTreeDirty(repoPath: string): Promise<boolean> {
  return new Promise((resolveP) => {
    let stdout = "";
    let settled = false;
    const child = spawn("git", ["status", "--porcelain"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolveP(false);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolveP(stdout.length > 0);
      } else {
        resolveP(false);
      }
    });
  });
}

/**
 * Emit pipeline warnings to stderr. By default, collapse high-cardinality
 * classes (e.g. dead-code ghost-community) into a single summary line so
 * a run doesn't drown the terminal with hundreds of near-identical lines.
 * Pass `verbose=true` to print every warning individually.
 */
function logWarnings(warnings: readonly string[], verbose: boolean): void {
  if (verbose) {
    for (const w of warnings) log(`codehub analyze: ${w}`);
    return;
  }
  // Group by `<phase>:` prefix. We count repeats of the same prefix and
  // print one summary + one sample so operators still see what's going on.
  const groups = new Map<string, { count: number; sample: string }>();
  const others: string[] = [];
  for (const w of warnings) {
    const colon = w.indexOf(":");
    if (colon === -1) {
      others.push(w);
      continue;
    }
    const prefix = w.slice(0, colon);
    const existing = groups.get(prefix);
    if (existing === undefined) {
      groups.set(prefix, { count: 1, sample: w });
    } else {
      existing.count += 1;
    }
  }
  for (const [prefix, { count, sample }] of groups) {
    if (count === 1) {
      log(`codehub analyze: ${sample}`);
    } else {
      log(`codehub analyze: ${prefix}: ${count} warnings (use --verbose to see all)`);
      log(`codehub analyze:   e.g. ${sample}`);
    }
  }
  for (const w of others) log(`codehub analyze: ${w}`);
}

function log(message: string): void {
  // Using console.warn keeps stdout reserved for machine-readable output from
  // subcommands like `sql` and `query --json`.
  console.warn(message);
}
