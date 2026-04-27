#!/usr/bin/env node
/**
 * Runtime-baseline driver for the E2E smoke harness.
 *
 * Runs pipeline.runIngestion directly on a fixture path with an onProgress
 * hook that captures per-phase timings, then persists to
 * <fixture>/.codehub/graph.duckdb + meta.json the same way `codehub analyze`
 * would. Emits a STATS_JSON: line on stdout for scraping.
 *
 * Wrap with `/usr/bin/time -l` to get peak RSS on macOS.
 *
 * Usage:
 *   node packages/gym/baselines/run-analyze-with-stats.mjs <fixturePath>
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SCHEMA_VERSION } from "../../core-types/dist/index.js";
import { pipeline } from "../../ingestion/dist/index.js";
import {
  DuckDbStore,
  resolveDbPath,
  resolveRepoMetaDir,
  writeStoreMeta,
} from "../../storage/dist/index.js";

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("Usage: run-analyze-with-stats.mjs <fixturePath>");
  process.exit(2);
}

const repoPath = resolve(fixturePath);
const phaseTimings = {};

const startWall = Date.now();
let result;
try {
  result = await pipeline.runIngestion(repoPath, {
    force: true,
    onProgress: (ev) => {
      if (ev.kind === "end") {
        phaseTimings[ev.phase] = ev.elapsedMs ?? 0;
      }
    },
  });
} catch (err) {
  const wallClockMs = Date.now() - startWall;
  const errMsg = err instanceof Error ? err.message : String(err);
  process.stdout.write(
    `STATS_JSON:${JSON.stringify({ error: errMsg, wallClockMs, phaseTimings })}\n`,
  );
  process.exit(1);
}

// Persist DuckDB + meta.json so downstream tools (gym, mcp) see a real graph.
await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
const dbPath = resolveDbPath(repoPath);
const store = new DuckDbStore(dbPath);
try {
  await store.open();
  await store.createSchema();
  await store.bulkLoad(result.graph);
  const indexedAt = new Date().toISOString();
  const byKindStats =
    result.stats.byKind !== undefined ? { ...result.stats.byKind } : {};
  const parseCache = result.stats.parseCache;
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
  };
  await store.setMeta(storeMeta);
  await writeStoreMeta(repoPath, storeMeta);
} finally {
  // keep store open for the confidence-breakdown queries below
}

// Confidence-breakdown queries against the relations table.
let edgeCountTotal = 0;
let scipPhaseEdges = 0;
let heuristicEdges = 0;
let demotedEdges = 0;
try {
  const rows = await store.query(
    "SELECT COUNT(*)::INTEGER AS c FROM relations",
  );
  edgeCountTotal = Number(rows[0]?.c ?? 0);
  const scipRows = await store.query(
    "SELECT COUNT(*)::INTEGER AS c FROM relations WHERE reason LIKE 'scip:%' AND confidence = 1.0",
  );
  scipPhaseEdges = Number(scipRows[0]?.c ?? 0);
  const heurRows = await store.query(
    "SELECT COUNT(*)::INTEGER AS c FROM relations WHERE confidence = 0.5",
  );
  heuristicEdges = Number(heurRows[0]?.c ?? 0);
  const demRows = await store.query(
    "SELECT COUNT(*)::INTEGER AS c FROM relations WHERE confidence = 0.2",
  );
  demotedEdges = Number(demRows[0]?.c ?? 0);
} finally {
  await store.close();
}

const wallClockMs = Date.now() - startWall;
const rssMb = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;

const stats = {
  repoPath,
  nodeCount: result.graph.nodeCount(),
  edgeCount: edgeCountTotal || result.graph.edgeCount(),
  scipPhaseEdges,
  heuristicEdges,
  demotedEdges,
  graphHash: result.graphHash,
  wallClockMs,
  nodeRssMb: rssMb,
  phaseTimings,
  warningCount: result.warnings.length,
};
process.stdout.write(`STATS_JSON:${JSON.stringify(stats)}\n`);
process.exit(0);
