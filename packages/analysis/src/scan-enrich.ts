/**
 * `buildScanEnrichment` — derive graph signals for each SARIF scan result so
 * `enrichWithProperties` can stamp them under `properties.opencodehub.*`.
 *
 * Two tiers of signal:
 *   - File-granular (cheap, one batched read): bus factor and fix-follow-feat
 *     density (→ temporalFixDensity), off the result's File node.
 *   - Symbol-granular: the finding's enclosing symbol (resolved from
 *     `(uri, startLine)`) carries blast radius (`runImpact`, memoized per
 *     symbol + capped) and community label (one batched `MEMBER_OF` read).
 *
 * Still omitted (not materialized / not worth the cost): `centrality`
 * (PageRank recompute) and `cochangeScore` (temporal table). Every
 * `ResultEnrichment` field is optional, so omitting is honest, not lossy.
 *
 * Cost control: blast radius is the only per-symbol graph traversal. It is
 * memoized so N findings in one symbol cost one `runImpact`, and the number of
 * distinct symbols queried is capped at {@link MAX_IMPACT_QUERIES}; symbols
 * past the cap get every other signal but no blastRadius, and the run-level
 * stamp records that the cap was hit (no silent truncation).
 *
 * Determinism: the enrichment is a pure function of the graph + the (already
 * deterministic) SARIF; no clock or run id is emitted, and the impact cap is
 * applied in a deterministic symbol order, so a re-scan of the same commit
 * produces byte-identical enriched output.
 */

import type { CommunityNode, GraphNode, NodeId } from "@opencodehub/core-types";
import type { EnrichmentInput, ResultEnrichment, SarifLog } from "@opencodehub/sarif";
import type { IGraphStore } from "@opencodehub/storage";
import {
  findEnclosingSymbolId,
  indexNodesByFile,
  type NodeRow,
  type NodesByFile,
} from "./enclosing-symbol.js";
import { runImpact } from "./impact.js";

/**
 * Cap on distinct enclosing symbols we run `runImpact` against per scan. Each
 * is a bounded graph traversal; on a large scan with findings spread across
 * hundreds of symbols this bounds the added work. Symbols beyond the cap still
 * get file + community signals.
 */
const MAX_IMPACT_QUERIES = 200;

/** Kinds whose nodes can enclose a finding AND can be `runImpact` targets. */
const SYMBOL_NODE_KINDS = ["Function", "Method", "Constructor", "Class"] as const;

/**
 * Pull the primary-location file uri off a SARIF result and normalize it to
 * the repo-relative POSIX form the File node id uses (`File:<rel>:<rel>`).
 * Scanners emit a mix of absolute and relative uris; the graph keys files by
 * the repo-relative path, so an un-normalized absolute uri would never match.
 */
function resultUri(result: unknown, repoPath: string): string | undefined {
  const loc = (
    result as {
      locations?: ReadonlyArray<{ physicalLocation?: { artifactLocation?: { uri?: unknown } } }>;
    }
  ).locations?.[0]?.physicalLocation?.artifactLocation?.uri;
  if (typeof loc !== "string" || loc.length === 0) return undefined;
  return toRepoRelative(loc, repoPath);
}

/** The result's primary-location start line, when present (1-based, SARIF). */
function resultStartLine(result: unknown): number | undefined {
  const line = (
    result as {
      locations?: ReadonlyArray<{ physicalLocation?: { region?: { startLine?: unknown } } }>;
    }
  ).locations?.[0]?.physicalLocation?.region?.startLine;
  return typeof line === "number" && Number.isFinite(line) ? line : undefined;
}

/** Strip a leading repoPath (and `file://`) so the uri matches the graph's relative key. */
function toRepoRelative(uri: string, repoPath: string): string {
  // Normalize separators to POSIX first: File node ids are `/`-keyed, and on
  // Windows the repoPath/uri carry backslashes, so a raw prefix compare would
  // fail to strip and the lookup would never match.
  let path = (uri.startsWith("file://") ? uri.slice("file://".length) : uri).split("\\").join("/");
  const repo = repoPath.split("\\").join("/");
  const prefix = repo.endsWith("/") ? repo : `${repo}/`;
  if (path.startsWith(prefix)) path = path.slice(prefix.length);
  return path;
}

/**
 * Read the `primaryLocationLineHash` partial fingerprint — the same key the
 * enricher's `byResultFingerprint` lookup uses. `enrichWithFingerprints` runs
 * before this, so every result carries one. Keying by fingerprint (not index)
 * is run-structure-independent: scan merges each scanner into its own SARIF
 * run, and the enricher indexes per-run, so a global index would misalign.
 */
function resultFingerprint(result: unknown): string | undefined {
  const pf = (result as { partialFingerprints?: { primaryLocationLineHash?: unknown } })
    .partialFingerprints?.primaryLocationLineHash;
  return typeof pf === "string" && pf.length > 0 ? pf : undefined;
}

/** File-granular signals off a File node (bus factor, fix-follow-feat density). */
function fileSignals(file: GraphNode): { busFactor?: number; temporalFixDensity?: number } {
  if (file.kind !== "File") return {};
  const out: { busFactor?: number; temporalFixDensity?: number } = {};
  if (typeof file.busFactor === "number") out.busFactor = file.busFactor;
  if (typeof file.fixFollowFeatDensity === "number") {
    out.temporalFixDensity = file.fixFollowFeatDensity;
  }
  return out;
}

/**
 * Build the {@link EnrichmentInput} for a scan SARIF log: a fingerprint-keyed
 * map of per-result graph signals plus a stable run-level stamp. Results whose
 * file the graph doesn't know, and that have no enclosing symbol, are simply
 * absent from the map (the enricher leaves them untouched).
 *
 * Defensive: a store missing `listNodes`/`listEdgesByType`/`listNodesByKind`
 * (minimal test fakes) degrades to whatever it can read, never throws.
 */
export async function buildScanEnrichment(
  graph: IGraphStore,
  sarif: SarifLog,
  repoPath: string,
): Promise<EnrichmentInput> {
  const baseRun: EnrichmentInput["run"] = { enrichmentVersion: "2", sources: ["graph"] };
  if (typeof graph.listNodes !== "function") return { run: baseRun };

  // --- Collect referenced files (for file signals) + their symbol index
  //     (for enclosing-symbol resolution). ---
  const uris = new Set<string>();
  for (const r of sarif.runs) {
    for (const result of r.results ?? []) {
      const uri = resultUri(result, repoPath);
      if (uri !== undefined) uris.add(uri);
    }
  }
  if (uris.size === 0) return { run: baseRun };

  const fileSignalsByUri = await loadFileSignals(graph, uris);
  const nodesByFile = await loadSymbolIndex(graph, uris);

  // --- Resolve each result's enclosing symbol, collect the distinct set. ---
  interface ResultRef {
    readonly fp: string;
    readonly uri: string;
    readonly symbolId: NodeId | undefined;
  }
  const refs: ResultRef[] = [];
  const distinctSymbols = new Set<NodeId>();
  for (const r of sarif.runs) {
    for (const result of r.results ?? []) {
      const fp = resultFingerprint(result);
      if (fp === undefined) continue;
      const uri = resultUri(result, repoPath);
      if (uri === undefined) continue;
      const line = resultStartLine(result);
      const symbolId =
        line !== undefined ? findEnclosingSymbolId(nodesByFile, uri, line) : undefined;
      if (symbolId !== undefined) distinctSymbols.add(symbolId);
      refs.push({ fp, uri, symbolId });
    }
  }

  // --- Symbol-level signals over the distinct symbol set (batched community +
  //     memoized/capped blast radius). ---
  const communityBySymbol = await loadCommunityLabels(graph, [...distinctSymbols]);
  const { blastBySymbol, capped } = await loadBlastRadii(graph, [...distinctSymbols].sort());
  // Record cap-truncation in the run stamp so a consumer never mistakes a
  // capped scan's missing blastRadius for "symbol has no dependents".
  const run: EnrichmentInput["run"] = capped
    ? { enrichmentVersion: "2", sources: ["graph", "impact-capped"] }
    : baseRun;

  // --- Assemble per-result enrichment, keyed by fingerprint. ---
  const byResultFingerprint = new Map<string, ResultEnrichment>();
  for (const ref of refs) {
    const out: {
      busFactor?: number;
      temporalFixDensity?: number;
      blastRadius?: number;
      community?: string;
    } = { ...(fileSignalsByUri.get(ref.uri) ?? {}) };
    if (ref.symbolId !== undefined) {
      const blast = blastBySymbol.get(ref.symbolId);
      if (blast !== undefined) out.blastRadius = blast;
      const community = communityBySymbol.get(ref.symbolId);
      if (community !== undefined) out.community = community;
    }
    if (Object.keys(out).length > 0) byResultFingerprint.set(ref.fp, out);
  }
  if (byResultFingerprint.size === 0) return { run };

  return { byResultFingerprint, run };
}

/** One batched File-node read → per-uri file signals (only non-empty entries). */
async function loadFileSignals(
  graph: IGraphStore,
  uris: ReadonlySet<string>,
): Promise<ReadonlyMap<string, { busFactor?: number; temporalFixDensity?: number }>> {
  const ids = [...uris].map((u) => `File:${u}:${u}`);
  const fileNodes = await graph.listNodes({ ids, kinds: ["File"] });
  const byUri = new Map<string, { busFactor?: number; temporalFixDensity?: number }>();
  for (const node of fileNodes) {
    if (node.kind !== "File") continue;
    const sig = fileSignals(node);
    if (Object.keys(sig).length > 0) byUri.set(node.filePath, sig);
  }
  return byUri;
}

/**
 * Load the enclosing-symbol index for the referenced files. Projects the
 * symbol nodes (filtered to the referenced uris) into the shared
 * `NodesByFile`. Returns an empty index when the store can't enumerate by kind.
 */
async function loadSymbolIndex(
  graph: IGraphStore,
  uris: ReadonlySet<string>,
): Promise<NodesByFile> {
  if (typeof graph.listNodesByKind !== "function") return new Map();
  const rows: NodeRow[] = [];
  for (const kind of SYMBOL_NODE_KINDS) {
    const nodes = await graph.listNodesByKind(kind);
    for (const n of nodes) {
      if (!uris.has(n.filePath)) continue;
      const startLine = (n as { startLine?: number }).startLine;
      const endLine = (n as { endLine?: number }).endLine;
      if (typeof startLine !== "number" || typeof endLine !== "number") continue;
      rows.push({ id: n.id, filePath: n.filePath, startLine, endLine, kind: n.kind });
    }
  }
  return indexNodesByFile(rows);
}

/** Batched symbol → community-label map (one MEMBER_OF read + one node read). */
async function loadCommunityLabels(
  graph: IGraphStore,
  symbolIds: readonly NodeId[],
): Promise<ReadonlyMap<NodeId, string>> {
  const out = new Map<NodeId, string>();
  if (symbolIds.length === 0 || typeof graph.listEdgesByType !== "function") return out;
  try {
    const edges = await graph.listEdgesByType("MEMBER_OF", { fromIds: [...symbolIds] });
    if (edges.length === 0) return out;
    const communityIds = [...new Set(edges.map((e) => e.to))].filter((s) => s.length > 0);
    if (communityIds.length === 0) return out;
    const communityNodes = await graph.listNodes({ ids: communityIds, kinds: ["Community"] });
    const labelById = new Map<string, string>();
    for (const node of communityNodes) {
      if (node.kind !== "Community") continue;
      const label = (node as CommunityNode).inferredLabel;
      if (typeof label === "string" && label.length > 0) labelById.set(node.id, label);
    }
    for (const edge of edges) {
      const label = labelById.get(edge.to);
      if (label !== undefined && !out.has(edge.from as NodeId)) out.set(edge.from as NodeId, label);
    }
  } catch {
    // Graph may have no community nodes yet — community is best-effort.
  }
  return out;
}

/**
 * Memoized + capped blast radius per symbol. `symbolIds` MUST be pre-sorted so
 * the cap selects a deterministic subset. Returns the per-symbol upstream
 * dependent count and whether the cap truncated the set.
 */
async function loadBlastRadii(
  graph: IGraphStore,
  symbolIds: readonly NodeId[],
): Promise<{ blastBySymbol: ReadonlyMap<NodeId, number>; capped: boolean }> {
  const blastBySymbol = new Map<NodeId, number>();
  let capped = false;
  for (const symbolId of symbolIds) {
    if (blastBySymbol.size >= MAX_IMPACT_QUERIES) {
      capped = true;
      break;
    }
    try {
      const res = await runImpact(graph, {
        target: "",
        targetUid: symbolId,
        direction: "upstream",
      });
      blastBySymbol.set(symbolId, res.totalAffected);
    } catch {
      // A symbol the impact traversal can't resolve contributes no blastRadius.
    }
  }
  return { blastBySymbol, capped };
}
