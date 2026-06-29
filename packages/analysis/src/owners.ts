/**
 * `listOwners` — ranked `OWNED_BY` contributors for a graph node.
 *
 * Walks the outgoing `OWNED_BY` edges from a File / Symbol / Community
 * node in confidence-descending order (with a `.to` ASC tiebreak), slices
 * to `limit` BEFORE the Contributor join, then joins each surviving edge
 * to its Contributor node for display metadata (name + email/hash).
 *
 * Lifted verbatim from the MCP `owners` tool so the MCP surface and the
 * `codehub owners` CLI command share one impl. The slice-before-join order
 * is load-bearing — it is preserved exactly.
 */

import type { IGraphStore } from "@opencodehub/storage";

export interface OwnerRow {
  readonly email: string;
  readonly emailHash: string;
  readonly name: string;
  readonly weight: number;
}

export async function listOwners(
  graph: IGraphStore,
  target: string,
  limit: number,
): Promise<readonly OwnerRow[]> {
  const ownedBy = await graph.listEdgesByType("OWNED_BY", { fromIds: [target] });
  const sorted = [...ownedBy].sort((a, b) => {
    const ac = a.confidence ?? 0;
    const bc = b.confidence ?? 0;
    if (ac !== bc) return bc - ac;
    return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  });
  const sliced = sorted.slice(0, limit);
  const contributors = await graph.listNodesByKind("Contributor");
  const contribById = new Map<string, (typeof contributors)[number]>();
  for (const c of contributors) contribById.set(c.id, c);

  const owners: OwnerRow[] = [];
  for (const edge of sliced) {
    const c = contribById.get(edge.to);
    if (c === undefined) continue;
    const plain = typeof c.emailPlain === "string" ? c.emailPlain : "";
    owners.push({
      email: plain,
      emailHash: c.emailHash,
      name: c.name,
      weight: edge.confidence ?? 0,
    });
  }
  return owners;
}

/**
 * Map each repo-relative path to its `OWNED_BY` contributor identifiers, for
 * the policy engine's `ownership_required` rule. One batched edge query over
 * every File node, grouped by source file — so a verdict over N changed files
 * is a single graph round-trip, not N calls to {@link listOwners}.
 *
 * Owner identity is the contributor's plain email when present (what an
 * operator writes in `require_approval_from`), falling back to the email hash.
 * Identifiers per path are deduped and sorted for deterministic output. Paths
 * with no owner edges are omitted (the policy engine treats a missing entry as
 * "no graph owners"). An empty `files` list returns an empty map.
 */
export async function collectOwnersByPath(
  graph: IGraphStore,
  files: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  if (files.length === 0) return out;
  // Defensive: legacy / minimal test fakes implement only part of IGraphStore.
  // A store without the edge/node readers yields an empty map rather than
  // throwing — the policy engine then treats every path as "no graph owners",
  // exactly as before this wiring existed.
  if (typeof graph.listEdgesByType !== "function" || typeof graph.listNodesByKind !== "function") {
    return out;
  }

  const fileNodeIds = files.map((f) => `File:${f}:${f}`);
  const edges = await graph.listEdgesByType("OWNED_BY", { fromIds: fileNodeIds });
  if (edges.length === 0) return out;

  const contributors = await graph.listNodesByKind("Contributor");
  const contribById = new Map<string, (typeof contributors)[number]>();
  for (const c of contributors) contribById.set(c.id, c);

  // File node id back to its repo-relative path (id form is `File:<path>:<path>`).
  const pathByNodeId = new Map<string, string>();
  for (let i = 0; i < files.length; i += 1) {
    const path = files[i];
    const id = fileNodeIds[i];
    if (path !== undefined && id !== undefined) pathByNodeId.set(id, path);
  }

  const idsByPath = new Map<string, Set<string>>();
  for (const edge of edges) {
    const path = pathByNodeId.get(edge.from);
    if (path === undefined) continue;
    const c = contribById.get(edge.to);
    if (c === undefined) continue;
    const plain = typeof c.emailPlain === "string" ? c.emailPlain : "";
    const identifier = plain.length > 0 ? plain : c.emailHash;
    if (identifier.length === 0) continue;
    const set = idsByPath.get(path) ?? new Set<string>();
    set.add(identifier);
    idsByPath.set(path, set);
  }

  for (const [path, set] of idsByPath) {
    out.set(path, [...set].sort());
  }
  return out;
}
