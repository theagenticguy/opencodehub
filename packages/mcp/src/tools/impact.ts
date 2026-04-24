/**
 * `impact` — blast-radius analysis for a symbol.
 *
 * Delegates to `@opencodehub/analysis.runImpact`. Surfaces:
 *   - `target_uid` for zero-ambiguity lookup by node id,
 *   - `file_path` + `kind` filters to disambiguate same-named symbols,
 *   - `relationTypes` to widen/narrow the traversal edge set
 *     (default: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, METHOD_OVERRIDES,
 *     METHOD_IMPLEMENTS, HAS_METHOD, HAS_PROPERTY),
 *   - `includeTests` to opt into test-file dependents (default: false),
 *   - `minConfidence` to filter heuristic edges (default: 0.7).
 *
 * When the analysis layer reports `ambiguous: true` we surface the candidate
 * list as an INVALID_INPUT error envelope with a ranked list so the caller
 * can re-invoke with `target_uid`, `file_path`, or `kind` — mirroring the
 * same EC-04 disambiguation pattern used by `context`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AffectedModule, AffectedProcess, ImpactDepthBucket } from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";
import { z } from "zod";
import { callRunImpact } from "../analysis-bridge.js";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { computeConfidenceBreakdown } from "./confidence.js";
import {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

interface ImpactCochangePartner {
  readonly file: string;
  readonly cocommitCount: number;
  readonly lift: number;
  readonly lastCocommitAt: string;
}

const ImpactInput = {
  target: z
    .string()
    .min(1)
    .describe("Symbol name OR node id of the change target. Node id gives an exact match."),
  target_uid: z
    .string()
    .optional()
    .describe("Exact node id (UID) from a prior tool result. Skips name disambiguation entirely."),
  file_path: z
    .string()
    .optional()
    .describe("File path (or suffix) to disambiguate when multiple symbols share a name."),
  kind: z
    .string()
    .optional()
    .describe(
      "Kind filter to disambiguate same-named symbols (e.g. Function, Method, Class, Interface).",
    ),
  direction: z
    .enum(["upstream", "downstream", "both"])
    .optional()
    .describe(
      "upstream = dependents (who breaks if this changes), downstream = dependencies, both = transitive both ways. Default: upstream.",
    ),
  maxDepth: z.number().int().min(1).max(6).optional().describe("Traversal depth cap. Default 3."),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop edges below this confidence. Default 0.7."),
  relationTypes: z
    .array(z.string())
    .optional()
    .describe(
      "Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, METHOD_OVERRIDES, METHOD_IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES. Default: the first 8.",
    ),
  includeTests: z
    .boolean()
    .optional()
    .describe(
      "When true, test-file dependents are counted. Default false — test nodes are filtered out.",
    ),
  repo: z.string().optional().describe("Registered repo name."),
};

interface ImpactArgs {
  readonly target: string;
  readonly target_uid?: string | undefined;
  readonly file_path?: string | undefined;
  readonly kind?: string | undefined;
  readonly direction?: "upstream" | "downstream" | "both" | undefined;
  readonly maxDepth?: number | undefined;
  readonly minConfidence?: number | undefined;
  readonly relationTypes?: readonly string[] | undefined;
  readonly includeTests?: boolean | undefined;
  readonly repo?: string | undefined;
}

export async function runImpact(ctx: ToolContext, args: ImpactArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const direction = args.direction ?? "upstream";
      const q: {
        target: string;
        direction: "upstream" | "downstream" | "both";
        maxDepth?: number;
        minConfidence?: number;
        relationTypes?: readonly string[];
        targetUid?: string;
        filePath?: string;
        kind?: string;
        includeTests?: boolean;
      } = {
        target: args.target,
        direction,
      };
      if (args.maxDepth !== undefined) q.maxDepth = args.maxDepth;
      if (args.minConfidence !== undefined) q.minConfidence = args.minConfidence;
      if (args.relationTypes && args.relationTypes.length > 0) {
        q.relationTypes = args.relationTypes;
      }
      if (args.target_uid !== undefined && args.target_uid.length > 0) {
        q.targetUid = args.target_uid;
      }
      if (args.file_path !== undefined && args.file_path.length > 0) {
        q.filePath = args.file_path;
      }
      if (args.kind !== undefined && args.kind.length > 0) q.kind = args.kind;
      if (args.includeTests !== undefined) q.includeTests = args.includeTests;

      const result = await callRunImpact(store, q);

      if (result.ambiguous) {
        const candidates = result.targetCandidates.slice(0, 10).map((c) => ({
          uid: c.id,
          name: c.name,
          filePath: c.filePath,
          kind: c.kind,
        }));
        const list = candidates
          .map((c, i) => `${i + 1}. [${c.kind}] ${c.name} — ${c.filePath}  (${c.uid})`)
          .join("\n");
        return toolError(
          "INVALID_INPUT",
          `Target "${args.target}" matched ${result.targetCandidates.length} symbols. Re-call with target_uid, file_path, or kind.\n${list}`,
          "pass target_uid from one of the listed candidates, or narrow with file_path/kind",
        );
      }

      const chosen = result.chosenTarget;
      const chosenLabel = chosen ? `${chosen.name} [${chosen.kind}]` : args.target;
      const confidenceBreakdown = computeConfidenceBreakdown(result.traversedEdges);
      const cochanges = chosen ? await fetchCochangesForFile(store, chosen.filePath) : [];
      const byDepthMap = buildByDepthMap(result.byDepth);
      const affectedProcesses = mapProcesses(result.affectedProcesses);
      const affectedModules = mapModules(result.affectedModules);
      const impactedCount = result.totalAffected;

      const lines: string[] = [];
      lines.push(`Impact for ${chosenLabel} (${direction}, depth≤${q.maxDepth ?? 3})`);
      lines.push(`Risk: ${result.risk} (${impactedCount} impacted)`);
      lines.push(
        `Summary: ${byDepthMap[1]?.length ?? 0} direct, ${affectedProcesses.length} process(es), ${affectedModules.length} module(s)`,
      );
      lines.push(
        `Confidence: ${confidenceBreakdown.confirmed} confirmed, ` +
          `${confidenceBreakdown.heuristic} heuristic, ` +
          `${confidenceBreakdown.unknown} unknown`,
      );
      for (const bucket of result.byDepth) {
        lines.push(`d=${bucket.depth} (${bucket.nodes.length}):`);
        for (const n of bucket.nodes.slice(0, 20)) {
          lines.push(
            `  • ${n.name} [${n.kind}] via ${n.viaRelation} — ${n.filePath || "(no file)"}`,
          );
        }
        if (bucket.nodes.length > 20) {
          lines.push(`  … ${bucket.nodes.length - 20} more`);
        }
      }
      if (affectedProcesses.length > 0) {
        lines.push(`Affected processes (${affectedProcesses.length}):`);
        for (const p of affectedProcesses) {
          lines.push(`  ⊿ ${p.label} — ${p.entryPointFile}`);
        }
      }
      if (affectedModules.length > 0) {
        lines.push(`Affected modules (${affectedModules.length}):`);
        for (const m of affectedModules) {
          lines.push(`  ⊡ ${m.name} [${m.impact}] — ${m.hits} hit(s)`);
        }
      }
      if (cochanges.length > 0) {
        lines.push(
          `Files often edited together with this one (by lift) — git history, NOT call dependencies (${cochanges.length}):`,
        );
        for (const p of cochanges) {
          lines.push(
            `  ⇌ ${p.file} [lift=${p.lift.toFixed(2)}, co-commits=${p.cocommitCount}, last=${p.lastCocommitAt}]`,
          );
        }
      }
      if (result.hint) lines.push(`Hint: ${result.hint}`);

      const next: string[] = [];
      const d1 = byDepthMap[1]?.length ?? 0;
      if (d1 > 0) {
        next.push("review d=1 nodes first — they will definitely break");
        next.push("call `context` on each d=1 node to craft targeted tests");
      } else {
        next.push("no direct dependents — this change looks safe");
      }
      if (
        confidenceBreakdown.heuristic + confidenceBreakdown.unknown >
        confidenceBreakdown.confirmed
      ) {
        next.push(
          "blast radius rests mostly on unconfirmed edges — treat the risk band as a lower bound and probe heuristic callers manually",
        );
      }

      return withNextSteps(
        lines.join("\n"),
        {
          target: chosen
            ? { id: chosen.id, name: chosen.name, kind: chosen.kind, filePath: chosen.filePath }
            : null,
          direction,
          risk: result.risk,
          impactedCount,
          byDepth: byDepthMap,
          affected_processes: affectedProcesses,
          affected_modules: affectedModules,
          confidenceBreakdown,
          traversedEdges: result.traversedEdges,
          cochanges,
          ambiguous: false,
        },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerImpactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "impact",
    {
      title: "Change-impact blast radius",
      description:
        "Walk the graph from a target symbol and group dependents by traversal depth. Depth-1 nodes will definitely break if the target's contract changes; depth-2 very likely; depth-3+ transitive. Returns a risk band (LOW/MEDIUM/HIGH/CRITICAL) derived from impactedCount + process count, plus `byDepth` groups, `affected_processes`, `affected_modules`, and a `confidenceBreakdown` (confirmed / heuristic / unknown) tallying the provenance tier of every edge traversed — low-risk verdicts are only trustworthy when `heuristic` and `unknown` are small relative to `confirmed`. Ambiguous names return an INVALID_INPUT error with a candidate list so the caller can re-invoke with `target_uid`, `file_path`, or `kind`. A side-section `cochanges` field lists files historically co-edited with the target's enclosing file, ranked by lift. These come from git history, not the call graph, and MUST NOT be mixed into the impactedNodes list.",
      inputSchema: ImpactInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runImpact(ctx, args)),
  );
}

/**
 * Re-shape the analysis-layer `byDepth` array into the `{1: [...], 2: [...]}`
 * map the MCP contract exposes. The array form is kept for text rendering;
 * the map form is what agents consume programmatically.
 */
function buildByDepthMap(
  buckets: readonly ImpactDepthBucket[],
): Record<number, readonly ImpactDepthBucket["nodes"][number][]> {
  const out: Record<number, ImpactDepthBucket["nodes"][number][]> = {};
  for (const b of buckets) {
    out[b.depth] = [...b.nodes];
  }
  return out;
}

function mapProcesses(
  procs: readonly AffectedProcess[],
): readonly { readonly id: string; readonly label: string; readonly entryPointFile: string }[] {
  return procs.map((p) => ({ id: p.id, label: p.name, entryPointFile: p.entryPointFile }));
}

function mapModules(mods: readonly AffectedModule[]): readonly {
  readonly name: string;
  readonly hits: number;
  readonly impact: "direct" | "indirect";
}[] {
  return mods.map((m) => ({ name: m.name, hits: m.hits, impact: m.impact }));
}

/**
 * Side-channel lookup for the `cochanges` section of the impact response.
 * Cochange is a git-history signal and must not be mixed into the call-graph
 * blast radius — we fetch it independently and surface it as its own field.
 */
async function fetchCochangesForFile(
  store: IGraphStore,
  file: string,
): Promise<readonly ImpactCochangePartner[]> {
  if (file.length === 0) return [];
  const rows = await store.lookupCochangesForFile(file, { limit: 10 });
  const out: ImpactCochangePartner[] = [];
  for (const r of rows) {
    const partner = r.sourceFile === file ? r.targetFile : r.sourceFile;
    out.push({
      file: partner,
      cocommitCount: r.cocommitCount,
      lift: r.lift,
      lastCocommitAt: r.lastCocommitAt,
    });
  }
  return out;
}
