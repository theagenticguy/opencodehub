/**
 * Confidence-demotion phase — mark heuristic (confidence=0.5) edges as
 * "LSP-unconfirmed" when a compiler-grade LSP edge covers the same triple.
 *
 * Invariant: the LSP layer CONFIRMS, never REJECTS. Heuristic edges are not
 * deleted; instead any heuristic CALLS / REFERENCES / EXTENDS edge whose
 * `(from, type, to)` triple ALSO appears as a confidence=1.0 LSP-sourced
 * edge is demoted to confidence=0.2 with `+lsp-unconfirmed` appended to its
 * reason. Consumers can filter heuristic-only noise via
 * `confidence >= 0.5`; the LSP-sourced edge remains at 1.0 and unchanged.
 *
 * The `KnowledgeGraph.addEdge` dedupe retains the higher-confidence edge
 * per `(from, type, to, step)`. Heuristic and LSP edges coexist at the
 * same triple only when they differ in `step` (or when tests bypass the
 * dedupe by design); the phase handles both cases uniformly.
 *
 * Runs AFTER every LSP phase and BEFORE downstream structural analysis
 * (mro, communities, dead-code) so those phases observe demoted
 * confidence when they compute weights.
 */

import type { CodeRelation } from "@opencodehub/core-types";
import { LSP_PROVENANCE_PREFIXES } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { LSP_GO_PHASE_NAME } from "./lsp-go.js";
import { LSP_PYTHON_PHASE_NAME } from "./lsp-python.js";
import { LSP_RUST_PHASE_NAME } from "./lsp-rust.js";
import { LSP_TYPESCRIPT_PHASE_NAME } from "./lsp-typescript.js";

export const CONFIDENCE_DEMOTE_PHASE_NAME = "confidence-demote";

const HEURISTIC_CONFIDENCE = 0.5;
const DEMOTED_CONFIDENCE = 0.2;
const LSP_CONFIDENCE = 1.0;
const UNCONFIRMED_SUFFIX = "+lsp-unconfirmed";

const DEMOTABLE_EDGE_TYPES: ReadonlySet<string> = new Set(["CALLS", "REFERENCES", "EXTENDS"]);

export interface ConfidenceDemoteOutput {
  readonly demotedCount: number;
  readonly perLanguage: Readonly<Record<string, number>>;
  readonly durationMs: number;
}

export const confidenceDemotePhase: PipelinePhase<ConfidenceDemoteOutput> = {
  name: CONFIDENCE_DEMOTE_PHASE_NAME,
  deps: [LSP_PYTHON_PHASE_NAME, LSP_TYPESCRIPT_PHASE_NAME, LSP_GO_PHASE_NAME, LSP_RUST_PHASE_NAME],
  async run(ctx) {
    return runConfidenceDemote(ctx);
  },
};

function runConfidenceDemote(ctx: PipelineContext): ConfidenceDemoteOutput {
  const start = Date.now();

  const lspConfirmedTriples = new Set<string>();
  for (const edge of ctx.graph.edges()) {
    if (edge.confidence !== LSP_CONFIDENCE) continue;
    if (!isLspReason(edge.reason)) continue;
    lspConfirmedTriples.add(tripleKey(edge.from as string, edge.type, edge.to as string));
  }

  const perLanguage: Record<string, number> = {};
  let demotedCount = 0;

  for (const edge of ctx.graph.edges()) {
    if (edge.confidence !== HEURISTIC_CONFIDENCE) continue;
    if (!DEMOTABLE_EDGE_TYPES.has(edge.type)) continue;
    const key = tripleKey(edge.from as string, edge.type, edge.to as string);
    if (!lspConfirmedTriples.has(key)) continue;

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

function isLspReason(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  for (const prefix of LSP_PROVENANCE_PREFIXES) {
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
