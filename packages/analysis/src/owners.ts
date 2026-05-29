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
