/**
 * `contextCapability` — the shared graph-read middle behind the MCP `context`
 * tool and the CLI `codehub context` command.
 *
 * Only the PROCESS_STEP reader is shared: `fetchProcessParticipation` was
 * byte-identical (behaviourally) in both surfaces
 * (`cli/src/commands/context.ts` ⇄ `mcp/src/tools/context.ts`) and is lifted
 * here VERBATIM. The two surfaces' `resolveTarget` and CALLS traversal are
 * NOT shared — they diverge meaningfully (the CLI filters synthetic
 * `<external>`/`CodeElement` stubs and falls back to BM25, then reads
 * callers/callees via `graph.traverse`; the MCP side short-circuits on `uid`,
 * carries line/coverage metadata, and reads callers/callees via categorised
 * `listEdges` buckets), so each keeps its own. The capability therefore
 * exposes exactly the one provably-identical piece.
 *
 * Each surface keeps its own input validation, store lifecycle, resolver, and
 * presenter. The MCP-only enrichment (owner / cochange / confidence / buckets /
 * next_steps / staleness) STAYS in the MCP presenter.
 */

import type { GraphNode } from "@opencodehub/core-types";
import type { Capability, CapabilityContext } from "../capability.js";

/**
 * The validated, plain input `contextCapability.execute` consumes. Each surface
 * resolves its target to a concrete node id BEFORE `execute` runs (the CLI via
 * its stub-filtering + BM25 resolver, the MCP tool via its uid/name resolver),
 * then passes that id here. `repo`/`repo_uri` are resolved to a store by the
 * surface upstream, so they are not read here — they live on the input only so
 * a surface can pass its parsed args object through unchanged.
 */
export interface ContextInput {
  readonly repo?: string;
  readonly repo_uri?: string;
  /** The resolved graph node id of the target symbol. */
  readonly targetId: string;
}

/** One Process-kind partner reachable from the target via `PROCESS_STEP`. */
export interface ContextProcessParticipation {
  readonly id: string;
  readonly label: string;
  readonly step: number | null;
}

export interface ContextOutput {
  readonly repoName: string;
  readonly processes: readonly ContextProcessParticipation[];
}

/**
 * Find Process-kind partners reachable from the target via `PROCESS_STEP`
 * edges. PROCESS_STEP edges are emitted symbol-to-symbol under a Process node,
 * so we accept either direction on the join and filter on `kind = 'Process'`.
 * Ordering matches the prior `ORDER BY r.step` with a deterministic id
 * tiebreak; the result is capped at 20 partners.
 *
 * Lifted verbatim from the (behaviourally identical) bodies in
 * `cli/src/commands/context.ts` and `mcp/src/tools/context.ts`.
 */
export const contextCapability: Capability<ContextInput, ContextOutput> = {
  id: "context",
  async execute(input: ContextInput, ctx: CapabilityContext): Promise<ContextOutput> {
    const graph = ctx.store.graph;
    const targetId = input.targetId;
    const [outEdges, inEdges] = await Promise.all([
      graph.listEdgesByType("PROCESS_STEP", { fromIds: [targetId] }),
      graph.listEdgesByType("PROCESS_STEP", { toIds: [targetId] }),
    ]);
    const partnerIds = new Set<string>();
    for (const e of [...outEdges, ...inEdges]) {
      const id = e.from === targetId ? e.to : e.from;
      partnerIds.add(id);
    }
    if (partnerIds.size === 0) return { repoName: ctx.repoName, processes: [] };
    const partners = await graph.listNodes({ ids: [...partnerIds] });
    const partnerById = new Map<string, GraphNode>();
    for (const p of partners) partnerById.set(p.id, p);
    const dedup = new Map<string, { label: string; step: number | null }>();
    for (const e of [...outEdges, ...inEdges]) {
      const partnerId = e.from === targetId ? e.to : e.from;
      const partner = partnerById.get(partnerId);
      if (partner?.kind !== "Process") continue;
      if (dedup.has(partner.id)) continue;
      const inferredLabelRaw = (partner as unknown as { inferredLabel?: unknown }).inferredLabel;
      const label =
        typeof inferredLabelRaw === "string" && inferredLabelRaw.length > 0
          ? inferredLabelRaw
          : partner.name;
      const stepRaw = e.step;
      const stepNum =
        typeof stepRaw === "number" && Number.isFinite(stepRaw) && stepRaw > 0
          ? Math.trunc(stepRaw)
          : null;
      dedup.set(partner.id, { label, step: stepNum });
    }
    const items = Array.from(dedup.entries()).map(([id, v]) => ({
      id,
      label: v.label,
      step: v.step,
    }));
    // Match the prior `ORDER BY r.step` then deterministic id tiebreak.
    items.sort((a, b) => {
      const as = a.step ?? Number.POSITIVE_INFINITY;
      const bs = b.step ?? Number.POSITIVE_INFINITY;
      if (as !== bs) return as - bs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return { repoName: ctx.repoName, processes: items.slice(0, 20) };
  },
};
