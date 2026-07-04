/**
 * `codehub analyze [path]` — index a repository.
 *
 * Flow:
 *   1. Resolve `repoPath` (default `process.cwd()`).
 *   2. Read the registry. If `!force` and the recorded `lastCommit` matches
 *      the pipeline's fresh commit, emit an "up to date" message and return
 *      without doing work.
 *   3. Otherwise run `runIngestion(repoPath, {...})`, then open a writable
 *      `Store` (composed graph + temporal) via `openStore`, then
 *      `createSchema()`, `bulkLoad()`, and `setMeta()`.
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
import { type CodeRelation, type GraphNode, SCHEMA_VERSION } from "@opencodehub/core-types";
import { embedderModelId } from "@opencodehub/embedder";
import { pipeline } from "@opencodehub/ingestion";
import {
  type BulkLoadProgressEvent,
  openStore,
  resolveGraphPath,
  resolveRepoMetaDir,
  type Store,
  type StoreMeta,
  writeStoreMeta,
} from "@opencodehub/storage";
import { writeAgentContextFiles } from "../agent-context.js";
import { type RepoEntry, readRegistry, upsertRegistry } from "../registry.js";
import { generateSkills } from "../skills-gen.js";
import {
  computeScanFingerprint,
  readScanFingerprint,
  shouldSkipScan,
  writeScanFingerprint,
} from "./scan-fingerprint.js";

export interface AnalyzeOptions {
  readonly force?: boolean;
  /**
   * When true, the embeddings phase embeds every callable/declaration symbol
   * and the result is upserted into the `embeddings` table. Requires
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
   * Emit `.codehub/sbom.cyclonedx.json` and `.codehub/sbom.spdx.json`
   * from Dependency nodes. **Default: on.** Serialization is cheap, purely
   * local, and every CI pipeline that scans artifacts wants one. Pass
   * `false` (CLI: `--no-sbom`) to suppress.
   */
  readonly sbom?: boolean;
  /**
   * Run the coverage overlay phase — detects lcov / cobertura / jacoco /
   * coverage.py reports and populates `coveragePercent` + `coveredLines`
   * on File nodes. **Default: auto.** When `undefined`, `runAnalyze`
   * probes the repo for a report at the well-known paths and enables the
   * phase only when one is found (silent no-op otherwise). Pass `true` to
   * force-enable and surface the "no report found" warning, or `false`
   * (CLI: `--no-coverage`) to suppress entirely.
   */
  readonly coverage?: boolean;
  /**
   * Run Priority-1 security scanners at the end of `analyze` and write
   * `.codehub/scan.sarif` + ingest findings into the graph. **Default:
   * on.** Most scanners are local binaries (semgrep, bandit, ruff,
   * vulture, radon, betterleaks, ty); the network-backed
   * ones (osv-scanner, grype, npm/pip audit) are silently skipped when
   * `--offline` is set. Pass `false` (CLI: `--no-scan`) to suppress — the
   * graph pipeline runs unchanged.
   */
  readonly scan?: boolean;
  /**
   * Opt into the `summarize` phase — walks LSP-confirmed callable symbols
   * and invokes Bedrock to generate structured summaries within the
   * resolved cost cap. **Off by default**: a bare `codehub analyze` is
   * fast, local, deterministic, and never spends on LLM calls. Enable
   * per-invocation with `true` (CLI: `--summaries`) or environment-wide
   * with `CODEHUB_BEDROCK_SUMMARIES=1`. `CODEHUB_BEDROCK_DISABLED=1`
   * force-disables regardless of flag state.
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
  /**
   * Opt-ins that enable build-script-driven indexers. Current surface:
   * `"proleap"` — wakes the JVM COBOL deep-parse bridge
   * (`@opencodehub/cobol-proleap`) provided the JAR has been installed via
   * `codehub setup --cobol-proleap`. Unset → regex hot path only; the JVM
   * is never spawned. The flag is a CSV-style whitelist to leave room for
   * future opt-ins (rust `build.rs`, `gradle`, etc).
   */
  readonly allowBuildScripts?: readonly "proleap"[];
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
  /**
   * Set when the parse phase produced zero code symbols from a non-trivial
   * number of tree-sitter files (likely a globally-broken parser). The CLI maps
   * this to a distinct advisory exit code so CI catches a silent-skeleton run.
   */
  readonly zeroSymbolGuard?: boolean;
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
  // around the prior SQLite index (File nodes + IMPORTS / EXTENDS /
  // IMPLEMENTS edges). `loadPreviousGraph` silently returns undefined if
  // the store does not exist or cannot be opened; incremental-scope then
  // reports mode="full" with reason="no-prior-graph".
  const incrementalFrom = opts.force === true ? undefined : await loadPreviousGraph(repoPath);

  // Resolve the effective `summaries` flag. Summaries are opt-in: a bare
  // `codehub analyze` runs the fast, local, deterministic pipeline
  // (tree-sitter + SCIP + cochanges) and skips the Bedrock summarize phase
  // entirely. Opt in via `--summaries` or `CODEHUB_BEDROCK_SUMMARIES=1`.
  // The `CODEHUB_BEDROCK_DISABLED=1` env kill-switch forces off regardless
  // of the flag; `offline` is enforced later inside the phase itself.
  const summariesEnabled = resolveSummariesEnabled(opts.summaries, process.env);

  // Resolve sbom/coverage/scan defaults. SBOM and scan default ON (cheap,
  // local, and they feed the MCP surface agents actually use). Coverage
  // auto-detects: probe the known report paths and only enable the phase
  // when one exists — so bare `codehub analyze` on a repo with no coverage
  // data stays silent instead of warning about a missing report.
  const sbomEnabled = resolveSbomEnabled(opts.sbom);
  const scanEnabled = resolveScanEnabled(opts.scan);
  const coverageResolved = await resolveCoverageEnabled(opts.coverage, repoPath);

  // Open a read-only store upfront so the `summarize` phase can probe the
  // prior summary rows before work is queued AND so we can inspect the
  // prior run's `storeMeta.stats` to resolve `--max-summaries auto`. We
  // keep the handle open for the duration of `runIngestion` and close it
  // in a finally block. `summaries` must be enabled for the adapter to
  // matter; skip the cost of a read-only open when the flag is off.
  const summaryCacheAdapter = summariesEnabled
    ? await openSummaryCacheAdapter(repoPath)
    : undefined;

  // Mirror the same pattern for the embeddings phase's content-hash skip.
  // Only open when `--embeddings` is on AND `--force` is off — force
  // re-embeds everything, so the adapter would do no useful work. When the
  // prior DB is absent the adapter returns undefined and the phase
  // degrades to "every chunk is new".
  //
  // Migration safety: the content-hash skip keys on TEXT only, so swapping
  // the embedder (e.g. gte-modernbert-base/768-dim → f2llm-v2-80m/320-dim)
  // would otherwise skip every unchanged node and leave stale-dimension
  // vectors mixed with the new ones. Gate the cache on a model-id match —
  // when the prior store's `embedderModelId` differs from the active
  // embedder, the adapter is suppressed (full re-embed; INSERT OR REPLACE
  // overwrites every row at the new dim).
  const activeEmbedderModelId = embedderModelId(
    opts.embeddingsVariant === "int8" ? "int8" : "fp32",
  );
  const embeddingHashAdapter =
    opts.embeddings === true && opts.force !== true
      ? await openEmbeddingHashCacheAdapter(repoPath, activeEmbedderModelId)
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
    sbom: sbomEnabled,
    ...(coverageResolved !== undefined ? { coverage: coverageResolved } : {}),
    summaries: summariesEnabled,
    maxSummariesPerRun: resolvedMaxSummaries,
    ...(opts.summaryModel !== undefined ? { summaryModel: opts.summaryModel } : {}),
    ...(opts.strictDetectors !== undefined ? { strictDetectors: opts.strictDetectors } : {}),
    ...(opts.allowBuildScripts !== undefined ? { allowBuildScripts: opts.allowBuildScripts } : {}),
    ...(summaryCacheAdapter !== undefined
      ? { summaryCacheAdapter: summaryCacheAdapter.adapter }
      : {}),
    ...(embeddingHashAdapter !== undefined
      ? { embeddingHashCacheAdapter: embeddingHashAdapter.adapter }
      : {}),
    ...(incrementalFrom !== undefined ? { incrementalFrom } : {}),
    // Phase progress: one line per phase end. Filtered to the long poles so
    // the operator sees motion without `--verbose`-level chatter — sub-100ms
    // phases stay quiet because they fire too fast to matter for "is this
    // still running?" feedback.
    onProgress: makePhaseProgressReporter(),
  };
  let result: Awaited<ReturnType<typeof pipeline.runIngestion>>;
  try {
    result = await pipeline.runIngestion(repoPath, pipelineOptions);
  } finally {
    await summaryCacheAdapter?.close();
    await embeddingHashAdapter?.close();
  }

  logWarnings(result.warnings, opts.verbose === true);

  // Surface the zero-symbol guard prominently — the detailed message is already
  // in result.warnings, but logWarnings collapses grouped warnings, so emit an
  // explicit run-level banner that can't be missed (and that the exit-code
  // mapping in index.ts keys off via the returned summary flag).
  if (result.zeroSymbolGuardTripped === true) {
    log(
      "codehub analyze: WARNING — extracted 0 code symbols from a non-trivial source tree; " +
        "the parser is likely broken (see the parse warning above). Run 'codehub doctor'.",
    );
  }

  // Persist to the composed graph + temporal store. Post-ADR 0019 both views
  // are one `store.sqlite`; the temporal-tier writes (`bulkLoadCochanges`,
  // `bulkLoadSymbolSummaries`) still route through `store.temporal`.
  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  const dbPath = resolveGraphPath(repoPath);
  const store: Store = await openStore({ path: dbPath });
  try {
    await store.graph.open();
    await store.temporal.open();
    await store.graph.createSchema();
    await store.temporal.createSchema();
    await store.graph.bulkLoad(result.graph, { onProgress: makeBulkLoadReporter("graph") });
    // Persist cochange rows to the dedicated `cochanges` table. `bulkLoad` in
    // replace mode already truncated it, but `bulkLoadCochanges` does its own
    // DELETE inside the same transaction so the call is idempotent even on
    // upsert paths that keep the prior graph. Empty row sets collapse into a
    // cheap DELETE.
    if (result.cochange !== undefined) {
      await store.temporal.bulkLoadCochanges(result.cochange.rows);
    }
    // Persist freshly produced summary rows. The phase returns an empty
    // `rows` array in the common gated-off / dry-run case so this is a
    // cheap no-op. A non-empty payload means the operator explicitly ran
    // with `--summaries --max-summaries > 0` and accepted the Bedrock
    // cost; we persist under the temporal-tier surface.
    if (result.summarize !== undefined && result.summarize.rows.length > 0) {
      await store.temporal.bulkLoadSymbolSummaries(result.summarize.rows);
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
      await store.graph.upsertEmbeddings(result.embeddings.rows);
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
    const storeMeta = buildStoreMeta({
      indexedAt,
      nodeCount: result.graph.nodeCount(),
      edgeCount: result.graph.edgeCount(),
      ...(result.stats.currentCommit !== undefined
        ? { currentCommit: result.stats.currentCommit }
        : {}),
      stats: byKindStats,
      ...(parseCache !== undefined ? { cacheHitRatio: parseCache.ratio } : {}),
      cacheSizeBytes: cacheSize.bytes,
      ...(result.embeddings !== undefined ? { embeddings: result.embeddings } : {}),
    });
    await store.graph.setMeta(storeMeta);
    await writeStoreMeta(repoPath, storeMeta);

    // Persist the scan-state sidecar so the next analyze invocation can feed
    // the incremental-scope phase via loadPreviousGraph(). We write this
    // alongside the store.sqlite file under `<repo>/.codehub` so a clean of the
    // meta dir invalidates both the index and the incremental state together.
    if (result.scan !== undefined) {
      await writeScanState(
        repoPath,
        result.scan.files.map((f) => ({ relPath: f.relPath, contentSha: f.sha256 })),
      );
    }

    // Opt-in skill generation. Walk Community nodes just persisted above and
    // emit one SKILL.md per cluster under `<repo>/.codehub/skills/`. Runs
    // against the still-open SQLite handle so there's no re-open cost, and
    // any per-skill failure (read-only dir, permission denied, disk full)
    // logs-and-continues — analyze never aborts because of a skill write.
    if (opts.skills === true) {
      try {
        const emitted = await generateSkills(store.graph, repoPath, { log });
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

  // Scan phase — run Priority-1 scanners and write .codehub/scan.sarif so
  // `verdict`, `list_findings`, and `list_findings_delta` work on day one.
  // Run AFTER the graph + registry write so a scanner failure cannot
  // regress the index. Network-backed scanners (osv-scanner, grype, npm/
  // pip audit) self-skip under --offline. We do NOT propagate the scan's
  // severity-gated exit code — analyze remains the "build the graph"
  // command; operators who want the gate invoke `codehub verdict` or
  // `codehub scan` directly.
  //
  // Scan-INPUT fingerprint skip: the commit-based fast-path is bypassed
  // whenever the working tree is dirty (e.g. right after `codehub init`
  // re-stamps CLAUDE.md/AGENTS.md), which would re-run the full scanner
  // pass on every invocation and churn finding counts via non-deterministic
  // scanners. To avoid that, we fingerprint the scanned content
  // (`result.scan.files`) + the selected scanner-id set; if it matches the
  // prior `scan-fingerprint.json` sidecar AND `scan.sarif` still exists AND
  // `--force` was not passed, we reuse the prior SARIF and skip `runScan`.
  // Otherwise we run the scan as today and refresh the sidecar. `--force`
  // always re-scans. If the scan-phase output is absent we can't
  // fingerprint, so we fall back to running the scan unconditionally.
  if (scanEnabled) {
    try {
      const scanMod = await import("./scan.js");
      const scanOpts: { repo: string; home?: string } = {
        repo: repoName,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      };
      const runScanAndLog = async (): Promise<void> => {
        const scanSummary = await scanMod.runScan(repoPath, scanOpts);
        log(
          `codehub analyze: scan — ${scanSummary.runs.length} scanner(s), ` +
            `${scanSummary.totalFindings} finding(s), sarif=${scanSummary.outputPath}`,
        );
      };

      if (result.scan === undefined) {
        // No scan-phase output to fingerprint — run unconditionally rather
        // than crash or skip.
        await runScanAndLog();
      } else {
        const scannerIds = await scanMod.selectScannerIds(repoPath, scanOpts);
        const currentFingerprint = computeScanFingerprint(
          result.scan.files.map((f) => ({ relPath: f.relPath, sha256: f.sha256 })),
          scannerIds,
        );
        const prior = await readScanFingerprint(repoPath);
        const sarifPath = join(resolveRepoMetaDir(repoPath), "scan.sarif");
        const sarifExists = await fileExists(sarifPath);
        if (
          shouldSkipScan({
            force: opts.force === true,
            priorFingerprint: prior?.fingerprint,
            currentFingerprint,
            sarifExists,
          })
        ) {
          // The graph bulkLoad above ran in replace mode (ADR 0019), which
          // truncated every node — including the `Finding` nodes and
          // `FOUND_IN` edges from the prior scan. When we skip re-running the
          // scanners we still MUST re-ingest the reused `scan.sarif`, or the
          // freshly-rebuilt graph ends up with zero findings and
          // `list_findings`/`verdict`/`list_findings_delta` silently report a
          // clean scan. `runIngestSarif` is idempotent (fingerprint-stable
          // enrichment + upsert-mode bulkLoad), so re-ingesting the unchanged
          // SARIF restores exactly the findings the wipe removed.
          const { runIngestSarif } = await import("./ingest-sarif.js");
          const ingestOpts: { repo: string; home?: string } = {
            repo: repoName,
            ...(opts.home !== undefined ? { home: opts.home } : {}),
          };
          const ingested = await runIngestSarif(sarifPath, ingestOpts);
          log(
            `codehub analyze: scan — up to date (fingerprint match), ` +
              `re-ingested ${ingested.findingsEmitted} finding(s) from cached SARIF`,
          );
        } else {
          await runScanAndLog();
          // Refresh the sidecar only after a successful scan so a thrown
          // runScan leaves the prior fingerprint intact (next run re-scans).
          await writeScanFingerprint(repoPath, {
            schemaVersion: 1,
            fingerprint: currentFingerprint,
            scannedAt: new Date().toISOString(),
            scannerIds,
          });
        }
      }
    } catch (err) {
      log(`codehub analyze: scan skipped: ${(err as Error).message}`);
    }
  }

  return {
    repoPath,
    repoName,
    nodeCount: entry.nodeCount,
    edgeCount: entry.edgeCount,
    graphHash: result.graphHash,
    durationMs,
    upToDate: false,
    warnings: result.warnings,
    ...(result.zeroSymbolGuardTripped === true ? { zeroSymbolGuard: true } : {}),
  };
}

/**
 * Build the {@link pipeline.PreviousGraph} projection expected by the
 * incremental-scope phase from the prior SQLite index + scan-state sidecar.
 *
 * The projection carries:
 *   - file paths + scan-time content hashes, read from
 *     `.codehub/scan-state.json` (written at the tail of the prior run),
 *   - IMPORTS + EXTENDS + IMPLEMENTS edges recovered from the `relations`
 *     table by stripping each endpoint id back to its enclosing file path,
 *   - the FULL prior node and edge snapshot as {@link GraphNode} /
 *     {@link CodeRelation} arrays (via the store's typed `listNodes` /
 *     `listEdges` finders). Shipping these two arrays is what
 *     flips `resolveIncrementalView`
 *     (`packages/ingestion/src/pipeline/phases/incremental-helper.ts:95-102`)
 *     from `active=false` (passive mode) to `active=true`, so the four
 *     incremental consumer phases can carry forward non-closure work and
 *     reproduce a byte-identical graph hash vs a full re-index.
 *
 * Returns `undefined` when the store is missing, unreadable, or empty —
 * any of which downgrades incremental mode to a clean full reindex in the
 * phase without surfacing an error.
 */
export async function loadPreviousGraph(
  repoPath: string,
): Promise<pipeline.PreviousGraph | undefined> {
  const scanState = await readScanState(repoPath);
  if (scanState === undefined) return undefined;
  const dbPath = resolveGraphPath(repoPath);
  const store = await openStore({ path: dbPath }).catch(() => undefined);
  if (store === undefined) return undefined;
  try {
    await store.graph.open();
  } catch {
    await store.close().catch(() => {});
    return undefined;
  }
  try {
    // Full node + edge dumps via typed finders. For a typical OCH repo
    // this is 10K-50K nodes and 20K-100K edges — fits in memory in one
    // shot. The `listNodes` / `listEdges` finders already return
    // rehydrated `GraphNode` / `CodeRelation` objects.
    const nodes = [...(await store.graph.listNodes())];
    const edges = [...(await store.graph.listEdges())];
    // Derive the legacy file-granular projections from the full edge set so
    // we issue one fewer round-trip to the store. The incremental-scope
    // phase still reads these as the closure-walk seed — the node/edge
    // arrays above are the carry-forward snapshot that flips the four
    // consumer phases into active mode.
    const importEdges: { importer: string; target: string }[] = [];
    const heritageEdges: { childFile: string; parentFile: string }[] = [];
    for (const edge of edges) {
      if (edge.type !== "IMPORTS" && edge.type !== "EXTENDS" && edge.type !== "IMPLEMENTS") {
        continue;
      }
      const fromPath = fileFromNodeId(edge.from as string);
      const toPath = fileFromNodeId(edge.to as string);
      if (fromPath === undefined || toPath === undefined) continue;
      if (edge.type === "IMPORTS") {
        importEdges.push({ importer: fromPath, target: toPath });
      } else {
        heritageEdges.push({ childFile: fromPath, parentFile: toPath });
      }
    }
    return { files: scanState.files, importEdges, heritageEdges, nodes, edges };
  } catch {
    return undefined;
  } finally {
    await store.close();
  }
}

/**
 * Resolve the effective `summaries` flag, honoring the
 * `CODEHUB_BEDROCK_DISABLED=1` env kill-switch.
 *
 * `codehub analyze` is a fast, local, deterministic index by default —
 * tree-sitter + SCIP + cochanges + graph phases only. The Bedrock-backed
 * summarize phase is opt-in via `--summaries` (or `CODEHUB_BEDROCK_SUMMARIES=1`)
 * so a fresh `codehub analyze` never spends on LLM calls, blocks on a
 * network hop, or needs AWS creds.
 *
 * Truth table:
 *   - env kill-switch set (any flag state) → false (kill-switch wins)
 *   - env opt-in set + flag undefined      → true  (env opts in)
 *   - flag true                            → true  (explicit --summaries)
 *   - flag false                           → false (explicit --no-summaries)
 *   - flag undefined + no env              → false (default off — fast path)
 *
 * Exported for unit tests; the production call site reads `process.env`.
 */
export function resolveSummariesEnabled(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  if (env["CODEHUB_BEDROCK_DISABLED"] === "1") return false;
  if (flag === true) return true;
  if (flag === false) return false;
  return env["CODEHUB_BEDROCK_SUMMARIES"] === "1";
}

/**
 * Resolve the effective `sbom` flag. Default ON — serializing Dependency
 * nodes to CycloneDX + SPDX is cheap, local, and every supply-chain audit
 * wants it. Pass `false` to suppress.
 *
 * Exported for unit tests.
 */
export function resolveSbomEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

/**
 * Resolve the effective `scan` flag. Default ON — Priority-1 scanners are
 * mostly local binaries that produce the SARIF `verdict`, `list_findings`,
 * and `list_findings_delta` all read. Pass `false` (CLI: `--no-scan`) to
 * suppress — the scanners that need network (osv-scanner, grype, npm/pip
 * audit) are silently skipped anyway when `--offline` is set, so the
 * on-default stays honest under offline operation.
 *
 * Exported for unit tests.
 */
export function resolveScanEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

/**
 * Minimal slice of the `embeddings` phase output {@link buildStoreMeta}
 * needs to tag the store with the embedder that populated it. Declared
 * locally (rather than importing `EmbedderPhaseOutput`) so the helper stays
 * trivially unit-testable without staging the full phase result.
 */
export interface StoreMetaEmbeddingsInput {
  readonly ranEmbedder: boolean;
  readonly embeddingsModelId: string;
}

/** Fields {@link buildStoreMeta} folds into a {@link StoreMeta}. */
export interface BuildStoreMetaInput {
  readonly indexedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly currentCommit?: string;
  readonly stats: Record<string, number>;
  readonly cacheHitRatio?: number;
  readonly cacheSizeBytes: number;
  readonly embeddings?: StoreMetaEmbeddingsInput;
}

/**
 * Assemble the {@link StoreMeta} persisted by `setMeta` + `writeStoreMeta`.
 *
 * Critically, this stamps `embedderModelId` from the embeddings phase output
 * so the query-path fingerprint guard (`assertEmbedderCompatible` in
 * cli/query + mcp/query) has a persisted value to compare against. We only
 * tag it when the embedder actually ran AND reported a non-empty modelId —
 * a `--no-embeddings` run leaves the field unset so the meta does not claim
 * an embedder produced vectors it never wrote.
 *
 * Exported for unit tests; the production call site is in {@link runAnalyze}.
 */
export function buildStoreMeta(input: BuildStoreMetaInput): StoreMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    indexedAt: input.indexedAt,
    nodeCount: input.nodeCount,
    edgeCount: input.edgeCount,
    ...(input.currentCommit !== undefined ? { lastCommit: input.currentCommit } : {}),
    stats: input.stats,
    ...(input.cacheHitRatio !== undefined ? { cacheHitRatio: input.cacheHitRatio } : {}),
    cacheSizeBytes: input.cacheSizeBytes,
    ...(input.embeddings?.ranEmbedder === true && input.embeddings.embeddingsModelId.length > 0
      ? { embedderModelId: input.embeddings.embeddingsModelId }
      : {}),
  };
}

/**
 * Coverage-report candidate paths, mirrored from
 * `packages/ingestion/src/pipeline/phases/coverage.ts:58-64`. Kept in sync
 * by hand: the analyze wrapper needs to know whether a report exists
 * *before* it sets `options.coverage=true`, because the phase warns when
 * coverage is explicitly enabled but no report is found. When `undefined`
 * is plumbed through instead, the phase is a silent no-op.
 */
const COVERAGE_CANDIDATE_PATHS = [
  "coverage/lcov.info",
  "lcov.info",
  "coverage.xml",
  "build/reports/jacoco/test/jacocoTestReport.xml",
  "coverage.json",
] as const;

/**
 * Probe the repo for a coverage report at one of the known paths. Returns
 * the first match (relative to `repoPath`) or `undefined`. Used by the
 * analyze wrapper to decide whether to enable the coverage phase when no
 * explicit flag is passed.
 *
 * Exported so tests can assert which paths are probed without actually
 * running `runAnalyze`.
 */
export async function detectCoverageReport(repoPath: string): Promise<string | undefined> {
  const { access } = await import("node:fs/promises");
  for (const rel of COVERAGE_CANDIDATE_PATHS) {
    try {
      await access(resolve(repoPath, rel));
      return rel;
    } catch {
      // Intentional: we're probing; missing-file is the whole point.
    }
  }
  return undefined;
}

/**
 * Resolve the effective `coverage` flag, honoring explicit true/false and
 * silently auto-detecting when the flag is `undefined`. This lets a bare
 * `codehub analyze` overlay coverage on File nodes when a report is
 * present and stay silent otherwise (no spurious "no report found"
 * warning on repos that don't have tests).
 *
 * - `flag === true`  → pipeline sees `true` (phase runs, warns if absent).
 * - `flag === false` → pipeline sees `false` (phase no-op).
 * - `flag === undefined` + report found → pipeline sees `true`.
 * - `flag === undefined` + no report → pipeline sees `undefined` (no-op).
 *
 * Exported for unit tests.
 */
export async function resolveCoverageEnabled(
  flag: boolean | undefined,
  repoPath: string,
): Promise<boolean | undefined> {
  if (flag === true) return true;
  if (flag === false) return false;
  const detected = await detectCoverageReport(repoPath);
  return detected !== undefined ? true : undefined;
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
 *   - If a SQLite store is readable at the expected path, count nodes
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
 * prior run. Returns `undefined` when no prior SQLite index exists or
 * the count query fails — callers treat that as "no prior run" and fall
 * back to the first-run heuristic.
 */
async function countPriorCallableSymbols(repoPath: string): Promise<number | undefined> {
  const dbPath = resolveGraphPath(repoPath);
  const store = await openStore({ path: dbPath, readOnly: true }).catch(() => undefined);
  if (store === undefined) return undefined;
  try {
    await store.graph.open();
  } catch {
    await store.close().catch(() => {});
    return undefined;
  }
  try {
    // `countNodesByKind` is the typed equivalent of `SELECT COUNT(*)
    // GROUP BY kind`. We sum the three callable kinds in TS so cli stays
    // off the raw-SQL surface.
    const counts = await store.graph.countNodesByKind(["Function", "Method", "Class"]);
    let n = 0;
    for (const c of counts.values()) n += c;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  } finally {
    await store.close();
  }
}

/**
 * Open a read-only SQLite store scoped to the `symbol_summaries` cache
 * probe. The returned object carries a cache adapter the `summarize`
 * phase uses to short-circuit candidates whose content hash already has
 * a row on disk, plus a `close()` the caller invokes to release the
 * native handle. Returns `undefined` when the store cannot be opened —
 * the phase degrades gracefully to "every candidate is a miss".
 */
async function openSummaryCacheAdapter(
  repoPath: string,
): Promise<{ adapter: pipeline.SummaryCacheAdapter; close: () => Promise<void> } | undefined> {
  const dbPath = resolveGraphPath(repoPath);
  const store = await openStore({ path: dbPath, readOnly: true }).catch(() => undefined);
  if (store === undefined) return undefined;
  try {
    // The summary cache lives on the temporal tier. Open both views so
    // the close() symmetry holds.
    await store.graph.open();
    await store.temporal.open();
  } catch {
    await store.close().catch(() => {});
    return undefined;
  }
  return {
    adapter: {
      lookup: async (nodeId, contentHash, promptVersion) =>
        store.temporal.lookupSymbolSummary(nodeId, contentHash, promptVersion),
    },
    close: async () => {
      await store.close();
    },
  };
}

/**
 * Open a read-only SQLite store scoped to the `embeddings` content-hash
 * probe. The returned adapter's `list()` loads every prior
 * `(granularity, nodeId, chunkIndex) → content_hash` row in a single
 * round-trip so the embeddings phase can skip chunks whose source text is
 * unchanged across runs. Returns `undefined` when the store cannot be
 * opened (e.g. the first analyze on a fresh repo) — the phase then
 * degrades to "every chunk is new", which is correct just slower.
 */
async function openEmbeddingHashCacheAdapter(
  repoPath: string,
  activeModelId: string,
): Promise<
  { adapter: pipeline.EmbeddingHashCacheAdapter; close: () => Promise<void> } | undefined
> {
  const dbPath = resolveGraphPath(repoPath);
  const store = await openStore({ path: dbPath, readOnly: true }).catch(() => undefined);
  if (store === undefined) return undefined;
  try {
    await store.graph.open();
  } catch {
    await store.close().catch(() => {});
    return undefined;
  }
  // Migration guard: if the prior index was built by a different embedder,
  // its content_hashes describe vectors of the wrong model/dimension.
  // Suppress the cache so every node is re-embedded (full overwrite) rather
  // than skipped — preventing a silent mixed-dimension store.
  try {
    const meta = await store.graph.getMeta();
    const priorModelId = meta?.embedderModelId;
    if (priorModelId !== undefined && priorModelId !== activeModelId) {
      log(
        `codehub analyze: embedder changed (${priorModelId} → ${activeModelId}); ` +
          "re-embedding all symbols (content-hash cache suppressed).",
      );
      await store.close().catch(() => {});
      return undefined;
    }
  } catch {
    // Meta unreadable (fresh/legacy store) — fall through; the cache list()
    // below already tolerates an empty/erroring store.
  }
  return {
    adapter: {
      // listEmbeddingHashes is on the graph-tier interface — embeddings
      // travel with the graph view, not the temporal cochange table.
      // Wrapped in try/catch: querying a freshly-created store that has no
      // schema yet (or a read-only handle on a not-yet-initialized file) can
      // throw before the embeddings table exists. Returning an empty map
      // matches the interface contract ("Empty map on a fresh database or
      // any error").
      list: async () => {
        try {
          return await store.graph.listEmbeddingHashes();
        } catch {
          return new Map<string, string>();
        }
      },
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

/**
 * Resolve whether a file exists. Used by the scan-fingerprint skip path to
 * confirm the prior `scan.sarif` is still on disk before reusing it. Any
 * error (missing file, permission) resolves to `false`.
 */
async function fileExists(path: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-line phase-end reporter. Surfaces a `phase=name dur=ms` line for every
 * phase as it completes so the operator can see motion through the ingestion
 * pipeline. We intentionally skip "start" events (would double the line
 * count for no extra information) and silence sub-100ms phases (too fast
 * to matter as a "still running?" signal — they fire as a burst at the end
 * of an analyze and would just be noise).
 *
 * Errors and warnings already flow through `result.warnings` post-run, so
 * this reporter ignores `kind: "warn" | "error"` events.
 */
function makePhaseProgressReporter(): (ev: pipeline.ProgressEvent) => void {
  return (ev) => {
    if (ev.kind !== "end") return;
    const dur = ev.elapsedMs;
    if (dur === undefined || dur < 100) return;
    log(`codehub analyze: phase ${ev.phase} ${formatDuration(dur)}`);
  };
}

/**
 * Bulk-load progress reporter. The graph-db backend's UNWIND-batched
 * insert path emits per-batch events; we collapse the batch chatter into
 * a stage-level summary (start/end of nodes; start/end of edges; one line
 * per relation kind) so the output stays scannable on a long-running
 * analyze. The `tag` distinguishes graph vs temporal-tier bulk-loads in
 * the rare deployment that runs both.
 */
function makeBulkLoadReporter(tag: string): (ev: BulkLoadProgressEvent) => void {
  let lastNodesPct = -1;
  return (ev) => {
    switch (ev.kind) {
      case "truncate-start":
        log(`codehub analyze: ${tag} bulk-load — truncating prior rows`);
        break;
      case "nodes-start":
        log(`codehub analyze: ${tag} bulk-load — inserting ${ev.total ?? "?"} nodes`);
        lastNodesPct = -1;
        break;
      case "nodes-batch": {
        // Throttle: only print when we cross a 25% bucket so a 22k-node
        // run produces ~3 progress lines, not 22.
        const total = ev.total ?? 0;
        const done = ev.done ?? 0;
        if (total === 0) return;
        const pct = Math.floor((done / total) * 4) * 25;
        if (pct === lastNodesPct || pct >= 100) return;
        lastNodesPct = pct;
        log(
          `codehub analyze: ${tag} bulk-load — nodes ${done}/${total} (${pct}%) ` +
            `${formatDuration(ev.elapsedMs ?? 0)}`,
        );
        break;
      }
      case "nodes-end":
        log(
          `codehub analyze: ${tag} bulk-load — ${ev.done ?? "?"} nodes inserted ` +
            `${formatDuration(ev.elapsedMs ?? 0)}`,
        );
        break;
      case "edges-start":
        log(`codehub analyze: ${tag} bulk-load — inserting ${ev.total ?? "?"} edges`);
        break;
      case "edges-batch":
        // One line per relation kind once its bucket finishes — gives the
        // operator a sense of which rel types dominate the wall clock.
        if (ev.relType !== undefined) {
          log(
            `codehub analyze: ${tag} bulk-load — edges ${ev.done ?? "?"}/${ev.total ?? "?"} ` +
              `[${ev.relType}] ${formatDuration(ev.elapsedMs ?? 0)}`,
          );
        }
        break;
      case "edges-end":
        log(
          `codehub analyze: ${tag} bulk-load — ${ev.done ?? "?"} edges inserted ` +
            `${formatDuration(ev.elapsedMs ?? 0)}`,
        );
        break;
      // truncate-end is silent — paired with the start line above.
      default:
        break;
    }
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `(${Math.round(ms)} ms)`;
  return `(${(ms / 1000).toFixed(1)} s)`;
}
