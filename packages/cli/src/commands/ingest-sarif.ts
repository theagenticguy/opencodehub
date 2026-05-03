/**
 * `codehub ingest-sarif <sarif-file>` — import a SARIF v2.1.0 log into
 * the code graph as `Finding` nodes + `FOUND_IN` edges.
 *
 * Flow:
 *   1. Read + parse + validate the SARIF file via `@opencodehub/sarif`.
 *   2. Resolve the target repo (either `--repo <name>` or CWD).
 *   3. Open the DuckDB store and pull a per-file, line-sorted symbol
 *      index over the SARIF's referenced URIs (used to resolve Finding
 *      → Symbol edges).
 *   4. For every Result across every Run, build a Finding node keyed by
 *      `Finding:<scannerId>:<ruleId>:<uri>:<startLine>`. Emit FOUND_IN
 *      edges to the target File node (matched by `artifactLocation.uri`
 *      against `file_path`) plus a second FOUND_IN edge to the tightest
 *      enclosing symbol at `(uri, startLine)` when the graph contains
 *      one. A scanner-provided `opencodehub.symbolId` hint wins over the
 *      enclosing lookup when set.
 *   5. UPSERT into DuckDB via `store.bulkLoad({ mode: "upsert" })`.
 *
 * The command is idempotent — re-running with the same SARIF produces
 * the same nodes and edges. Results without a parsable location (no
 * physicalLocation.artifactLocation.uri) are skipped with a warning.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type FindingNode,
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
  type NodeKind,
} from "@opencodehub/core-types";
import {
  applyBaselineState,
  enrichWithFingerprints,
  type SarifLog,
  SarifLogSchema,
  type SarifResult,
  type SarifRun,
} from "@opencodehub/sarif";
import { DuckDbStore, resolveDbPath, resolveRepoMetaDir } from "@opencodehub/storage";
import { readRegistry } from "../registry.js";
import {
  ENCLOSING_SYMBOL_KINDS,
  findEnclosingSymbolId,
  indexNodesByFile,
  type NodeRow,
  type NodesByFile,
} from "./find-enclosing-symbol.js";

export interface IngestSarifOptions {
  /** `--repo <name>`: look up a registered repo instead of using CWD. */
  readonly repo?: string;
  /** Test hook: override the registry home. */
  readonly home?: string;
}

export interface IngestSarifSummary {
  readonly sarifFile: string;
  readonly repoPath: string;
  readonly findingsEmitted: number;
  readonly edgesEmitted: number;
  readonly resultsSkipped: number;
  readonly warnings: readonly string[];
}

export async function runIngestSarif(
  sarifFile: string,
  opts: IngestSarifOptions = {},
): Promise<IngestSarifSummary> {
  const sarifPath = resolve(sarifFile);
  const raw = await readFile(sarifPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const validation = SarifLogSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      `codehub ingest-sarif: ${sarifPath} is not a valid SARIF 2.1.0 log: ${validation.error.message}`,
    );
  }
  let log = validation.data;

  const repoPath = await resolveRepoPath(opts);

  // Stamp `opencodehub/v1` + `primaryLocationLineHash` partial fingerprints
  // onto every result. The call is idempotent: an already-enriched input
  // produces the same fingerprints, so re-ingesting a SARIF file leaves the
  // column stable.
  log = enrichWithFingerprints(log);

  // Optional baseline overlay. When `<repo>/.codehub/baseline.sarif` exists
  // we tag every result with SARIF 2.1.0 `baselineState` so the
  // `baseline_state` column is populated; missing baseline leaves it NULL
  // (consumers treat NULL as "new" by convention).
  const baselineLog = await loadRepoBaseline(repoPath);
  if (baselineLog !== undefined) {
    log = applyBaselineState(log, baselineLog);
  }

  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath);
  let graph: KnowledgeGraph;
  let summary: BuildSummary;
  try {
    await store.open();
    await store.createSchema();
    // Pull the per-file symbol index out of the store once so every
    // SARIF result can resolve its enclosing symbol without a round
    // trip. Restricts to URIs that actually appear in the SARIF log
    // and to the code-kind allow set shared with `buildFindingsGraph`.
    const nodesByFile = await loadNodesByFileForSarif(store, log.runs);
    ({ graph, summary } = buildFindingsGraph(log.runs, nodesByFile));
    await store.bulkLoad(graph, { mode: "upsert" });
  } finally {
    await store.close();
  }

  const out: IngestSarifSummary = {
    sarifFile: sarifPath,
    repoPath,
    findingsEmitted: summary.findingsEmitted,
    edgesEmitted: summary.edgesEmitted,
    resultsSkipped: summary.resultsSkipped,
    warnings: summary.warnings,
  };
  for (const w of summary.warnings) {
    console.warn(`codehub ingest-sarif: ${w}`);
  }
  console.warn(
    `codehub ingest-sarif: ${out.findingsEmitted} findings, ${out.edgesEmitted} edges from ${sarifPath} → ${repoPath}`,
  );
  return out;
}

interface BuildSummary {
  readonly findingsEmitted: number;
  readonly edgesEmitted: number;
  readonly resultsSkipped: number;
  readonly warnings: readonly string[];
}

/**
 * Pure builder over SARIF runs. Exposed for unit tests so we can exercise
 * the node/edge emission logic without touching DuckDB.
 *
 * `nodesByFile` is the per-file, line-sorted symbol index (produced by
 * {@link indexNodesByFile}) used to resolve each SARIF result back to the
 * tightest-enclosing code symbol when the scanner did not populate
 * `result.properties["opencodehub.symbolId"]` itself. Callers that only
 * want the File-level edge (e.g. unit tests) can omit it — an empty map
 * means every symbol lookup misses and only the File edge is emitted.
 */
export function buildFindingsGraph(
  runs: readonly SarifRun[],
  nodesByFile: NodesByFile = new Map(),
): {
  graph: KnowledgeGraph;
  summary: BuildSummary;
} {
  const graph = new KnowledgeGraph();
  const warnings: string[] = [];
  let findingsEmitted = 0;
  let edgesEmitted = 0;
  let resultsSkipped = 0;

  for (const run of runs) {
    const scannerId = run.tool.driver.name;
    const results = run.results ?? [];
    for (const result of results) {
      const finding = buildFindingNode(scannerId, result);
      if (!finding) {
        resultsSkipped += 1;
        continue;
      }
      graph.addNode(finding.node);
      findingsEmitted += 1;

      // FOUND_IN edge Finding → File (matched by URI). We always emit
      // this edge — if the target File node does not exist in the graph
      // (ingest-sarif runs independently of analyze), the relation is
      // still recorded; downstream queries can left-join.
      const fileId = makeNodeId("File", finding.uri, finding.uri);
      graph.addEdge({
        from: finding.node.id,
        to: fileId,
        type: "FOUND_IN",
        confidence: 1,
        reason: finding.reason,
      });
      edgesEmitted += 1;

      // Resolve the Finding → Symbol edge. Priority order:
      //   1. `opencodehub.symbolId` in the result properties bag — the
      //      explicit scanner-provided hint wins (e.g. semgrep rules that
      //      resolve to a specific function already).
      //   2. Tightest-enclosing symbol at (uri, startLine) from the graph
      //      index. This is the common path for third-party SARIF tools
      //      that emit raw file+line locations.
      // If neither resolves we keep the File-only edge.
      const hintedSymbolId = extractSymbolId(result);
      const symbolId =
        hintedSymbolId !== undefined
          ? (hintedSymbolId as NodeId)
          : findEnclosingSymbolId(nodesByFile, finding.uri, finding.node.startLine ?? 1);
      if (symbolId !== undefined) {
        graph.addEdge({
          from: finding.node.id,
          to: symbolId,
          type: "FOUND_IN",
          confidence: 1,
          reason: finding.reason,
          step: 1,
        });
        edgesEmitted += 1;
      }
    }
  }

  return {
    graph,
    summary: { findingsEmitted, edgesEmitted, resultsSkipped, warnings },
  };
}

interface BuildFindingOutput {
  readonly node: FindingNode;
  readonly uri: string;
  readonly reason: string;
}

/**
 * Convert a single SARIF Result into a FindingNode. Returns `undefined`
 * when the result is missing a location we can key on — we need
 * (ruleId, uri, startLine) to produce a stable id.
 */
function buildFindingNode(scannerId: string, result: SarifResult): BuildFindingOutput | undefined {
  const ruleId = result.ruleId;
  if (typeof ruleId !== "string" || ruleId.length === 0) return undefined;
  const loc = result.locations?.[0]?.physicalLocation;
  const uri = loc?.artifactLocation?.uri;
  if (typeof uri !== "string" || uri.length === 0) return undefined;
  const region = loc?.region;
  const startLine = region?.startLine ?? 1;
  const endLine = region?.endLine;

  // Severity: map SARIF level → Finding.severity. Default "note" when
  // the scanner omits `level` (GHAS treats missing level as "warning",
  // but we stay conservative).
  const severity = mapSeverity(result.level);
  const message = result.message?.text ?? "";

  const id = makeNodeId("Finding", uri, `${scannerId}:${ruleId}:${startLine}`);

  const propertiesBag: Record<string, unknown> = {};
  if (result.properties) {
    for (const [k, v] of Object.entries(result.properties)) {
      propertiesBag[k] = v;
    }
  }

  const suppressedJson = extractSuppressedJson(result);
  const partialFingerprint = extractOpenCodeHubFingerprint(result);
  const baselineState = extractBaselineState(result);
  const node: FindingNode = {
    id,
    kind: "Finding",
    name: `${scannerId}:${ruleId}`,
    filePath: uri,
    ruleId,
    severity,
    scannerId,
    message,
    propertiesBag,
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    ...(suppressedJson !== undefined ? { suppressedJson } : {}),
    ...(partialFingerprint !== undefined ? { partialFingerprint } : {}),
    ...(baselineState !== undefined ? { baselineState } : {}),
  };

  const reason =
    endLine !== undefined ? `startLine=${startLine};endLine=${endLine}` : `startLine=${startLine}`;

  return { node, uri, reason };
}

function mapSeverity(level: SarifResult["level"]): FindingNode["severity"] {
  switch (level) {
    case "error":
    case "warning":
    case "note":
    case "none":
      return level;
    default:
      return "note";
  }
}

/**
 * Persist SARIF `suppressions[]` into the FindingNode's `suppressedJson`
 * column. We keep every entry (external + inSource) so
 * downstream consumers can distinguish waiver provenance; missing or
 * empty arrays resolve to undefined so the column stays null and verdict
 * treats the finding as un-suppressed.
 */
function extractSuppressedJson(result: SarifResult): string | undefined {
  const arr = (result as SarifResult & { suppressions?: readonly unknown[] }).suppressions;
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const entries: Array<{ kind: string; justification: string; expiresAt?: string }> = [];
  for (const entry of arr) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const kind = record["kind"];
    const justification = record["justification"];
    if (typeof kind !== "string" || typeof justification !== "string") continue;
    const expiresAt = record["expiresAt"];
    const out: { kind: string; justification: string; expiresAt?: string } = {
      kind,
      justification,
    };
    if (typeof expiresAt === "string" && expiresAt.length > 0) out.expiresAt = expiresAt;
    entries.push(out);
  }
  return entries.length > 0 ? JSON.stringify(entries) : undefined;
}

function extractSymbolId(result: SarifResult): string | undefined {
  const props = result.properties;
  if (!props || typeof props !== "object") return undefined;
  const record = props as Record<string, unknown>;
  // Primary key scanners put inside their result properties bag.
  const v = record["opencodehub.symbolId"];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/**
 * Pull the `opencodehub/v1` entry out of `result.partialFingerprints` and
 * persist it on the FindingNode. Enrichment runs before ingest so this
 * lookup always succeeds for well-formed inputs — if it doesn't, the
 * column stays NULL (e.g. SARIF files that predate enrichment).
 */
function extractOpenCodeHubFingerprint(result: SarifResult): string | undefined {
  const pf = result.partialFingerprints;
  if (pf === null || pf === undefined || typeof pf !== "object") return undefined;
  const v = (pf as Record<string, unknown>)["opencodehub/v1"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Read `result.baselineState` as a typed literal. `applyBaselineState`
 * only writes `"new" | "unchanged" | "updated"` (baseline-only findings
 * stay outside the current log); `"absent"` can arrive via third-party
 * tooling so we accept it for completeness.
 */
function extractBaselineState(result: SarifResult): FindingNode["baselineState"] | undefined {
  const v = (result as SarifResult & { baselineState?: unknown }).baselineState;
  if (v === "new" || v === "unchanged" || v === "updated" || v === "absent") {
    return v;
  }
  return undefined;
}

/**
 * Load `<repo>/.codehub/baseline.sarif` if present. Missing file resolves
 * to undefined; malformed file raises so the caller can surface the
 * validation error instead of silently dropping baselineState.
 */
async function loadRepoBaseline(repoPath: string): Promise<SarifLog | undefined> {
  const candidate = resolve(`${resolveRepoMetaDir(repoPath)}/baseline.sarif`);
  let raw: string;
  try {
    raw = await readFile(candidate, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  const result = SarifLogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `codehub ingest-sarif: baseline at ${candidate} is not a valid SARIF 2.1.0 log: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Collect every distinct `artifactLocation.uri` across every Result in
 * every Run. Results without a parsable URI (or with an empty one) are
 * silently skipped — downstream emission logic already discards them.
 */
function collectSarifUris(runs: readonly SarifRun[]): readonly string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const result of run.results ?? []) {
      const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
      if (typeof uri === "string" && uri.length > 0) seen.add(uri);
    }
  }
  return [...seen];
}

/**
 * Query the graph store for every code-kind node whose `file_path`
 * matches a URI that appears in the SARIF log, then build the per-file,
 * line-sorted symbol index used by {@link findEnclosingSymbolId}.
 *
 * Scoping by the SARIF URIs keeps the query bounded even on large
 * repos: a SARIF log typically references a few hundred files, not the
 * whole codebase. Empty URI list short-circuits to an empty index — the
 * caller will emit only File-level edges, which matches the v0 behavior
 * before symbol-level linkage existed.
 */
async function loadNodesByFileForSarif(
  store: DuckDbStore,
  runs: readonly SarifRun[],
): Promise<NodesByFile> {
  const uris = collectSarifUris(runs);
  if (uris.length === 0) return new Map();
  const kinds = [...ENCLOSING_SYMBOL_KINDS];
  const uriPlaceholders = uris.map(() => "?").join(",");
  const kindPlaceholders = kinds.map(() => "?").join(",");
  const sql =
    `SELECT id, file_path, start_line, end_line, kind FROM nodes ` +
    `WHERE file_path IN (${uriPlaceholders}) AND kind IN (${kindPlaceholders})`;
  const params = [...uris, ...kinds];
  const rows = await store.query(sql, params);
  const projected: NodeRow[] = [];
  for (const r of rows) {
    const id = r["id"];
    const filePath = r["file_path"];
    const startLine = r["start_line"];
    const endLine = r["end_line"];
    const kind = r["kind"];
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    if (typeof kind !== "string" || kind.length === 0) continue;
    const start = Number(startLine);
    const end = Number(endLine);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    projected.push({
      id: id as NodeId,
      filePath,
      startLine: start,
      endLine: end,
      kind: kind as NodeKind,
    });
  }
  return indexNodesByFile(projected);
}

async function resolveRepoPath(opts: IngestSarifOptions): Promise<string> {
  if (opts.repo !== undefined) {
    const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
    const registry = await readRegistry(registryOpts);
    const hit = registry[opts.repo];
    if (hit) return resolve(hit.path);
    // Treat as raw path fallback for ergonomics (same convention as query CLI).
    return resolve(opts.repo);
  }
  return resolve(process.cwd());
}
