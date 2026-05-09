/**
 * BOM body item: PageRank-ranked symbol skeleton (AC-M5-4 — item 2/9).
 *
 * The skeleton is the deterministic "what matters here?" view of a repo,
 * built from `Function`/`Class`/`Method` nodes ranked by call-graph
 * PageRank. The output is a flat row stream that downstream tooling
 * (the pack writer in T-W2-5; the future `code_skeleton` MCP surface)
 * consumes as a strictly-ordered table.
 *
 * Algorithm:
 *   1. `store.listNodes({ kinds: ["Function","Class","Method"] })`
 *      to enumerate every callable target.
 *   2. Pull every `CALLS` edge via `IGraphStore.listEdgesByType('CALLS')`
 *      (typed `CodeRelation`) and feed `EdgeLike[]` into
 *      `buildAdjacency` from `@opencodehub/analysis`.
 *   3. Run `pageRank(adj, 0.85, 50)` — fixed iterations + damping per
 *      W-M5-3 (no tolerance-based convergence; numerical drift would
 *      break the byte-identity guarantee that `pack_hash` and the
 *      future `graphHash` both depend on).
 *   4. Sort rows by `score DESC` with `id ASC` as the lex-stable
 *      tiebreak. Per the BM25-over-node-id stub-pollution lesson
 *      (`.erpaval/solutions/conventions/bm25-over-node-id-favors-stubs.md`)
 *      the packet flags this as a known consideration: stub
 *      re-export nodes can outrank real call-targets when the call
 *      graph is sparse. For now we surface every callable kind and
 *      let downstream consumers filter; refining the kind set is a
 *      future-work item, not an AC-M5-4 deliverable.
 *
 * Determinism contract — non-negotiable:
 *   - Output ordering is the result of `Array.prototype.sort` over a
 *     plain JS comparator (`score DESC, id ASC`); no Map insertion
 *     order leaks into the row sequence.
 *   - PageRank itself is deterministic by construction (fixed
 *     iterations + dangling-mass redistribution); see
 *     `packages/analysis/src/page-rank.ts`.
 *   - Two consecutive calls on the same store return identical rows.
 */

import { type Adjacency, buildAdjacency, type EdgeLike, pageRank } from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";

/** A single row in the skeleton BOM file. */
export interface SkeletonRow {
  /** Graph node id. */
  readonly id: string;
  /** Discriminator — restricted to the three callable kinds we rank. */
  readonly kind: "Function" | "Class" | "Method";
  /** Symbol short name. */
  readonly name: string;
  /** Repo-relative file path the symbol is declared in. */
  readonly filePath: string;
  /** 1-based start line, when the underlying node is a `LocatedNode`. */
  readonly startLine?: number;
  /** 1-based end line, when the underlying node is a `LocatedNode`. */
  readonly endLine?: number;
  /** PageRank score from {@link pageRank}. Always finite, in `[0, 1]`. */
  readonly score: number;
  /** Owner short name — populated only for `Method` nodes. */
  readonly owner?: string;
}

/** Inputs to {@link buildSkeleton}. */
export interface SkeletonOpts {
  readonly store: IGraphStore;
  /** Optional top-N cap applied after sorting. Negative or non-finite values are ignored. */
  readonly limit?: number;
}

/** Internal: callable kinds we rank. */
const CALLABLE_KINDS: readonly ("Function" | "Class" | "Method")[] = [
  "Function",
  "Class",
  "Method",
];

/**
 * Build the PageRank-ranked symbol skeleton.
 *
 * Returns a frozen, deterministically-ordered list of {@link SkeletonRow}.
 * Empty graphs return `[]`. Repos with no `CALLS` edges still return
 * every callable, scored against a teleport-only PageRank baseline (every
 * node receives `1/n` initial mass; uniform redistribution).
 */
export async function buildSkeleton(opts: SkeletonOpts): Promise<readonly SkeletonRow[]> {
  const { store } = opts;
  const callables = await store.listNodes({ kinds: [...CALLABLE_KINDS] });

  // Empty graphs short-circuit before we hit SQL — pageRank on an empty
  // adjacency returns an empty Float64Array, but skipping the round-trip
  // keeps the empty path strictly synchronous after the listNodes await.
  if (callables.length === 0) return [];

  // Pull every CALLS edge via the typed finder. CodeRelation rows expose
  // `from`/`to` (NodeIds), already filtered to type='CALLS' at the storage
  // layer.
  const rawEdges = await store.listEdgesByType("CALLS");
  const edges: EdgeLike[] = rawEdges.map((r) => ({ fromId: r.from, toId: r.to }));

  const adj: Adjacency = buildAdjacency(edges);
  const scores = pageRank(adj, 0.85, 50);

  // Build id → score map from `adj.nodes` so downstream lookups are O(1).
  // pageRank returns a Float64Array index-aligned to `adj.nodes` — never
  // re-derive the index ordering from edges directly.
  const scoreById = new Map<string, number>();
  for (let i = 0; i < adj.nodes.length; i += 1) {
    const id = adj.nodes[i];
    if (id === undefined) continue;
    scoreById.set(id, scores[i] ?? 0);
  }

  const rows: SkeletonRow[] = [];
  for (const node of callables) {
    if (node.kind !== "Function" && node.kind !== "Class" && node.kind !== "Method") {
      continue; // listNodes already filtered, but TS narrowing wants the discriminator check.
    }
    // `LocatedNode` carries optional startLine/endLine; ClassNode + the two
    // callable kinds all extend LocatedNode, so the optional reads are safe.
    const located = node as typeof node & {
      readonly startLine?: number;
      readonly endLine?: number;
    };
    const owner = node.kind === "Method" ? node.owner : undefined;
    const row: SkeletonRow = {
      id: node.id,
      kind: node.kind,
      name: node.name,
      filePath: node.filePath,
      score: scoreById.get(node.id) ?? 0,
      ...(located.startLine !== undefined ? { startLine: located.startLine } : {}),
      ...(located.endLine !== undefined ? { endLine: located.endLine } : {}),
      ...(owner !== undefined ? { owner } : {}),
    };
    rows.push(row);
  }

  // score DESC, id ASC (lex-stable). Float64 ties resolve via id compare;
  // never trust insertion order from the Map iteration above.
  rows.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const limit = clampLimit(opts.limit);
  return limit !== undefined ? rows.slice(0, limit) : rows;
}

function clampLimit(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  return Math.floor(n);
}
