/**
 * Confidence-demotion phase — mark heuristic (confidence=0.5) edges as
 * "SCIP-unconfirmed" when a compiler-grade SCIP edge covers the same
 * triple.
 *
 * Invariant: the oracle layer (SCIP) CONFIRMS, never REJECTS. Heuristic
 * edges are not deleted; instead any heuristic CALLS / REFERENCES /
 * EXTENDS edge whose `(from, type, to)` triple ALSO appears as a
 * confidence=1.0 SCIP-sourced edge is demoted to confidence=0.2 with
 * `+scip-unconfirmed` appended to its reason.
 *
 * Runs AFTER `scip-index` and BEFORE downstream structural analysis
 * (mro, communities, dead-code).
 */

import type { CodeRelation } from "@opencodehub/core-types";
import { SCIP_PROVENANCE_PREFIXES } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { SCIP_INDEX_PHASE_NAME } from "./scip-index.js";

export const CONFIDENCE_DEMOTE_PHASE_NAME = "confidence-demote";

const HEURISTIC_CONFIDENCE = 0.5;
const DEMOTED_CONFIDENCE = 0.2;
const ORACLE_CONFIDENCE = 1.0;
const UNCONFIRMED_SUFFIX = "+scip-unconfirmed";

const DEMOTABLE_EDGE_TYPES: ReadonlySet<string> = new Set(["CALLS", "REFERENCES", "EXTENDS"]);

export interface ConfidenceDemoteOutput {
  readonly demotedCount: number;
  readonly perLanguage: Readonly<Record<string, number>>;
  readonly durationMs: number;
}

export const confidenceDemotePhase: PipelinePhase<ConfidenceDemoteOutput> = {
  name: CONFIDENCE_DEMOTE_PHASE_NAME,
  deps: [SCIP_INDEX_PHASE_NAME],
  async run(ctx) {
    return runConfidenceDemote(ctx);
  },
};

function runConfidenceDemote(ctx: PipelineContext): ConfidenceDemoteOutput {
  const start = Date.now();

  const oracleConfirmedTriples = new Set<string>();
  for (const edge of ctx.graph.edges()) {
    if (edge.confidence !== ORACLE_CONFIDENCE) continue;
    if (!isScipReason(edge.reason)) continue;
    oracleConfirmedTriples.add(tripleKey(edge.from as string, edge.type, edge.to as string));
  }

  const perLanguage: Record<string, number> = {};
  let demotedCount = 0;

  for (const edge of ctx.graph.edges()) {
    if (edge.confidence !== HEURISTIC_CONFIDENCE) continue;
    if (!DEMOTABLE_EDGE_TYPES.has(edge.type)) continue;
    const key = tripleKey(edge.from as string, edge.type, edge.to as string);
    if (!oracleConfirmedTriples.has(key)) continue;

    const currentReason = edge.reason ?? "";
    if (currentReason.endsWith(UNCONFIRMED_SUFFIX)) continue;

    const mutable = edge as { -readonly [K in keyof CodeRelation]: CodeRelation[K] };
    mutable.confidence = DEMOTED_CONFIDENCE;
    mutable.reason =
      currentReason.length > 0 ? `${currentReason}${UNCONFIRMED_SUFFIX}` : UNCONFIRMED_SUFFIX;

    demotedCount += 1;
    const lang = inferLanguage(edge.from as string);
    perLanguage[lang] = (perLanguage[lang] ?? 0) + 1;
  }

  if (demotedCount > 0) {
    const summary = Object.entries(perLanguage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([lang, count]) => `${lang}=${count}`)
      .join(", ");
    ctx.onProgress?.({
      phase: CONFIDENCE_DEMOTE_PHASE_NAME,
      kind: "note",
      message: `confidence-demote: demoted ${demotedCount} heuristic edge(s) [${summary}]`,
    });
  }

  return {
    demotedCount,
    perLanguage,
    durationMs: Date.now() - start,
  };
}

function isScipReason(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  for (const prefix of SCIP_PROVENANCE_PREFIXES) {
    if (reason.startsWith(prefix)) return true;
  }
  return false;
}

function tripleKey(from: string, type: string, to: string): string {
  return `${from}\x00${type}\x00${to}`;
}

function inferLanguage(fromId: string): string {
  const firstColon = fromId.indexOf(":");
  if (firstColon < 0) return "unknown";
  const afterKind = fromId.slice(firstColon + 1);
  const secondColon = afterKind.indexOf(":");
  const filePath = secondColon < 0 ? afterKind : afterKind.slice(0, secondColon);
  if (filePath.endsWith(".py") || filePath.endsWith(".pyi")) return "python";
  if (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".jsx") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  ) {
    return "typescript";
  }
  if (filePath.endsWith(".go")) return "go";
  if (filePath.endsWith(".rs")) return "rust";
  return "unknown";
}
