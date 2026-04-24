/**
 * LLM module-overview renderer.
 *
 * Opt-in narrative generator: given a ranked set of Community nodes and their
 * top symbols/files, issues ONE summarizer call per module (via
 * `@opencodehub/summarizer`'s Bedrock Converse client) and returns the
 * resulting narrative prose, keyed by community id. Callers fold the prose
 * into the existing deterministic architecture pages.
 *
 * Contract boundaries:
 *   - Gated twice upstream: `--llm` must be true AND `opts.offline` must be
 *     false. This module does NOT re-check offline; the CLI enforces that.
 *   - `maxCalls === 0` is dry-run: enumerate the candidate modules and return
 *     a deterministic placeholder narrative. No Bedrock traffic.
 *   - `maxCalls > 0` bounds actual Bedrock calls. Top-N communities by
 *     `symbolCount` win; overflow modules fall back to no-narrative.
 *   - A summarizer failure on one module falls back to a deterministic
 *     "(summarizer failed; deterministic fallback)" string for THAT module
 *     while the overall generation continues.
 *
 * We reuse the symbol summarizer's Bedrock client verbatim (no new Bedrock
 * abstraction, per the P1-1 anti-goals). The summarizer's schema is
 * callable-oriented, so we treat each module as a synthetic "callable" whose
 * `source` block is a compact listing of key files + symbols; the resulting
 * `purpose` field (30-400 chars) becomes the module narrative, and any
 * populated `side_effects` items become a "Key behaviors" bullet list.
 */

import type { SummarizeInput, SummarizerResult, SymbolSummaryT } from "@opencodehub/summarizer";

export interface LlmModuleInput {
  /** Community node id. Stable across runs; safe to use as a cache key. */
  readonly communityId: string;
  /** Display label for the module (inferred label, falling back to name). */
  readonly label: string;
  /** Aggregate member-symbol count — drives ranking. */
  readonly symbolCount: number;
  /** Top files in the module by member count, pre-sorted by the caller. */
  readonly topFiles: readonly string[];
  /** Top symbol names (e.g. class/function names) — pre-sorted by caller. */
  readonly topSymbols: readonly string[];
}

export interface LlmOverviewOptions {
  /** When false, `renderLlmOverviews` returns an empty map without side effects. */
  readonly enabled: boolean;
  /**
   * Cap on actual Bedrock calls. `0` is dry-run: the returned map is
   * populated with deterministic placeholders for every module the LLM
   * path WOULD have summarized, but Bedrock is never contacted.
   */
  readonly maxCalls: number;
  /** Optional override for the Bedrock model id. */
  readonly modelId?: string;
  /**
   * Test seam: injects a summarizer that fulfills the same contract as
   * `@opencodehub/summarizer`'s `summarizeSymbol`. Production leaves this
   * undefined and the module lazily imports the real summarizer + Bedrock
   * SDK on first call.
   */
  readonly summarize?: (input: SummarizeInput) => Promise<SummarizerResult>;
}

export interface LlmOverview {
  readonly communityId: string;
  /** Narrative markdown paragraph(s). Always non-empty. */
  readonly markdown: string;
  /**
   * `"llm"` when the summarizer returned a validated summary, `"dry-run"` when
   * the module was enumerated but not summarized (maxCalls=0 or capacity
   * exceeded), or `"fallback"` when Bedrock threw and we used a deterministic
   * substitute.
   */
  readonly source: "llm" | "dry-run" | "fallback";
}

const DRY_RUN_NOTE = "_(LLM narrative would be generated here; `--max-llm-calls` is 0 — dry-run.)_";
const CAPACITY_NOTE =
  "_(LLM narrative capacity exhausted; increase `--max-llm-calls` to include this module.)_";

/**
 * Generate module-overview narratives for the top-ranked communities.
 *
 * Returns a map keyed by `communityId`. Communities not present in the map
 * should be rendered by the deterministic pipeline as-is.
 */
export async function renderLlmOverviews(
  modules: readonly LlmModuleInput[],
  options: LlmOverviewOptions,
): Promise<ReadonlyMap<string, LlmOverview>> {
  const out = new Map<string, LlmOverview>();
  if (!options.enabled) return out;

  // Rank by symbolCount desc, ties broken by label asc, then communityId asc
  // so top-N selection is stable across runs.
  const ranked = [...modules].sort((a, b) => {
    if (b.symbolCount !== a.symbolCount) return b.symbolCount - a.symbolCount;
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    return a.communityId.localeCompare(b.communityId);
  });

  if (options.maxCalls === 0) {
    for (const mod of ranked) {
      out.set(mod.communityId, {
        communityId: mod.communityId,
        markdown: renderDryRunMarkdown(mod),
        source: "dry-run",
      });
    }
    return out;
  }

  const summarize = options.summarize ?? (await defaultSummarizer(options.modelId));

  for (const mod of ranked.slice(0, options.maxCalls)) {
    out.set(mod.communityId, await summarizeOne(mod, summarize));
  }
  for (const mod of ranked.slice(options.maxCalls)) {
    out.set(mod.communityId, {
      communityId: mod.communityId,
      markdown: `### ${mod.label}\n\n${CAPACITY_NOTE}\n`,
      source: "dry-run",
    });
  }
  return out;
}

async function summarizeOne(
  mod: LlmModuleInput,
  summarize: (input: SummarizeInput) => Promise<SummarizerResult>,
): Promise<LlmOverview> {
  const input = buildSummarizerInput(mod);
  try {
    const result = await summarize(input);
    return {
      communityId: mod.communityId,
      markdown: renderNarrative(mod, result.summary),
      source: "llm",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      communityId: mod.communityId,
      markdown: renderFallback(mod, reason),
      source: "fallback",
    };
  }
}

/**
 * Build a synthetic summarizer input from the module structure. The
 * summarizer schema is callable-oriented, so we construct a virtual "source"
 * block whose lines index the files + symbols. The summarizer's `purpose`
 * field becomes our narrative; its `side_effects` feed the "Key behaviors"
 * bullet list.
 */
export function buildSummarizerInput(mod: LlmModuleInput): SummarizeInput {
  const lines: string[] = [];
  lines.push(`module: ${mod.label}`);
  lines.push(`symbol_count: ${mod.symbolCount}`);
  lines.push("key_files:");
  if (mod.topFiles.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of mod.topFiles) lines.push(`  - ${f}`);
  }
  lines.push("key_symbols:");
  if (mod.topSymbols.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of mod.topSymbols) lines.push(`  - ${s}`);
  }
  const source = lines.join("\n");
  return {
    source,
    filePath: `<synthetic>/module/${mod.communityId}`,
    lineStart: 1,
    lineEnd: lines.length,
    docstring:
      `Summarize this code module: name=${mod.label}, ` +
      `key symbols=${mod.topSymbols.join(", ") || "(none)"}, ` +
      `key files=${mod.topFiles.join(", ") || "(none)"}.`,
    enclosingClass: null,
  };
}

function renderNarrative(mod: LlmModuleInput, summary: SymbolSummaryT): string {
  const parts: string[] = [];
  parts.push(`### ${mod.label}`);
  parts.push("");
  parts.push(summary.purpose.trim());
  if (summary.side_effects.length > 0) {
    parts.push("");
    parts.push("**Key behaviors:**");
    parts.push("");
    for (const effect of summary.side_effects) {
      parts.push(`- ${effect}`);
    }
  }
  if (summary.invariants && summary.invariants.length > 0) {
    parts.push("");
    parts.push("**Invariants:**");
    parts.push("");
    for (const inv of summary.invariants) {
      parts.push(`- ${inv}`);
    }
  }
  parts.push("");
  return parts.join("\n");
}

function renderDryRunMarkdown(mod: LlmModuleInput): string {
  const lines: string[] = [];
  lines.push(`### ${mod.label}`);
  lines.push("");
  lines.push(DRY_RUN_NOTE);
  lines.push("");
  lines.push(`- **Members:** ${mod.symbolCount}`);
  if (mod.topSymbols.length > 0) {
    lines.push(`- **Key symbols:** ${mod.topSymbols.slice(0, 5).join(", ")}`);
  }
  if (mod.topFiles.length > 0) {
    lines.push(`- **Key files:** ${mod.topFiles.slice(0, 5).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderFallback(mod: LlmModuleInput, reason: string): string {
  const lines: string[] = [];
  lines.push(`### ${mod.label}`);
  lines.push("");
  lines.push(`_(summarizer failed; deterministic fallback: ${truncate(reason, 200)})_`);
  lines.push("");
  lines.push(`- **Members:** ${mod.symbolCount}`);
  if (mod.topSymbols.length > 0) {
    lines.push(`- **Key symbols:** ${mod.topSymbols.slice(0, 5).join(", ")}`);
  }
  if (mod.topFiles.length > 0) {
    lines.push(`- **Key files:** ${mod.topFiles.slice(0, 5).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Default summarizer — lazy-imports `@opencodehub/summarizer` and
 * `@aws-sdk/client-bedrock-runtime` so test runs with `enabled=false` or
 * `maxCalls=0` never touch the SDK's credential provider chain.
 */
async function defaultSummarizer(
  modelId: string | undefined,
): Promise<(input: SummarizeInput) => Promise<SummarizerResult>> {
  const [{ BedrockRuntimeClient }, { summarizeSymbol }] = await Promise.all([
    import("@aws-sdk/client-bedrock-runtime"),
    import("@opencodehub/summarizer"),
  ]);
  const client = new BedrockRuntimeClient({});
  return (input) => summarizeSymbol(client, input, modelId !== undefined ? { modelId } : {});
}
