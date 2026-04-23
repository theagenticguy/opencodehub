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

import type { IGraphStore, TraverseQuery, TraverseResult } from "@opencodehub/storage";
import { maxOrphanMultiplier, type OrphanGrade, riskFromScore, scoreFromDepths } from "./risk.js";
import type {
  AffectedProcess,
  ImpactDepthBucket,
  ImpactQuery,
  ImpactResult,
  NodeRef,
} from "./types.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_RELATION_TYPES: readonly string[] = [
  "CALLS",
  "IMPORTS",
  "EXTENDS",
  "IMPLEMENTS",
  "METHOD_OVERRIDES",
  "METHOD_IMPLEMENTS",
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

async function resolveByName(store: IGraphStore, name: string): Promise<readonly NodeRef[]> {
  const rows = await store.query(
    "SELECT id, name, file_path, kind FROM nodes WHERE name = ? ORDER BY id",
    [name],
  );
  const all = rows.map(rowToNodeRef);
  // Prefer resolved nodes over unresolved placeholder Property rows when both
  // exist for the same name. Unresolved entries have file_path "<unresolved>"
  // and are parser-emitted stubs — never the intended impact target.
  const resolved = all.filter((n) => n.filePath !== "<unresolved>");
  return resolved.length > 0 ? resolved : all;
}

async function resolveById(store: IGraphStore, id: string): Promise<NodeRef | undefined> {
  const rows = await store.query(
    "SELECT id, name, file_path, kind FROM nodes WHERE id = ? LIMIT 1",
    [id],
  );
  const first = rows[0];
  return first ? rowToNodeRef(first) : undefined;
}

function rowToNodeRef(row: Record<string, unknown>): NodeRef {
  return {
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    filePath: String(row["file_path"] ?? ""),
    kind: String(row["kind"] ?? ""),
  };
}

/** Issue one IN-list lookup per traversal direction to hydrate node refs. */
async function hydrateNodes(
  store: IGraphStore,
  ids: readonly string[],
): Promise<ReadonlyMap<string, NodeRef>> {
  const out = new Map<string, NodeRef>();
  if (ids.length === 0) return out;
  const unique = Array.from(new Set(ids));
  const placeholders = unique.map(() => "?").join(",");
  const rows = await store.query(
    `SELECT id, name, file_path, kind FROM nodes WHERE id IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    const ref = rowToNodeRef(row);
    out.set(ref.id, ref);
  }
  return out;
}

/**
 * For each traversal hit, look up which relation type actually connected it
 * to its predecessor on the path. The traversal layer exposes `path` (a
 * list of node ids) but not the connecting relation types, so we query the
 * relations table once to cover every predecessor→node pair we care about.
 */
async function relationTypesByEdge(
  store: IGraphStore,
  hits: readonly TraverseResult[],
  direction: ImpactQuery["direction"],
): Promise<ReadonlyMap<string, string>> {
  const map = new Map<string, string>();
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
  const fromPlaceholders = Array.from(fromIds, () => "?").join(",");
  const toPlaceholders = Array.from(toIds, () => "?").join(",");
  const rows = await store.query(
    `SELECT from_id, to_id, type FROM relations
       WHERE from_id IN (${fromPlaceholders}) AND to_id IN (${toPlaceholders})`,
    [...fromIds, ...toIds],
  );
  for (const row of rows) {
    const from = String(row["from_id"] ?? "");
    const to = String(row["to_id"] ?? "");
    const type = String(row["type"] ?? "");
    // Store under both keys so lookup works for either traversal direction.
    map.set(`${from}|${to}`, type);
  }
  for (const h of hits) {
    if (h.path.length < 2) continue;
    const prev = h.path[h.path.length - 2];
    const curr = h.nodeId;
    if (!prev) continue;
    if (!map.has(`${prev}|${curr}`) && !map.has(`${curr}|${prev}`)) {
      map.set(`${prev}|${curr}`, "UNKNOWN");
    }
  }
  return map;
}

/**
 * Bulk-fetch the orphan grade for each affected File path. We query by
 * `file_path` + `kind = 'File'` because the traversal surfaces symbol ids,
 * not file ids; one File row per path lets us decide once per file rather
 * than once per traversal hit. Missing rows resolve to `undefined`, which
 * the multiplier treats as `active` (no bump).
 */
async function fetchOrphanGrades(
  store: IGraphStore,
  filePaths: readonly string[],
): Promise<ReadonlyMap<string, OrphanGrade | undefined>> {
  const out = new Map<string, OrphanGrade | undefined>();
  if (filePaths.length === 0) return out;
  const unique = Array.from(new Set(filePaths));
  const placeholders = unique.map(() => "?").join(",");
  const rows = await store.query(
    `SELECT file_path, orphan_grade FROM nodes
       WHERE kind = 'File' AND file_path IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    const filePath = String(row["file_path"] ?? "");
    const raw = row["orphan_grade"];
    if (typeof raw === "string" && isOrphanGrade(raw)) {
      out.set(filePath, raw);
    } else {
      out.set(filePath, undefined);
    }
  }
  for (const p of unique) if (!out.has(p)) out.set(p, undefined);
  return out;
}

function isOrphanGrade(value: string): value is OrphanGrade {
  return (
    value === "active" || value === "orphaned" || value === "abandoned" || value === "fossilized"
  );
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
  // begins the flow. To find processes that involve a target symbol, pick any
  // PROCESS_STEP edge where the target appears as either endpoint, then match
  // Process nodes whose entry_point_id equals the containing process's root.
  // We approximate "containing process" via the step=1 predecessor chain: for
  // every step-1 edge whose to_id is reachable from target, the from_id is
  // an entry point. In practice matching any PROCESS_STEP edge touching
  // target gives the correct Process set because ingestion emits one chain
  // per process and every step's predecessor traces back to the entry point.
  const placeholders = symbolIds.map(() => "?").join(",");
  // Walk PROCESS_STEP edges *backwards* from each target symbol to the
  // containing Process's entry point. Starting at targets (not every Process)
  // prunes early. `USING KEY (ancestor_id)` dedupes the recursion frontier
  // so dense call graphs don't blow up the recursion.
  const processRows = await store.query(
    `WITH RECURSIVE member_ancestors(ancestor_id, depth)
       USING KEY (ancestor_id) AS (
       SELECT CAST(n.id AS TEXT), 0
         FROM nodes n
        WHERE n.id IN (${placeholders})
       UNION ALL
       SELECT r.from_id, ma.depth + 1
         FROM member_ancestors ma
         JOIN relations r ON r.to_id = ma.ancestor_id AND r.type = 'PROCESS_STEP'
        WHERE ma.depth < 8
     )
     SELECT DISTINCT p.id, p.name, p.entry_point_id
       FROM nodes p
       JOIN member_ancestors ma ON ma.ancestor_id = p.entry_point_id
      WHERE p.kind = 'Process'`,
    [...symbolIds],
  );
  if (processRows.length === 0) return [];

  const entryIds = processRows
    .map((row) => String(row["entry_point_id"] ?? ""))
    .filter((s) => s.length > 0);
  const entryMap = new Map<string, string>();
  if (entryIds.length > 0) {
    const uniq = Array.from(new Set(entryIds));
    const ePlaceholders = uniq.map(() => "?").join(",");
    const entryRows = await store.query(
      `SELECT id, file_path FROM nodes WHERE id IN (${ePlaceholders})`,
      uniq,
    );
    for (const e of entryRows) {
      entryMap.set(String(e["id"] ?? ""), String(e["file_path"] ?? ""));
    }
  }

  const out: AffectedProcess[] = [];
  for (const row of processRows) {
    const id = String(row["id"] ?? "");
    const name = String(row["name"] ?? "");
    const entryId = String(row["entry_point_id"] ?? "");
    const entryPointFile = entryMap.get(entryId) ?? "";
    out.push({ id, name, entryPointFile });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function viaRelationFor(hit: TraverseResult, relMap: ReadonlyMap<string, string>): string {
  if (hit.path.length < 2) return "UNKNOWN";
  const prev = hit.path[hit.path.length - 2];
  const curr = hit.nodeId;
  if (!prev) return "UNKNOWN";
  return relMap.get(`${prev}|${curr}`) ?? relMap.get(`${curr}|${prev}`) ?? "UNKNOWN";
}

export async function runImpact(store: IGraphStore, q: ImpactQuery): Promise<ImpactResult> {
  const maxDepth = q.maxDepth ?? DEFAULT_MAX_DEPTH;
  const minConfidence = q.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const relationTypes =
    q.relationTypes && q.relationTypes.length > 0 ? q.relationTypes : DEFAULT_RELATION_TYPES;

  // 1. Resolve target.
  let candidates: readonly NodeRef[];
  if (looksLikeNodeId(q.target)) {
    const hit = await resolveById(store, q.target);
    candidates = hit ? [hit] : [];
  } else {
    candidates = await resolveByName(store, q.target);
  }

  if (candidates.length === 0) {
    return {
      targetCandidates: [],
      byDepth: [],
      risk: "LOW",
      totalAffected: 0,
      ambiguous: false,
      affectedProcesses: [],
      hint: `No symbol or node id matched "${q.target}". Run codehub analyze to refresh the index.`,
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
      hint: `Multiple symbols named "${q.target}" were found. Narrow the query by passing a node id or restricting scope by file path.`,
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
    };
  }

  // 2. Traversal.
  const dir: TraverseQuery["direction"] =
    q.direction === "upstream" ? "up" : q.direction === "downstream" ? "down" : "both";
  const hits = await store.traverse({
    startId: chosen.id,
    direction: dir,
    maxDepth,
    relationTypes,
    minConfidence,
  });

  // 3. Resolve node metadata + incoming relation type in bulk.
  const ids = hits.map((h) => h.nodeId);
  const [refMap, relMap] = await Promise.all([
    hydrateNodes(store, ids),
    relationTypesByEdge(store, hits, q.direction),
  ]);

  // 4. Group by depth.
  const depthBuckets = new Map<number, (NodeRef & { readonly viaRelation: string })[]>();
  for (const hit of hits) {
    const ref = refMap.get(hit.nodeId);
    if (!ref) continue;
    const via = viaRelationFor(hit, relMap);
    const bucket = depthBuckets.get(hit.depth) ?? [];
    bucket.push({ ...ref, viaRelation: via });
    depthBuckets.set(hit.depth, bucket);
  }

  const byDepth: ImpactDepthBucket[] = [];
  for (const depth of [...depthBuckets.keys()].sort((a, b) => a - b)) {
    const nodes = depthBuckets.get(depth) ?? [];
    byDepth.push({ depth, nodes });
  }

  // 5. Risk. Apply an orphan multiplier: every affected File
  // whose `orphan_grade` is non-`active` bumps the raw score up before we
  // bucket it into a tier. Abandoned and fossilised grades share the top
  // multiplier (1.6); orphaned sits at 1.3; active is a no-op (1.0).
  const d1 = depthBuckets.get(1)?.length ?? 0;
  const d2 = depthBuckets.get(2)?.length ?? 0;
  const d3 = depthBuckets.get(3)?.length ?? 0;
  const rawScore = scoreFromDepths(d1, d2, d3);
  const affectedFilePaths = new Set<string>();
  for (const hit of hits) {
    const ref = refMap.get(hit.nodeId);
    if (ref === undefined) continue;
    if (ref.filePath.length > 0) affectedFilePaths.add(ref.filePath);
  }
  const orphanGrades = await fetchOrphanGrades(store, [...affectedFilePaths]);
  const bump = maxOrphanMultiplier(orphanGrades.values());
  const risk = riskFromScore(rawScore * bump);
  const totalAffected = hits.length;
  const affectedProcesses = await fetchAffectedProcesses(store, [chosen.id]);

  return {
    targetCandidates: candidates,
    chosenTarget: chosen,
    byDepth,
    risk,
    totalAffected,
    ambiguous: false,
    affectedProcesses,
  };
}
