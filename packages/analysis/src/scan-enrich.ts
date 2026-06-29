/**
 * `buildScanEnrichment` — derive graph signals for each SARIF scan result so
 * `enrichWithProperties` can stamp them under `properties.opencodehub.*`.
 *
 * Maps every result to the File node for its primary location and reads the
 * file-granular signals already materialized on that node by the ingestion
 * temporal phases: bus factor and fix-follow-feat density (→ temporalFixDensity).
 *
 * Scope: only signals that are a direct, cheap read off the File node are
 * emitted here. `ownershipDrift`/`cochangeScore` live on the community node /
 * temporal table, and symbol-level signals need live computation per finding
 * (blastRadius via `runImpact`, community via `MEMBER_OF`, centrality via
 * PageRank) — all deliberately omitted rather than approximated. Every
 * `ResultEnrichment` field is optional, so omitting them is honest, not lossy.
 *
 * Determinism: the enrichment is a pure function of the graph + the (already
 * deterministic) SARIF; no clock or run id is emitted, so a re-scan of the
 * same commit produces byte-identical enriched output.
 */

import type { GraphNode } from "@opencodehub/core-types";
import type { EnrichmentInput, ResultEnrichment, SarifLog } from "@opencodehub/sarif";
import type { IGraphStore } from "@opencodehub/storage";

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

/** Strip a leading repoPath (and `file://`) so the uri matches the graph's relative key. */
function toRepoRelative(uri: string, repoPath: string): string {
  let path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  const prefix = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
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

/** Project the file-granular signals off a File node into a ResultEnrichment. */
function enrichmentForFile(file: GraphNode): ResultEnrichment | undefined {
  if (file.kind !== "File") return undefined;
  const out: {
    busFactor?: number;
    temporalFixDensity?: number;
  } = {};
  if (typeof file.busFactor === "number") out.busFactor = file.busFactor;
  if (typeof file.fixFollowFeatDensity === "number") {
    out.temporalFixDensity = file.fixFollowFeatDensity;
  }
  // `ownershipDrift` and `cochangeScore` are community-level / temporal-table
  // signals, not materialized on the File node — omitted here rather than
  // approximated. `blastRadius`/`community`/`centrality` need per-finding graph
  // computation; a follow-up can add them behind a budget.
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the {@link EnrichmentInput} for a scan SARIF log. Returns a
 * fingerprint-keyed map (`byResultFingerprint`) plus a stable run-level stamp.
 * Results whose file has no materialized signals are simply absent from the
 * map (the enricher leaves those results untouched).
 *
 * Defensive: a store without `listNodes` (minimal test fakes) yields only the
 * run-level stamp, never a throw.
 */
export async function buildScanEnrichment(
  graph: IGraphStore,
  sarif: SarifLog,
  repoPath: string,
): Promise<EnrichmentInput> {
  const run: EnrichmentInput["run"] = {
    enrichmentVersion: "1",
    sources: ["graph"],
  };
  if (typeof graph.listNodes !== "function") return { run };

  // Collect the distinct file uris referenced by results, in run+result order
  // so the index map lines up with how the enricher walks the log.
  const uris = new Set<string>();
  for (const r of sarif.runs) {
    for (const result of r.results ?? []) {
      const uri = resultUri(result, repoPath);
      if (uri !== undefined) uris.add(uri);
    }
  }
  if (uris.size === 0) return { run };

  // One batched File-node read keyed by node id (`File:<uri>:<uri>`).
  const idByUri = new Map<string, string>();
  for (const uri of uris) idByUri.set(uri, `File:${uri}:${uri}`);
  const fileNodes = await graph.listNodes({ ids: [...idByUri.values()], kinds: ["File"] });
  const enrichmentByUri = new Map<string, ResultEnrichment>();
  for (const node of fileNodes) {
    if (node.kind !== "File") continue;
    const enrichment = enrichmentForFile(node);
    if (enrichment !== undefined) enrichmentByUri.set(node.filePath, enrichment);
  }
  if (enrichmentByUri.size === 0) return { run };

  // Key each result's enrichment by its primaryLocationLineHash fingerprint
  // (run-structure-independent; see resultFingerprint). Results without a
  // fingerprint or whose file has no signals are simply absent.
  const byResultFingerprint = new Map<string, ResultEnrichment>();
  for (const r of sarif.runs) {
    for (const result of r.results ?? []) {
      const fp = resultFingerprint(result);
      if (fp === undefined) continue;
      const uri = resultUri(result, repoPath);
      const enrichment = uri !== undefined ? enrichmentByUri.get(uri) : undefined;
      if (enrichment !== undefined) byResultFingerprint.set(fp, enrichment);
    }
  }
  if (byResultFingerprint.size === 0) return { run };

  return { byResultFingerprint, run };
}
