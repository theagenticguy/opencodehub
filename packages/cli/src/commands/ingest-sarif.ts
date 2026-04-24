/**
 * `codehub ingest-sarif <sarif-file>` — import a SARIF v2.1.0 log into
 * the code graph as `Finding` nodes + `FOUND_IN` edges.
 *
 * Flow:
 *   1. Read + parse + validate the SARIF file via `@opencodehub/sarif`.
 *   2. Resolve the target repo (either `--repo <name>` or CWD).
 *   3. For every Result across every Run, build a Finding node keyed by
 *      `Finding:<scannerId>:<ruleId>:<uri>:<startLine>`. Emit FOUND_IN
 *      edges to the target File node (matched by `artifactLocation.uri`
 *      against `file_path`).
 *   4. UPSERT into DuckDB via `store.bulkLoad({ mode: "upsert" })`.
 *
 * The command is idempotent — re-running with the same SARIF produces
 * the same nodes and edges. Results without a parsable location (no
 * physicalLocation.artifactLocation.uri) are skipped with a warning.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type FindingNode, KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import { SarifLogSchema, type SarifResult, type SarifRun } from "@opencodehub/sarif";
import { DuckDbStore, resolveDbPath } from "@opencodehub/storage";
import { readRegistry } from "../registry.js";

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
  const log = validation.data;

  const repoPath = await resolveRepoPath(opts);

  const { graph, summary } = buildFindingsGraph(log.runs);

  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath);
  try {
    await store.open();
    await store.createSchema();
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
 */
export function buildFindingsGraph(runs: readonly SarifRun[]): {
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

      // If the scanner annotated the result with opencodehub.symbolId,
      // emit an extra FOUND_IN edge to the symbol node. This is how
      // scanners hand us per-symbol findings (e.g. semgrep results that
      // resolve inside a function body).
      const symbolId = extractSymbolId(result);
      if (symbolId !== undefined) {
        graph.addEdge({
          from: finding.node.id,
          to: symbolId as NodeId,
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
