/**
 * Impact analysis: resolve a symbol or node id to its graph neighborhood
 * across up to N hops and classify the blast radius into a risk bucket.
 *
 * The implementation is purely a wrapper around the storage traversal
 * surface. It:
 *   1. Resolves the caller-supplied target to at most one node id.
 *   2. Runs an up / down / both traversal with the requested depth and
 *      relation filters.
 *   3. Resolves the returned node ids back to `{id, name, filePath, kind}`
 *      in a single bulk lookup per direction so we don't quadratic-query
 *      the store.
 */

import type { CommunityNode, GraphNode, ProcessNode } from "@opencodehub/core-types";
import type { IGraphStore, TraverseQuery, TraverseResult } from "@opencodehub/storage";
import type {
  AffectedModule,
  AffectedProcess,
  ImpactDepthBucket,
  ImpactEdge,
  ImpactQuery,
  ImpactResult,
  NodeRef,
  RiskLevel,
} from "./types.js";

const DEFAULT_MAX_DEPTH = 3;
// Raised from 0.5 → 0.7. Heuristic edges are filtered by default; callers can
// loosen with `minConfidence` when they want the full blast radius including
// unconfirmed edges.
const DEFAULT_MIN_CONFIDENCE = 0.7;
// Default includes HAS_METHOD + HAS_PROPERTY so class-scoped impact traversal
// finds method-owning classes without the caller having to opt in.
const DEFAULT_RELATION_TYPES: readonly string[] = [
  "CALLS",
  "IMPORTS",
  "EXTENDS",
  "IMPLEMENTS",
  "METHOD_OVERRIDES",
  "METHOD_IMPLEMENTS",
  "HAS_METHOD",
  "HAS_PROPERTY",
];

/**
 * Heuristic: a target string is treated as a node id when it contains at
 * least two colons (kind separator + file-path separator). Plain symbol
 * names don't normally contain colons; qualified names like `Foo::bar`
 * are ambiguous but still resolve correctly because the bulk lookup will
 * simply return zero rows and fall through to the name query.
 */
function looksLikeNodeId(target: string): boolean {
  const firstColon = target.indexOf(":");
  if (firstColon === -1) return false;
  const secondColon = target.indexOf(":", firstColon + 1);
  return secondColon !== -1;
}

/**
 * Filter for test files — mirrors the ingestion processes phase. Any path
 * containing a `tests/`, `test/`, or `__tests__/` segment, or a `.test.` /
 * `.spec.` infix, is treated as a test file and dropped when `includeTests`
 * is false.
 */
export function isTestPath(filePath: string): boolean {
  if (filePath.length === 0) return false;
  const lower = filePath.toLowerCase();
  const segments = lower.split("/");
  for (const s of segments) {
    if (s === "test" || s === "tests" || s === "spec" || s === "specs" || s === "__tests__") {
      return true;
    }
  }
  if (lower.includes(".test.") || lower.includes(".spec.")) return true;
  return false;
}

async function resolveByName(
  store: IGraphStore,
  name: string,
  filters: { readonly filePath?: string; readonly kind?: string },
): Promise<readonly NodeRef[]> {
  // AC-A-6b: typed finder replaces a `WHERE name = ?` raw SELECT.
  const nodes = await store.listNodesByName(name);
  const all = nodes.map(nodeToNodeRef);
  // Prefer resolved nodes over unresolved placeholder Property rows when both
  // exist for the same name. Unresolved entries have file_path "<unresolved>"
  // and are parser-emitted stubs — never the intended impact target.
  const resolved = all.filter((n) => n.filePath !== "<unresolved>");
  let pool = resolved.length > 0 ? resolved : all;
  if (filters.kind) {
    pool = pool.filter((n) => n.kind === filters.kind);
  }
  if (filters.filePath) {
    // Match suffix, so callers can pass a short relative hint like
    // "src/foo.ts" and disambiguate even when the stored path is absolute.
    const hint = filters.filePath;
    pool = pool.filter((n) => n.filePath === hint || n.filePath.endsWith(hint));
  }
  return pool;
}

async function resolveById(store: IGraphStore, id: string): Promise<NodeRef | undefined> {
  // AC-A-6b: typed `listNodes({ids})` replaces a `WHERE id = ? LIMIT 1` raw SELECT.
  const nodes = await store.listNodes({ ids: [id], limit: 1 });
  const first = nodes[0];
  return first ? nodeToNodeRef(first) : undefined;
}

function nodeToNodeRef(node: GraphNode): NodeRef {
  return {
    id: node.id,
    name: node.name,
    filePath: node.filePath,
    kind: node.kind,
  };
}

/** Issue one IN-list lookup per traversal direction to hydrate node refs. */
async function hydrateNodes(
  store: IGraphStore,
  ids: readonly string[],
): Promise<ReadonlyMap<string, NodeRef>> {
  const out = new Map<string, NodeRef>();
  if (ids.length === 0) return out;
  // AC-A-6b: typed `listNodes({ids})` replaces a `WHERE id IN (?,?,...)` raw SELECT.
  // The adapter de-dupes the input set internally so callers can pass repeats.
  const nodes = await store.listNodes({ ids });
  for (const node of nodes) {
    out.set(node.id, nodeToNodeRef(node));
  }
  return out;
}

/**
 * Edge record returned by `relationsByEdge`, keyed by the `"from|to"` pair
 * so both traversal directions hit the same lookup.
 */
interface TraversedEdgeRecord {
  readonly type: string;
  readonly confidence: number;
  readonly reason?: string;
}

/**
 * For each traversal hit, look up which relation connected it to its
 * predecessor on the path. The traversal layer exposes `path` (a list of
 * node ids) but not the connecting relation, so we query the relations
 * table once to cover every predecessor→node pair we care about. We keep
 * full edge records (type + confidence + reason) so callers can both
 * render the `viaRelation` label AND aggregate a confidence-tier histogram
 * over the traversed edges without re-querying.
 */
async function relationsByEdge(
  store: IGraphStore,
  hits: readonly TraverseResult[],
  direction: ImpactQuery["direction"],
): Promise<ReadonlyMap<string, TraversedEdgeRecord>> {
  const map = new Map<string, TraversedEdgeRecord>();
  if (hits.length === 0) return map;
  const pairs = new Set<string>();
  for (const h of hits) {
    if (h.path.length < 2) continue;
    const prev = h.path[h.path.length - 2];
    const curr = h.nodeId;
    if (!prev) continue;
    // For both-direction queries, a single path doesn't tell us if this hop
    // was up or down, so we look up relations in both orientations.
    if (direction === "upstream" || direction === "both") {
      pairs.add(`${curr}|${prev}`);
    }
    if (direction === "downstream" || direction === "both") {
      pairs.add(`${prev}|${curr}`);
    }
  }
  const fromIds = new Set<string>();
  const toIds = new Set<string>();
  for (const pair of pairs) {
    const sep = pair.indexOf("|");
    if (sep === -1) continue;
    const from = pair.slice(0, sep);
    const to = pair.slice(sep + 1);
    fromIds.add(from);
    toIds.add(to);
  }
  if (fromIds.size === 0 || toIds.size === 0) return map;
  // AC-A-6b: typed `listEdges({fromIds, toIds})` replaces a `WHERE from_id IN
  // (?) AND to_id IN (?)` raw SELECT. The result is filtered down to the
  // exact predecessor → successor pairs we walked, since `listEdges` returns
  // every edge whose endpoints fall in the AND-combined sets.
  const edges = await store.listEdges({
    fromIds: [...fromIds],
    toIds: [...toIds],
  });
  for (const edge of edges) {
    const confidence = edge.confidence;
    const record: TraversedEdgeRecord = {
      type: edge.type,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      ...(typeof edge.reason === "string" && edge.reason.length > 0 ? { reason: edge.reason } : {}),
    };
    map.set(`${edge.from}|${edge.to}`, record);
  }
  for (const h of hits) {
    if (h.path.length < 2) continue;
    const prev = h.path[h.path.length - 2];
    const curr = h.nodeId;
    if (!prev) continue;
    if (!map.has(`${prev}|${curr}`) && !map.has(`${curr}|${prev}`)) {
      map.set(`${prev}|${curr}`, { type: "UNKNOWN", confidence: 0 });
    }
  }
  return map;
}

/**
 * Risk banding keyed on `impactedCount` + `processCount`. The thresholds are
 * fixed here so downstream consumers see stable tier assignments across tools.
 */
export function riskFromImpactedCount(impactedCount: number, processCount: number): RiskLevel {
  if (impactedCount >= 1000 || processCount >= 5) return "CRITICAL";
  if (impactedCount >= 100 || processCount >= 2) return "HIGH";
  if (impactedCount >= 10) return "MEDIUM";
  return "LOW";
}

/**
 * Bulk-fetch Community membership for every affected symbol + resolve the
 * community's display label. Returns a ranked list by hit count; `impact`
 * is `"direct"` when any depth-1 node sits in the community, else
 * `"indirect"`.
 */
async function fetchAffectedModules(
  store: IGraphStore,
  allIds: readonly string[],
  directIds: readonly string[],
): Promise<readonly AffectedModule[]> {
  if (allIds.length === 0) return [];
  const unique = Array.from(new Set(allIds));
  // AC-A-6b: typed `listEdgesByType("MEMBER_OF", {fromIds})` replaces a
  // `WHERE type = 'MEMBER_OF' AND from_id IN (?)` raw SELECT.
  const membership = await store.listEdgesByType("MEMBER_OF", { fromIds: unique });
  if (membership.length === 0) return [];

  const communityHits = new Map<string, number>();
  const directIdSet = new Set(directIds);
  const directCommunityIds = new Set<string>();
  for (const edge of membership) {
    const symbolId = edge.from;
    const communityId = edge.to;
    if (symbolId.length === 0 || communityId.length === 0) continue;
    communityHits.set(communityId, (communityHits.get(communityId) ?? 0) + 1);
    if (directIdSet.has(symbolId)) directCommunityIds.add(communityId);
  }
  if (communityHits.size === 0) return [];

  const communityIds = [...communityHits.keys()];
  // AC-A-6b: typed `listNodes({ids, kinds:["Community"]})` replaces a raw
  // SELECT joined to the kind discriminator. We narrow to Community + cast
  // because the `inferred_label` field lives on CommunityNode only.
  const labelNodes = await store.listNodes({ ids: communityIds, kinds: ["Community"] });
  const labelById = new Map<string, string>();
  for (const node of labelNodes) {
    if (node.kind !== "Community") continue;
    const community = node as CommunityNode;
    const inferred = community.inferredLabel;
    const label =
      typeof inferred === "string" && inferred.length > 0
        ? inferred
        : community.name.length > 0
          ? community.name
          : community.id;
    labelById.set(community.id, label);
  }

  const out: AffectedModule[] = [];
  for (const [communityId, hits] of communityHits) {
    const label = labelById.get(communityId) ?? communityId;
    out.push({
      name: label,
      hits,
      impact: directCommunityIds.has(communityId) ? "direct" : "indirect",
    });
  }
  out.sort((a, b) => (a.hits === b.hits ? a.name.localeCompare(b.name) : b.hits - a.hits));
  return out;
}

/**
 * Fetch Process nodes reachable from any of the affected symbols via
 * PROCESS_STEP edges, then hydrate their name and entry-point file path in
 * bulk. Mirrors the shape used by detect-changes so callers see the same
 * {id, name, entryPointFile} triples regardless of entry point.
 */
async function fetchAffectedProcesses(
  store: IGraphStore,
  symbolIds: readonly string[],
): Promise<readonly AffectedProcess[]> {
  if (symbolIds.length === 0) return [];
  // PROCESS_STEP edges connect Function/Method symbols, not Process nodes.
  // Each Process node carries an entry_point_id pointing at the symbol that
  // begins the flow. To find processes that involve a target symbol, walk
  // PROCESS_STEP edges *backwards* from each target to the containing
  // Process's entry point, then match Process nodes whose `entry_point_id`
  // equals any reached ancestor (including the target itself).
  //
  // AC-A-6b: typed `traverseAncestors` replaces the `WITH RECURSIVE
  // member_ancestors USING KEY (ancestor_id)` raw query.
  // `listNodesByEntryPoint(id)` replaces the `WHERE entry_point_id = ?`
  // join. Each ancestor lookup is an independent traversal, so we run them
  // in parallel and dedupe the union.
  const ancestorIds = new Set<string>();
  for (const sid of symbolIds) ancestorIds.add(sid);
  // Limit per-target traversal to depth 8 to match the original
  // `WHERE ma.depth < 8` guard. The original SQL counted depth from 0; the
  // typed finder excludes the start node so depth 8 yields up to 8 hops
  // away, matching `< 8` plus the depth-0 start row.
  const ancestorWalks = await Promise.all(
    symbolIds.map((startId) =>
      store.traverseAncestors({
        fromId: startId,
        edgeTypes: ["PROCESS_STEP"],
        maxDepth: 8,
      }),
    ),
  );
  for (const walk of ancestorWalks) {
    for (const r of walk) ancestorIds.add(r.nodeId);
  }
  if (ancestorIds.size === 0) return [];

  // Resolve every Process whose entry_point_id is in the ancestor set. The
  // typed finder is single-id, so we fan out and dedupe by Process id.
  const processNodes = new Map<string, ProcessNode>();
  await Promise.all(
    [...ancestorIds].map(async (entryId) => {
      const matches = await store.listNodesByEntryPoint(entryId);
      for (const node of matches) {
        if (node.kind !== "Process") continue;
        processNodes.set(node.id, node as ProcessNode);
      }
    }),
  );
  if (processNodes.size === 0) return [];

  // Bulk hydrate the entry-point file paths so the result row carries
  // `entryPointFile` exactly as the SARIF / detect-changes consumers expect.
  const entryIds = [...processNodes.values()]
    .map((p) => p.entryPointId ?? "")
    .filter((s) => s.length > 0);
  const entryMap = new Map<string, string>();
  if (entryIds.length > 0) {
    const entryNodes = await store.listNodes({ ids: entryIds });
    for (const node of entryNodes) {
      entryMap.set(node.id, node.filePath);
    }
  }

  const out: AffectedProcess[] = [];
  for (const proc of processNodes.values()) {
    const entryId = proc.entryPointId ?? "";
    const entryPointFile = entryId.length > 0 ? (entryMap.get(entryId) ?? "") : "";
    out.push({ id: proc.id, name: proc.name, entryPointFile });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function lookupEdgeRecord(
  hit: TraverseResult,
  relMap: ReadonlyMap<string, TraversedEdgeRecord>,
):
  | {
      readonly record: TraversedEdgeRecord;
      readonly fromId: string;
      readonly toId: string;
    }
  | undefined {
  if (hit.path.length < 2) return undefined;
  const prev = hit.path[hit.path.length - 2];
  const curr = hit.nodeId;
  if (!prev) return undefined;
  const forward = relMap.get(`${prev}|${curr}`);
  if (forward !== undefined) return { record: forward, fromId: prev, toId: curr };
  const reverse = relMap.get(`${curr}|${prev}`);
  if (reverse !== undefined) return { record: reverse, fromId: curr, toId: prev };
  return { record: { type: "UNKNOWN", confidence: 0 }, fromId: prev, toId: curr };
}

export async function runImpact(store: IGraphStore, q: ImpactQuery): Promise<ImpactResult> {
  const maxDepth = q.maxDepth ?? DEFAULT_MAX_DEPTH;
  const minConfidence = q.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const relationTypes =
    q.relationTypes && q.relationTypes.length > 0 ? q.relationTypes : DEFAULT_RELATION_TYPES;
  const includeTests = q.includeTests ?? false;

  // 1. Resolve target.
  //    - targetUid (exact id) beats name lookup entirely.
  //    - Otherwise fall back to the `looksLikeNodeId` heuristic on the
  //      `target` string, then by-name with optional file_path / kind
  //      filters for disambiguation.
  let candidates: readonly NodeRef[];
  if (q.targetUid && q.targetUid.length > 0) {
    const hit = await resolveById(store, q.targetUid);
    candidates = hit ? [hit] : [];
  } else if (looksLikeNodeId(q.target)) {
    const hit = await resolveById(store, q.target);
    candidates = hit ? [hit] : [];
  } else {
    const filters: { filePath?: string; kind?: string } = {};
    if (q.filePath !== undefined) filters.filePath = q.filePath;
    if (q.kind !== undefined) filters.kind = q.kind;
    candidates = await resolveByName(store, q.target, filters);
  }

  if (candidates.length === 0) {
    const soughtLabel = q.targetUid && q.targetUid.length > 0 ? q.targetUid : q.target;
    return {
      targetCandidates: [],
      byDepth: [],
      risk: "LOW",
      totalAffected: 0,
      ambiguous: false,
      affectedProcesses: [],
      affectedModules: [],
      traversedEdges: [],
      hint: `No symbol or node id matched "${soughtLabel}". Run codehub analyze to refresh the index.`,
    };
  }

  if (candidates.length > 1) {
    return {
      targetCandidates: candidates,
      byDepth: [],
      risk: "LOW",
      totalAffected: 0,
      ambiguous: true,
      affectedProcesses: [],
      affectedModules: [],
      traversedEdges: [],
      hint: `Multiple symbols named "${q.target}" were found. Narrow the query by passing target_uid, file_path, or kind.`,
    };
  }

  const chosen = candidates[0];
  if (!chosen) {
    // Unreachable given the length check above — the early return on empty
    // candidates covers it — but satisfies noUncheckedIndexedAccess.
    return {
      targetCandidates: candidates,
      byDepth: [],
      risk: "LOW",
      totalAffected: 0,
      ambiguous: false,
      affectedProcesses: [],
      affectedModules: [],
      traversedEdges: [],
    };
  }

  // 2. Traversal.
  const dir: TraverseQuery["direction"] =
    q.direction === "upstream" ? "up" : q.direction === "downstream" ? "down" : "both";
  const rawHits = await store.traverse({
    startId: chosen.id,
    direction: dir,
    maxDepth,
    relationTypes,
    minConfidence,
  });

  // 3. Resolve node metadata + incoming relation record in bulk.
  const ids = rawHits.map((h) => h.nodeId);
  const [refMap, relMap] = await Promise.all([
    hydrateNodes(store, ids),
    relationsByEdge(store, rawHits, q.direction),
  ]);

  // 3a. Apply `includeTests` filter after hydration — we need the filePath
  //     from the refMap to decide. Test nodes are dropped from every
  //     downstream aggregation (depth buckets, traversed edges, modules,
  //     processes) so the risk tier and count reflect production code only.
  const hits: TraverseResult[] = [];
  for (const hit of rawHits) {
    if (!includeTests) {
      const ref = refMap.get(hit.nodeId);
      if (ref && isTestPath(ref.filePath)) continue;
    }
    hits.push(hit);
  }

  // 4. Group by depth and flatten every predecessor→node hop into the
  //    `traversedEdges` list. Each edge is emitted once per traversal path
  //    it appears on — the MCP confidence-breakdown aggregator treats each
  //    hop as one vote, which matches "how many edges does the blast
  //    radius rely on".
  const depthBuckets = new Map<number, (NodeRef & { readonly viaRelation: string })[]>();
  const traversedEdges: ImpactEdge[] = [];
  for (const hit of hits) {
    const ref = refMap.get(hit.nodeId);
    if (!ref) continue;
    const edgeInfo = lookupEdgeRecord(hit, relMap);
    const via = edgeInfo?.record.type ?? "UNKNOWN";
    const bucket = depthBuckets.get(hit.depth) ?? [];
    bucket.push({ ...ref, viaRelation: via });
    depthBuckets.set(hit.depth, bucket);
    if (edgeInfo !== undefined) {
      traversedEdges.push({
        fromId: edgeInfo.fromId,
        toId: edgeInfo.toId,
        type: edgeInfo.record.type,
        confidence: edgeInfo.record.confidence,
        ...(edgeInfo.record.reason !== undefined ? { reason: edgeInfo.record.reason } : {}),
      });
    }
  }

  const byDepth: ImpactDepthBucket[] = [];
  for (const depth of [...depthBuckets.keys()].sort((a, b) => a - b)) {
    const nodes = depthBuckets.get(depth) ?? [];
    byDepth.push({ depth, nodes });
  }

  // 5. Enrichment: affected processes + affected modules. Fetched from
  //    the traversed ids so excluded test files never land in the summary.
  const hitIds = hits.map((h) => h.nodeId);
  const directIds = depthBuckets.get(1)?.map((n) => n.id) ?? [];
  const [affectedProcesses, affectedModules] = await Promise.all([
    fetchAffectedProcesses(store, [chosen.id, ...hitIds]),
    fetchAffectedModules(store, hitIds, directIds),
  ]);

  // 6. Risk banding uses impactedCount + process count. Orphan grades no
  //    longer drive the tier — the banding is simple and predictable so
  //    agents can reason about it without probing the store.
  const totalAffected = hits.length;
  const risk = riskFromImpactedCount(totalAffected, affectedProcesses.length);

  return {
    targetCandidates: candidates,
    chosenTarget: chosen,
    byDepth,
    risk,
    totalAffected,
    ambiguous: false,
    affectedProcesses,
    affectedModules,
    traversedEdges,
  };
}
