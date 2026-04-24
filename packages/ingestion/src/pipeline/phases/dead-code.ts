/**
 * Dead-code phase.
 *
 * Runs after cross-file resolution, MRO, and community clustering so every
 * referrer edge and community membership is available. For each classifiable
 * Symbol in the in-memory graph we compute one of three verdicts via
 * `@opencodehub/analysis::classifyDeadnessInMemory`:
 *
 *   - `live`                — at least one inbound referrer exists.
 *   - `dead`                — non-exported, no inbound referrers.
 *   - `unreachable-export`  — exported but no cross-module referrer.
 *
 * The phase denormalises the verdict onto each callable / type node so the
 * downstream persistence layer writes it to the `deadness` column, and
 * emits a warning log for every community whose entire membership is
 * non-live (a "ghost community").
 */

import {
  classifyDeadnessInMemory,
  type DeadCodeMembershipRow,
  type DeadCodeReferrerRow,
  type DeadCodeResult,
  type DeadCodeSymbolRow,
  type Deadness,
  deadCodeReferrerRelations,
  deadCodeSymbolKinds,
} from "@opencodehub/analysis";
import type { GraphNode } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";

export const DEAD_CODE_PHASE_NAME = "dead-code";

// Inline phase-name constants so this module stays independent of other
// phases' source files — keeps the DAG declaration self-contained and avoids
// dragging in unrelated modules when the phase is imported in isolation.
const CROSS_FILE_PHASE_NAME = "crossFile";
const MRO_PHASE_NAME = "mro";
const COMMUNITIES_PHASE_NAME = "communities";

export interface DeadCodeOutput {
  readonly classifiedCount: number;
  readonly deadCount: number;
  readonly unreachableExportCount: number;
  readonly ghostCommunityCount: number;
  readonly ghostCommunities: readonly string[];
}

export const deadCodePhase: PipelinePhase<DeadCodeOutput> = {
  name: DEAD_CODE_PHASE_NAME,
  deps: [CROSS_FILE_PHASE_NAME, MRO_PHASE_NAME, COMMUNITIES_PHASE_NAME],
  async run(ctx) {
    return runDeadCode(ctx);
  },
};

function runDeadCode(ctx: PipelineContext): DeadCodeOutput {
  const symbolKinds = deadCodeSymbolKinds();
  const referrerTypes = new Set(deadCodeReferrerRelations());

  // ---- 1. Project the in-memory graph into the analyzer's row shapes. ----
  const symbols: DeadCodeSymbolRow[] = [];
  const filePathById = new Map<string, string>();
  for (const node of ctx.graph.nodes()) {
    filePathById.set(node.id, node.filePath);
    if (!symbolKinds.has(node.kind)) continue;
    const located = node as unknown as {
      readonly startLine?: number;
      readonly isExported?: boolean;
    };
    symbols.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      startLine: typeof located.startLine === "number" ? located.startLine : 0,
      isExported: located.isExported === true,
    });
  }
  if (symbols.length === 0) {
    return {
      classifiedCount: 0,
      deadCount: 0,
      unreachableExportCount: 0,
      ghostCommunityCount: 0,
      ghostCommunities: [],
    };
  }
  const symbolIdSet = new Set(symbols.map((s) => s.id));

  const referrers: DeadCodeReferrerRow[] = [];
  const memberships: DeadCodeMembershipRow[] = [];
  for (const edge of ctx.graph.edges()) {
    const fromId = edge.from as string;
    const toId = edge.to as string;
    if (edge.type === "MEMBER_OF" && symbolIdSet.has(fromId)) {
      memberships.push({ symbolId: fromId, communityId: toId });
      continue;
    }
    if (!referrerTypes.has(edge.type)) continue;
    if (!symbolIdSet.has(toId)) continue;
    referrers.push({
      targetId: toId,
      sourceFile: filePathById.get(fromId) ?? "",
    });
  }

  // ---- 2. Classify + denormalise onto each touched Symbol node. ----------
  const result: DeadCodeResult = classifyDeadnessInMemory(symbols, referrers, memberships);
  for (const node of ctx.graph.nodes()) {
    if (!symbolKinds.has(node.kind)) continue;
    const verdict = result.symbols[node.id];
    if (verdict === undefined) continue;
    ctx.graph.addNode(withDeadness(node, verdict));
  }

  // ---- 3. Emit a warning for each ghost community. -----------------------
  //
  // `result.ghostCommunities` catches two very different situations:
  //
  //   (a) every member is truly `dead` — actual leaked code in an
  //       application. Worth surfacing.
  //   (b) every member is `unreachable-export` — a library's public surface.
  //       From this graph's internal view no local caller reaches them,
  //       but the whole point of an exported symbol is that *external*
  //       consumers do. On sdk-python this fired 110 times; on any
  //       library it is pure noise.
  //
  // We keep the classification on each node unchanged (so `deadness` still
  // rides along), but only warn on (a). We also skip tiny singleton
  // communities because a lone unreferenced symbol rarely rewards the
  // reader's attention at ingest time — it will show up via `codehub
  // verdict` or a targeted `impact` call instead.
  const MIN_COMMUNITY_MEMBERS_FOR_WARNING = 2;
  const membersByCommunity = new Map<string, string[]>();
  for (const m of memberships) {
    const bucket = membersByCommunity.get(m.communityId);
    if (bucket !== undefined) bucket.push(m.symbolId);
    else membersByCommunity.set(m.communityId, [m.symbolId]);
  }
  for (const communityId of result.ghostCommunities) {
    const members = membersByCommunity.get(communityId) ?? [];
    if (members.length < MIN_COMMUNITY_MEMBERS_FOR_WARNING) continue;
    let allDead = true;
    for (const memberId of members) {
      if (result.symbols[memberId] !== "dead") {
        allDead = false;
        break;
      }
    }
    if (!allDead) continue;
    ctx.onProgress?.({
      phase: DEAD_CODE_PHASE_NAME,
      kind: "warn",
      message: `dead-code: ghost community detected (${communityId}) — ${members.length} members, all dead`,
    });
  }

  return {
    classifiedCount: symbols.length,
    deadCount: result.dead.length,
    unreachableExportCount: result.unreachableExports.length,
    ghostCommunityCount: result.ghostCommunities.length,
    ghostCommunities: result.ghostCommunities,
  };
}

/**
 * Return a copy of `node` with `deadness` populated. Only callable / type
 * kinds carry the field in the schema — the caller is responsible for
 * filtering to those kinds. Retains every other field via spread so the
 * graph's "most-defined-wins" deduplication keeps the new node. We round-trip
 * through `unknown` because `GraphNode` is a tagged union and not every
 * variant declares a `deadness` key — TypeScript rejects the literal spread
 * otherwise.
 */
function withDeadness(node: GraphNode, deadness: Deadness): GraphNode {
  const extended = { ...(node as unknown as Record<string, unknown>), deadness };
  return extended as unknown as GraphNode;
}
