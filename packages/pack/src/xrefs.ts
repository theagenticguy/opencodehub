/**
 * BOM body item: SCIP-grounded cross-references (AC-M5-5 — item 6/9).
 *
 * Two-shape union row stream:
 *   - `community` rows expose architectural clusters (`Community` nodes).
 *   - `call` rows expose the SCIP CALLS edges from the relations table.
 *
 * Determinism contract:
 *   - Community rows come first (alpha-sorted by id).
 *   - Call rows follow, sorted `(from ASC, to ASC, id ASC)` — the id is
 *     the deterministic last-resort tiebreak when the same callsite has
 *     two relation rows (e.g. duplicate CALLS edges across SCIP indexes).
 *   - The CALLS edge SQL goes through `IGraphStore.query` directly —
 *     mirroring the skeleton.ts pattern at packages/pack/src/skeleton.ts:96-105.
 *     The relations table column is `type` (NOT `kind`) and the edge
 *     endpoints are `from_id`/`to_id` (NOT `from_node`/`to_node`).
 *   - PageRank is NOT used here; this is a pure relations-table slice
 *     plus a Community-node enumeration. W-M5-3 (no tolerance-based
 *     convergence) is therefore not in scope but worth flagging for the
 *     reader.
 *
 * Confidence column: chonkie / SCIP indexes typically emit `1.0` for
 * resolved CALLS edges. We surface it raw so downstream tools can filter
 * heuristic-only edges; ties in `confidence` resolve via the `(from, to,
 * id)` tuple and never via raw float comparison alone.
 */

import type { GraphNode } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";

/** Discriminator for the two row shapes the BOM emits. */
export type XrefRow =
  | {
      readonly kind: "community";
      readonly id: string;
      readonly inferredLabel?: string;
      readonly memberCount?: number;
    }
  | {
      readonly kind: "call";
      readonly id: string;
      readonly from: string;
      readonly to: string;
      readonly confidence: number;
    };

export interface XrefsOpts {
  readonly store: IGraphStore;
}

/** SQL sent to {@link IGraphStore.query}. Hoisted to a constant so the test mock can pattern-match. */
const CALLS_SQL =
  "SELECT id, from_id, to_id, confidence FROM relations WHERE type = 'CALLS' ORDER BY id ASC";

/**
 * Build the cross-refs BOM slice.
 *
 * Empty graphs produce `[]`. Repos with no CALLS edges still surface
 * every Community row.
 */
export async function buildXrefs(opts: XrefsOpts): Promise<readonly XrefRow[]> {
  const { store } = opts;

  const communityNodes = await store.listNodes({ kinds: ["Community"] });
  const communityRows: XrefRow[] = [];
  for (const node of communityNodes) {
    if (node.kind !== "Community") continue;
    communityRows.push(toCommunityRow(node));
  }
  communityRows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rawCalls = (await store.query(CALLS_SQL)) as ReadonlyArray<Record<string, unknown>>;
  const callRows: XrefRow[] = [];
  for (const r of rawCalls) {
    const id = r["id"];
    const from = r["from_id"];
    const to = r["to_id"];
    const confidenceRaw = r["confidence"];
    if (typeof id !== "string" || typeof from !== "string" || typeof to !== "string") continue;
    const confidence = typeof confidenceRaw === "number" ? confidenceRaw : Number(confidenceRaw);
    callRows.push({
      kind: "call",
      id,
      from,
      to,
      // `Number(undefined)` is `NaN`; coerce to 0 so the wire form stays
      // numeric and byte-identity holds across runs.
      confidence: Number.isFinite(confidence) ? confidence : 0,
    });
  }
  // (from, to, id) lex order. Confidence is NOT a sort key — float
  // comparison would inject non-determinism on near-equal values.
  callRows.sort(compareCallRows);

  return [...communityRows, ...callRows];
}

/** Map a CommunityNode → community row, omitting absent optional fields. */
function toCommunityRow(node: Extract<GraphNode, { kind: "Community" }>): XrefRow {
  const row: { kind: "community"; id: string; inferredLabel?: string; memberCount?: number } = {
    kind: "community",
    id: node.id,
  };
  if (node.inferredLabel !== undefined) {
    return { ...row, inferredLabel: node.inferredLabel, ...maybeMember(node) };
  }
  return { ...row, ...maybeMember(node) };
}

function maybeMember(node: Extract<GraphNode, { kind: "Community" }>): {
  memberCount?: number;
} {
  return node.symbolCount !== undefined ? { memberCount: node.symbolCount } : {};
}

function compareCallRows(a: XrefRow, b: XrefRow): number {
  if (a.kind !== "call" || b.kind !== "call") return 0;
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
