/**
 * Communities phase — cluster callable symbols with the Leiden algorithm.
 *
 * We build an undirected, weighted graph whose nodes are every `Function`,
 * `Method`, `Class`, `Interface`, `Struct`, and `Trait` in the workspace.
 * Edge weights:
 *   - `CALLS`        → 1.0 (strongest intra-feature signal)
 *   - `HAS_METHOD`   → 0.5 (co-location by ownership)
 *
 * Files, folders, routes, tools, modules, communities, and processes are
 * intentionally excluded so the clustering reflects *behavioural* coupling
 * rather than filesystem neighbourhoods.
 *
 * The Leiden call is parameterised with a fixed `randomSeed` so two runs on
 * the same input graph produce identical community assignments. If the
 * external Leiden integration produces zero communities (e.g. the graph was
 * trivially empty or the library's shape changed), we fall back to a
 * deterministic connected-components labeler and emit a warning.
 *
 * Community names are synthesised from the top-3 most-frequent identifier
 * tokens across the community's members (splitting on camelCase, snake_case,
 * and dots; filtering against a small English stop-word list). A fallback of
 * `community-<id>` is used when no tokens survive.
 */

import { Graph as GraphtyGraph, leiden } from "@graphty/algorithms";
import type { CommunityNode, NodeId } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { resolveIncrementalView } from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { MRO_PHASE_NAME } from "./mro.js";
import { STRUCTURE_PHASE_NAME } from "./structure.js";

export const COMMUNITIES_PHASE_NAME = "communities";

export interface CommunitiesOutput {
  readonly communityCount: number;
  readonly memberCount: number;
  readonly unclusteredCount: number;
  readonly usedFallback: boolean;
}

/**
 * Node kinds eligible for community clustering.
 */
const CLUSTERABLE_KINDS: ReadonlySet<string> = new Set([
  "Function",
  "Method",
  "Class",
  "Interface",
  "Struct",
  "Trait",
  "Constructor",
]);

const LEIDEN_SEED = 42;

export const communitiesPhase: PipelinePhase<CommunitiesOutput> = {
  name: COMMUNITIES_PHASE_NAME,
  deps: [MRO_PHASE_NAME, STRUCTURE_PHASE_NAME, INCREMENTAL_SCOPE_PHASE_NAME],
  async run(ctx) {
    return runCommunities(ctx);
  },
};

function runCommunities(ctx: PipelineContext): CommunitiesOutput {
  // ---- : incremental carry-forward short-circuit. ---------------
  //
  // Leiden is deterministic given a fixed seed AND a fixed input graph,
  // but its partition is sensitive to every edge weight — running on a
  // sparsified subgraph drifts in the general case. For the determinism
  // gate (`--full` vs `--incremental` at the same commit must byte-equal)
  // we take the conservative path: when the incremental view is active,
  // carry forward every Community node + MEMBER_OF edge from the prior
  // graph verbatim, and skip Leiden entirely. The post-parse callable
  // graph is byte-identical to the prior run under no-semantic-change, so
  // re-running Leiden would produce the same partition anyway; skipping
  // the work is a pure speedup. If the closure introduces new callables
  // whose community assignment matters, the 30% safety valve in
  // incremental-scope flips mode back to "full" and Leiden runs normally.
  const view = resolveIncrementalView(ctx);
  if (
    view.active &&
    view.previousGraph?.edges !== undefined &&
    view.previousGraph.nodes !== undefined
  ) {
    let carriedMembers = 0;
    let carriedCommunities = 0;
    for (const n of view.previousGraph.nodes) {
      if (n.kind !== "Community") continue;
      ctx.graph.addNode(n);
      carriedCommunities += 1;
    }
    for (const e of view.previousGraph.edges) {
      if (e.type !== "MEMBER_OF") continue;
      ctx.graph.addEdge({
        from: e.from,
        to: e.to,
        type: e.type,
        confidence: e.confidence,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      });
      carriedMembers += 1;
    }
    return {
      communityCount: carriedCommunities,
      memberCount: carriedMembers,
      unclusteredCount: 0,
      usedFallback: false,
    };
  }

  // ---- Collect eligible nodes + their names for later labeling. ---------
  const memberNameById = new Map<string, string>();
  for (const n of ctx.graph.nodes()) {
    if (CLUSTERABLE_KINDS.has(n.kind)) memberNameById.set(n.id, n.name);
  }
  const memberIds = [...memberNameById.keys()].sort();
  if (memberIds.length === 0) {
    return { communityCount: 0, memberCount: 0, unclusteredCount: 0, usedFallback: false };
  }

  // ---- Build weighted undirected graph for Leiden. ----------------------
  // We aggregate weights across parallel edges (CALLS + HAS_METHOD between
  // the same pair collapse to a single weight).
  const edgeWeights = new Map<string, number>();
  const clusterableSet = new Set(memberIds);
  for (const e of ctx.graph.edges()) {
    if (e.type !== "CALLS" && e.type !== "HAS_METHOD") continue;
    const from = e.from as string;
    const to = e.to as string;
    if (!clusterableSet.has(from) || !clusterableSet.has(to)) continue;
    if (from === to) continue; // self-loops carry no clustering information.
    const weight = e.type === "CALLS" ? 1.0 : 0.5;
    // Key by sorted endpoints for undirected semantics.
    const a = from < to ? from : to;
    const b = from < to ? to : from;
    const key = `${a}\u0000${b}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + weight);
  }

  // Build the graphty graph; add nodes in sorted order for a deterministic
  // initial partition (every node starts in its own community, indexed by
  // insertion order).
  const gtyGraph = new GraphtyGraph({ directed: false, allowSelfLoops: false });
  for (const id of memberIds) gtyGraph.addNode(id);
  // Sort edges for deterministic insertion order.
  const sortedKeys = [...edgeWeights.keys()].sort();
  for (const key of sortedKeys) {
    const idx = key.indexOf("\u0000");
    if (idx < 0) continue;
    const a = key.slice(0, idx);
    const b = key.slice(idx + 1);
    const w = edgeWeights.get(key) ?? 1;
    gtyGraph.addEdge(a, b, w);
  }

  // ---- Run Leiden (or fall back to connected components). ---------------
  let communityById = new Map<string, number>();
  let usedFallback = false;
  try {
    const result = leiden(gtyGraph, { resolution: 1.0, randomSeed: LEIDEN_SEED });
    if (result.communities && result.communities.size > 0) {
      communityById = new Map(result.communities);
    } else {
      usedFallback = true;
    }
  } catch (err) {
    ctx.onProgress?.({
      phase: COMMUNITIES_PHASE_NAME,
      kind: "warn",
      message: `communities: leiden failed (${(err as Error).message}); falling back to connected components`,
    });
    usedFallback = true;
  }

  if (usedFallback) {
    communityById = connectedComponents(memberIds, edgeWeights);
  }

  // ---- Canonicalise community ids. --------------------------------------
  // The raw Leiden ids are arbitrary integers and might vary in their
  // numeric value between invocations even when the partitioning is the
  // same. Rekey each group by its lexicographically smallest member id —
  // this is stable as long as the partition itself is.
  const groupsByRaw = new Map<number, string[]>();
  for (const id of memberIds) {
    const raw = communityById.get(id);
    if (raw === undefined) continue;
    const existing = groupsByRaw.get(raw);
    if (existing !== undefined) existing.push(id);
    else groupsByRaw.set(raw, [id]);
  }

  // Sort each group, then sort groups by their first member for canonical
  // iteration order.
  const canonicalGroups: { canonicalId: number; members: string[] }[] = [];
  let canonicalCounter = 0;
  const sortedGroupHeads: { head: string; raw: number }[] = [];
  for (const [raw, members] of groupsByRaw) {
    members.sort();
    const head = members[0];
    if (head !== undefined) sortedGroupHeads.push({ head, raw });
  }
  sortedGroupHeads.sort((a, b) => (a.head < b.head ? -1 : a.head > b.head ? 1 : 0));
  for (const g of sortedGroupHeads) {
    const members = groupsByRaw.get(g.raw) ?? [];
    canonicalGroups.push({ canonicalId: canonicalCounter, members });
    canonicalCounter += 1;
  }

  // ---- Emit Community nodes + MEMBER_OF edges. --------------------------
  let memberCount = 0;
  let unclusteredCount = 0;
  for (const group of canonicalGroups) {
    const { canonicalId, members } = group;
    // Skip degenerate clusters (singletons and 2-member pairs) — they
    // clutter the graph without adding meaningful functional-area signal.
    // Count them as unclustered instead. A threshold of 3 matches the
    // smallest cluster size that can form a non-trivial topology.
    if (members.length < 3) {
      unclusteredCount += members.length;
      continue;
    }
    const names = members
      .map((m) => memberNameById.get(m))
      .filter((n): n is string => n !== undefined);
    const keywords = topKeywords(names);
    const communityNodeId = makeNodeId("Community", "<global>", `community-${canonicalId}`);
    const communityNode: CommunityNode = {
      id: communityNodeId,
      kind: "Community",
      name: `community-${canonicalId}`,
      filePath: "<global>",
      symbolCount: members.length,
      cohesion: cohesion(members, edgeWeights),
      ...(keywords.length > 0
        ? {
            inferredLabel: keywords.slice(0, 3).join("-"),
            keywords,
          }
        : {}),
    };
    ctx.graph.addNode(communityNode);

    for (const member of members) {
      ctx.graph.addEdge({
        from: member as NodeId,
        to: communityNodeId,
        type: "MEMBER_OF",
        confidence: 1.0,
        reason: usedFallback ? "connected-component" : "leiden",
      });
      memberCount += 1;
    }
  }

  return {
    communityCount: canonicalGroups.filter((g) => g.members.length >= 3).length,
    memberCount,
    unclusteredCount,
    usedFallback,
  };
}

/**
 * Tokenise a list of identifier-like names and return the top-N most
 * frequent tokens, lowercased and stop-word filtered, sorted by descending
 * count with alphabetical tiebreak.
 */
function topKeywords(names: readonly string[]): readonly string[] {
  const STOP = new Set<string>([
    "get",
    "set",
    "is",
    "has",
    "the",
    "a",
    "an",
    "to",
    "from",
    "of",
    "for",
    "on",
    "in",
    "at",
    "by",
    "and",
    "or",
    "not",
    "with",
    "new",
    "my",
    "do",
    "run",
    "it",
    "init",
    "fn",
    "func",
  ]);
  const counts = new Map<string, number>();
  for (const n of names) {
    for (const tok of tokenise(n)) {
      const lower = tok.toLowerCase();
      if (lower.length < 3) continue;
      if (STOP.has(lower)) continue;
      counts.set(lower, (counts.get(lower) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : 1;
  });
  return ranked.slice(0, 5).map(([tok]) => tok);
}

function tokenise(name: string): readonly string[] {
  // Split on non-alphanumeric separators and camelCase boundaries.
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i] as string;
    const isUpper = ch >= "A" && ch <= "Z";
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    if (!isUpper && !isLower && !isDigit) {
      if (current.length > 0) parts.push(current);
      current = "";
      continue;
    }
    if (isUpper && current.length > 0) {
      const prev = current[current.length - 1] as string;
      const prevLower = prev >= "a" && prev <= "z";
      if (prevLower) {
        parts.push(current);
        current = "";
      }
    }
    current += ch;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Average weight per (unordered) intra-community edge as a very rough
 * cohesion score. Does not normalise by community size; MVP-grade signal.
 */
function cohesion(members: readonly string[], edgeWeights: ReadonlyMap<string, number>): number {
  if (members.length < 2) return 0;
  const set = new Set(members);
  let total = 0;
  let count = 0;
  for (const [key, w] of edgeWeights) {
    const idx = key.indexOf("\u0000");
    if (idx < 0) continue;
    const a = key.slice(0, idx);
    const b = key.slice(idx + 1);
    if (set.has(a) && set.has(b)) {
      total += w;
      count += 1;
    }
  }
  if (count === 0) return 0;
  return total / count;
}

/**
 * Deterministic weakly-connected-components labeler. Used when Leiden
 * integration fails or returns an empty partition.
 */
function connectedComponents(
  nodes: readonly string[],
  edgeWeights: ReadonlyMap<string, number>,
): Map<string, number> {
  const parent = new Map<string, string>();
  for (const n of nodes) parent.set(n, n);

  function find(x: string): string {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur) as string;
      parent.set(cur, parent.get(p) as string);
      cur = parent.get(cur) as string;
    }
    return cur;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Lexicographically smaller id wins — pinned for determinism.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  for (const key of [...edgeWeights.keys()].sort()) {
    const idx = key.indexOf("\u0000");
    if (idx < 0) continue;
    const a = key.slice(0, idx);
    const b = key.slice(idx + 1);
    if (parent.has(a) && parent.has(b)) union(a, b);
  }

  const rootToIndex = new Map<string, number>();
  const out = new Map<string, number>();
  let next = 0;
  for (const n of nodes) {
    const r = find(n);
    let idx = rootToIndex.get(r);
    if (idx === undefined) {
      idx = next;
      next += 1;
      rootToIndex.set(r, idx);
    }
    out.set(n, idx);
  }
  return out;
}
